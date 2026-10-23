import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transform, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Response } from 'express';
import type { ArchiveProcess, Runtime } from './runtime.ts';
import type { Room } from './store.ts';
import { RoomOperationError } from './rooms.ts';
import type { Logger } from './log.ts';

async function saveArchive(child: ArchiveProcess, output: Writable, signal: AbortSignal, budget: { bytes: number }, cleanupFailed?: (error: unknown) => void) {
  let stderr = '';
  child.stderr?.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-4096); });
  const closed = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => code === 0 ? resolve() : reject(Object.assign(
      new Error('Archive process failed'), { code, signal, stderr },
    )));
  });
  let forceStop: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    // stdout may already be closed, so cancellation must not depend on pipeline rejecting.
    forceStop ??= setTimeout(() => child.kill('SIGKILL'), 2000);
    forceStop.unref();
  };
  signal.addEventListener('abort', stop, { once: true });
  if (signal.aborted) stop();
  const meter = new Transform({ transform(chunk, _encoding, callback) {
    budget.bytes += chunk.length;
    callback(budget.bytes > 512 * 1024 * 1024 ? new Error('Archive exceeds size limit') : null, chunk);
  } });
  try {
    await Promise.all([closed, pipeline(child.stdout!, meter, output, { signal })]);
  } catch (error) {
    stop();
    await closed.catch(() => {});
    throw error;
  } finally {
    signal.removeEventListener('abort', stop); clearTimeout(forceStop);
    // Killing a Docker CLI does not guarantee its daemon-owned container stopped.
    try { await child.cleanup?.(); }
    catch (error) { cleanupFailed?.(error); throw error; }
  }
}

type ArchiveLease = { rooms: Room[]; release(): void };
interface ArchiveJob {
  id: string;
  lease: ArchiveLease;
  controller: AbortController;
  phase: 'preparing' | 'ready' | 'streaming';
  cancelled: boolean;
  startedAt: number;
  directory?: string;
  file?: string;
  size?: number;
  response?: Response;
  timer?: ReturnType<typeof setTimeout>;
  cleaning?: Promise<void>;
  done: Promise<void>;
  finish(): void;
}

