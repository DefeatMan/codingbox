import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, open, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import type { Runtime } from './runtime.ts';
import type { Room } from './store.ts';
import { waitForEditor } from './runtime.ts';

const exec = promisify(execFile);
const userFor = (room: Room) => `cb${room.id.replaceAll('-', '').slice(0, 14)}`;

// Optional Linux/BoxLite preview runtime. Unix users isolate file permissions;
// resource limits belong to the outer Box. Docker remains the default runtime.
export class NativeRuntime implements Runtime {
  private reserved = new Set<number>();
  private recovering = new Map<string, Promise<number | null>>();
  constructor(private binary: string, private templates: string, private data: string, private homeRoot = '/srv/codingbox-rooms') {
    this.binary = resolve(binary); this.templates = resolve(templates); this.data = resolve(data);
    if (process.platform !== 'linux') throw new Error('Native runtime requires Linux and passwordless sudo');
  }
  private async sudo(...args: string[]): Promise<void> { await exec('sudo', ['-n', ...args], { timeout: 15_000 }); }
  private async port(): Promise<number> {
    for (let port = 9000; port < 10000; port++) {
      if (this.reserved.has(port)) continue;
      this.reserved.add(port);
      const free = await new Promise<boolean>(resolve => {
        const probe = createServer();
        probe.once('error', () => resolve(false));
        probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
      });
      if (free) return port;
      this.reserved.delete(port);
    }
    throw new Error('No native editor port available');
  }
  async start(room: Room): Promise<number> {
    const user = userFor(room); const home = join(this.homeRoot, room.id);
    const state = join(this.data, room.id);
    await mkdir(state, { recursive: true, mode: 0o700 });
    await this.sudo('install', '-d', '-m', '711', this.homeRoot);
    try { await exec('id', ['-u', user]); }
    catch { await this.sudo('useradd', '--system', '--user-group', '--no-create-home', '--home-dir', home, '--shell', '/bin/bash', user); }
    await this.sudo('install', '-d', '-m', '700', '-o', user, '-g', user, home, join(home, 'project'), join(home, '.config'), join(home, '.config/wede'));
    await this.sudo('cp', '-R', `${join(this.templates, room.language)}/.`, join(home, 'project'));
    await this.sudo('chown', '-R', `${user}:${user}`, join(home, 'project'));
    const port = await this.port();
    await writeFile(join(state, 'config.json'), JSON.stringify({ password: room.password, host: '127.0.0.1', port: String(port), workspace_root: home }), { mode: 0o600 });
    await this.sudo('install', '-m', '600', '-o', user, '-g', user, join(state, 'config.json'), join(home, '.config/wede/wede.config.json'));
    await writeFile(join(state, 'profile'), 'export PATH=/opt/rust/bin:/opt/python/bin:/usr/local/go/bin:/usr/local/bin:$PATH\n', { mode: 0o600 });
    await this.sudo('install', '-m', '600', '-o', user, '-g', user, join(state, 'profile'), join(home, '.bash_profile'));
    await writeFile(join(state, 'metadata.json'), JSON.stringify({ port }), { mode: 0o600 });
    await this.launch(room, port);
    return port;
  }
  private async launch(room: Room, port: number): Promise<void> {
    const user = userFor(room); const home = join(this.homeRoot, room.id);
    const state = join(this.data, room.id);
    const log = await open(join(state, 'editor.log'), 'a', 0o600);
    const child = spawn('sudo', ['-n', '-u', user, 'env', `HOME=${home}`,
      'PATH=/opt/rust/bin:/opt/python/bin:/usr/local/go/bin:/usr/local/bin:/usr/bin:/bin',
      'GOTELEMETRY=off', this.binary, '--port', String(port), join(home, 'project')], {
      detached: true, stdio: ['ignore', log.fd, log.fd],
      // Do not inherit the portal password or cloud credentials into room processes.
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8' },
    });
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref(); await log.close();
  }
  async running(room: Room): Promise<number | null> {
    if (room.status !== 'active' && room.status !== 'recovering') return null;
    const existing = this.recovering.get(room.id);
    if (existing) return existing;
    const task = this.recover(room).finally(() => this.recovering.delete(room.id));
    this.recovering.set(room.id, task);
    return task;
  }
  private async recover(room: Room): Promise<number | null> {
    try {
      const { port } = JSON.parse(await readFile(join(this.data, room.id, 'metadata.json'), 'utf8'));
      if (!Number.isInteger(port) || port < 9000 || port >= 10000) return null;
      let alive = false;
      try {
        const { stdout } = await exec('sudo', ['-n', 'ps', '-u', userFor(room), '-o', 'stat=,comm=']);
        alive = /^\s*[^Z\s]\S*\s+wede\s*$/m.test(stdout);
      } catch { /* no live processes */ }
      if (!alive) {
        // Restore only the existing configuration; never seed over interview code.
        await this.sudo('test', '-f', join(this.homeRoot, room.id, '.config/wede/wede.config.json'));
        const free = await new Promise<boolean>(resolve => {
          const probe = createServer(); probe.once('error', () => resolve(false));
          probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
        });
        if (!free) return null;
        await this.launch(room, port);
        await waitForEditor(port);
      }
      this.reserved.add(port);
      return port;
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return null;
      throw error;
    }
  }
  async stop(room: Room): Promise<void> {
    try { await exec('id', ['-u', userFor(room)]); } catch { return; }
    try { await exec('sudo', ['-n', 'pkill', '-KILL', '-u', userFor(room)], { timeout: 15_000 }); }
    catch (error) { if ((error as { code?: number }).code !== 1) throw error; }
    const port = room.port ?? await this.metadataPort(room);
    if (port) this.reserved.delete(port);
    // Retain the user/UID as long as archived files remain, preventing UID reuse.
  }
  private async metadataPort(room: Room): Promise<number | null> {
    try { return JSON.parse(await readFile(join(this.data, room.id, 'metadata.json'), 'utf8')).port; } catch { return null; }
  }
  archive(room: Room): ReturnType<typeof spawn> {
    return spawn('sudo', ['-n', '-u', userFor(room), 'tar', '-C', join(this.homeRoot, room.id, 'project'), '-czf', '-', '.'], { stdio: ['ignore', 'pipe', 'pipe'] });
  }
  async remove(room: Room): Promise<void> {
    await this.stop(room);
    await this.sudo('rm', '-rf', '--', join(this.homeRoot, room.id));
    await rm(join(this.data, room.id), { recursive: true, force: true });
    const user = userFor(room);
    let exists = true;
    try { await exec('id', ['-u', user]); } catch { exists = false; }
    if (exists) await this.sudo('userdel', user);
  }
}
