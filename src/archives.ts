import { spawn, type ChildProcess } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transform, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Response } from 'express';
import type { Runtime } from './runtime.ts';
import type { Room } from './store.ts';

async function saveArchive(child: ChildProcess, output: Writable, signal: AbortSignal, budget: { bytes: number }) {
  const closed = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error('Archive process failed')));
  });
  child.stderr?.resume();
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
  } finally { signal.removeEventListener('abort', stop); clearTimeout(forceStop); }
}

// Prepare before sending headers: a failed child must never look like a valid export.
export async function sendArchives(runtime: Runtime, lease: { rooms: Room[]; release(): void }, res: Response, bundle: boolean) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  res.once('close', cancel);
  const deadline = setTimeout(cancel, bundle ? 180_000 : 60_000);
  deadline.unref();
  let directory: string | undefined;
  try {
    directory = await mkdtemp(join(tmpdir(), 'codingbox-export-'));
    const files: string[] = [];
    const budget = { bytes: 0 };
    for (const room of lease.rooms) {
      controller.signal.throwIfAborted();
      const name = `codingbox-${room.code}.tar.gz`;
      files.push(name);
      await saveArchive(runtime.archive(room), createWriteStream(join(directory, name), { mode: 0o600 }), controller.signal, budget);
    }
    let file = files[0];
    if (bundle) {
      await writeFile(join(directory, 'manifest.json'), JSON.stringify({ rooms: lease.rooms.map(room => ({
        id: room.id, code: room.code, title: room.title, createdAt: room.createdAt, endedAt: room.endedAt,
      })) }, null, 2), { mode: 0o600 });
      files.push('manifest.json');
      file = 'codingbox-interviews.tar.gz';
      await saveArchive(spawn('tar', ['-C', directory, '-czf', '-', ...files], { stdio: ['ignore', 'pipe', 'pipe'] }),
        createWriteStream(join(directory, file), { mode: 0o600 }), controller.signal, budget);
    }
    controller.signal.throwIfAborted();
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', `attachment; filename="${file}"`);
    await pipeline(createReadStream(join(directory, file)), res, { signal: controller.signal });
  } catch {
    if (!res.destroyed) {
      if (res.headersSent) res.destroy();
      else res.status(502).json({ error: '导出失败或超过大小/时间限制，请减少选择后重试。' });
    }
  } finally {
    clearTimeout(deadline);
    res.off('close', cancel);
    lease.release();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}