// Capacity covers preparation, ready files and transfers so neither temporary
// disk usage nor workers can grow independently of the process-wide limit.
export class Archives {
  private jobs = new Set<ArchiveJob>();
  private downloads = new Map<string, ArchiveJob>();
  private closing = false;
  constructor(private runtime: Runtime, private log: Logger, private limit = 2, private readyTimeoutMs = 60_000) {
    if (!Number.isInteger(limit) || limit < 1 || !Number.isFinite(readyTimeoutMs) || readyTimeoutMs <= 0) throw new Error('Invalid archive limits');
  }
  private reserve(lease: () => ArchiveLease): ArchiveJob {
    if (this.closing) throw new RoomOperationError(503, '服务正在关闭，请稍后重试。');
    if (this.jobs.size >= this.limit) throw new RoomOperationError(429, '导出任务已达上限，请稍后重试。');
    const reservation = lease();
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    const job: ArchiveJob = {
      id: randomUUID(), lease: reservation, controller: new AbortController(),
      phase: 'preparing', cancelled: false, startedAt: Date.now(), done, finish,
    };
    this.jobs.add(job);
    return job;
  }
  private deadline(job: ArchiveJob, milliseconds: number): void {
    clearTimeout(job.timer);
    job.timer = setTimeout(() => job.controller.abort(new Error('Archive timed out')), milliseconds);
    job.timer.unref();
  }
  private watch(job: ArchiveJob, res: Response): () => void {
    job.response = res;
    const cancel = () => {
      if (res.writableFinished) return;
      job.cancelled = true; job.controller.abort(new Error('Client disconnected'));
    };
    res.once('close', cancel);
    if (res.destroyed) cancel();
    return () => res.off('close', cancel);
  }
  private async prepare(job: ArchiveJob, bundle: boolean): Promise<void> {
    const { signal } = job.controller;
    signal.throwIfAborted();
    const directory = job.directory = await mkdtemp(join(tmpdir(), 'codingbox-export-'));
    const files: string[] = [];
    const budget = { bytes: 0 };
    for (const room of job.lease.rooms) {
      signal.throwIfAborted();
      const name = `codingbox-${room.code}.tar.gz`;
      files.push(name);
      await saveArchive(this.runtime.archive(room), createWriteStream(join(directory, name), { mode: 0o600 }), signal, budget,
        error => this.log({ operation: 'archive.worker.cleanup', startedAt: job.startedAt, roomId: room.id, error }));
    }
    let file = files[0];
    if (bundle) {
      await writeFile(join(directory, 'manifest.json'), JSON.stringify({ rooms: job.lease.rooms.map(room => ({
        id: room.id, code: room.code, title: room.title, createdAt: room.createdAt, endedAt: room.endedAt,
      })) }, null, 2), { mode: 0o600 });
      files.push('manifest.json');
      file = 'codingbox-interviews.tar.gz';
      await saveArchive(spawn('tar', ['-C', directory, '-czf', '-', ...files], { stdio: ['ignore', 'pipe', 'pipe'] }),
        createWriteStream(join(directory, file), { mode: 0o600 }), signal, budget);
    }
    signal.throwIfAborted();
    job.file = file;
    job.size = (await stat(join(directory, file))).size;
  }
  private async stream(job: ArchiveJob, res: Response): Promise<void> {
    job.phase = 'streaming';
    job.controller.signal.throwIfAborted();
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', `attachment; filename="${job.file}"`);
    res.setHeader('Content-Length', job.size!);
    // The staged file no longer reads the room volume. Release on HTTP finish,
    // before a client can receive all bytes and immediately request deletion.
    res.once('finish', job.lease.release);
    try { await pipeline(createReadStream(join(job.directory!, job.file!)), res, { signal: job.controller.signal }); }
    finally { res.off('finish', job.lease.release); }
  }
  private failed(job: ArchiveJob, res: Response, error: unknown): void {
    this.log({ operation: 'archive.export', startedAt: job.startedAt, roomIds: job.lease.rooms.map(room => room.id),
      error: job.controller.signal.aborted ? job.controller.signal.reason : error, outcome: job.cancelled ? 'cancelled' : 'failed' });
    if (!res.destroyed) {
      if (res.headersSent) res.destroy();
      else {
        res.removeHeader('Content-Disposition'); res.removeHeader('Content-Length');
        res.status(502).json({ error: '导出失败或超过大小/时间限制，请减少选择后重试。' });
      }
    }
  }
  private dispose(job: ArchiveJob): Promise<void> {
    if (job.cleaning) return job.cleaning;
    clearTimeout(job.timer);
    this.downloads.delete(job.id);
    job.cleaning = (async () => {
      job.lease.release();
      try { if (job.directory) await rm(job.directory, { recursive: true, force: true, maxRetries: 2 }); }
      catch (error) { this.log({ operation: 'archive.cleanup', startedAt: job.startedAt, roomIds: job.lease.rooms.map(room => room.id), error }); }
      finally { this.jobs.delete(job); job.finish(); }
    })();
    return job.cleaning;
  }
  // Prepare before sending headers: a failed child must not resemble a valid export.
  async send(lease: () => ArchiveLease, res: Response, bundle: boolean, prepareDownload = false): Promise<void> {
    const job = this.reserve(lease);
    const unwatch = this.watch(job, res);
    this.deadline(job, bundle ? 180_000 : 60_000);
    try {
      await this.prepare(job, bundle);
      job.controller.signal.throwIfAborted();
      if (prepareDownload) {
        job.phase = 'ready';
        clearTimeout(job.timer);
        this.downloads.set(job.id, job);
        job.timer = setTimeout(() => { void this.dispose(job); }, this.readyTimeoutMs);
        job.timer.unref();
        unwatch();
        res.json({ url: `/api/archives/${job.id}` });
      } else await this.stream(job, res);
    } catch (error) { this.failed(job, res, error); }
    finally { unwatch(); if (job.phase !== 'ready') await this.dispose(job); }
  }
  async download(id: string, res: Response): Promise<void> {
    const job = this.downloads.get(id);
    if (!job) throw new RoomOperationError(410, '下载链接已失效，请重新导出。');
    this.downloads.delete(id); // A single consumer owns this prepared file.
    this.deadline(job, 60_000);
    const unwatch = this.watch(job, res);
    try { await this.stream(job, res); }
    catch (error) { this.failed(job, res, error); }
    finally { unwatch(); await this.dispose(job); }
  }
  async close(): Promise<void> {
    this.closing = true;
    const jobs = [...this.jobs];
    for (const job of jobs) {
      if (job.phase === 'streaming' && job.response?.writableFinished) continue;
      job.cancelled = true;
      job.controller.abort(new Error('Service shutting down'));
      if (job.phase === 'ready') void this.dispose(job);
    }
    await Promise.all(jobs.map(job => job.done));
  }
}
