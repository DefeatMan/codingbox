import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Room } from './store.ts';

const exec = promisify(execFile);
export type ArchiveProcess = ReturnType<typeof spawn> & { cleanup?(): Promise<void> };
export interface Runtime {
  start(room: Room): Promise<number>;
  stop(room: Room): Promise<void>;
  running(room: Room): Promise<number | null>;
  archive(room: Room): ArchiveProcess;
  remove(room: Room): Promise<void>;
}

export class DockerRuntime implements Runtime {
  constructor(private image: string, private memory = '1g', private cpus = '1') {}
  async start(room: Room): Promise<number> {
    await exec('docker', ['run', '-d', '--name', room.container,
      '--label', 'ai.boxlite.codingbox=true', '--init', '--restart', 'unless-stopped',
      '--memory', this.memory, '--cpus', this.cpus, '--pids-limit', '256',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '-p', '127.0.0.1::9090', '-v', `${room.volume}:/home/coder`,
      '-e', `WEDE_PASSWORD=${room.password}`, '-e', `CODINGBOX_LANGUAGE=${room.language}`,
      this.image], { timeout: 60_000 });
    const port = await this.running(room);
    if (!port) throw new Error('Container did not expose an editor port');
    return port;
  }
  async running(room: Room): Promise<number | null> {
    try {
      const { stdout } = await exec('docker', ['inspect', '--format', '{{json .}}', room.container], { timeout: 10_000 });
      const state = JSON.parse(stdout);
      return state.State.Running ? Number(state.NetworkSettings.Ports['9090/tcp'][0].HostPort) : null;
    } catch (error) {
      if (String((error as { stderr?: string }).stderr).includes('No such')) return null;
      throw error;
    }
  }
  async stop(room: Room): Promise<void> {
    try { await exec('docker', ['rm', '-f', room.container], { timeout: 30_000 }); }
    catch (error) {
      if (!String((error as { stderr?: string }).stderr).includes('No such')) throw error;
    }
  }
  archive(room: Room): ArchiveProcess {
    const name = `codingbox-export-${randomUUID()}`;
    const child: ArchiveProcess = spawn('docker', ['run', '--rm', '--init', '--name', name, '--network', 'none', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges', '--memory', '256m', '--pids-limit', '32',
      '-v', `${room.volume}:/archive:ro`, '--entrypoint', 'tar', this.image,
      '-C', '/archive/project', '-czf', '-', '.'], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.cleanup = async () => {
      const deadline = Date.now() + 30_000;
      for (;;) {
        try { await exec('docker', ['rm', '-f', name], { timeout: Math.max(1, deadline - Date.now()) }); return; }
        catch (error) {
          const stderr = String((error as { stderr?: string }).stderr);
          if (stderr.includes('No such')) return;
          // --rm and explicit cancellation can race inside the Docker daemon.
          // Keep the lease until that existing removal has actually finished.
          if (!/removal .*already in progress/i.test(stderr) || Date.now() >= deadline) throw error;
          await delay(100);
        }
      }
    };
    return child;
  }
  async remove(room: Room): Promise<void> {
    await this.stop(room);
    try { await exec('docker', ['volume', 'rm', room.volume], { timeout: 30_000 }); }
    catch (error) {
      if (!/no such volume/i.test(String((error as { stderr?: string }).stderr))) throw error;
    }
  }
}

export async function wedeRequest<T>(port: number, path: string, body?: unknown, token?: string): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: token } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`Editor request failed (${response.status})`);
  return await response.json() as T;
}

export async function waitForEditor(port: number): Promise<void> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return;
    } catch { /* container is booting */ }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('Editor startup timed out');
}
