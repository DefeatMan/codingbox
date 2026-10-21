import { Store, type Room } from './store.ts';
import { type Runtime, waitForEditor, wedeRequest } from './runtime.ts';

export class Rooms {
  private starts = new Map<string, Promise<void>>();
  private endings = new Map<string, Promise<void>>();
  onEnd: (id: string) => void = () => {};
  onReady: (room: Room & { port: number }) => Promise<void> = async () => {};
  constructor(readonly store: Store, readonly runtime: Runtime) {}

  provision(room: Room): void {
    const task = this.start(room).finally(() => this.starts.delete(room.id));
    this.starts.set(room.id, task);
  }
  private async start(room: Room): Promise<void> {
    try {
      const port = await this.runtime.start(room);
      await waitForEditor(port);
      this.store.update(room.id, { port });
      await this.onReady({ ...room, port });
      this.store.update(room.id, { status: 'active', port, error: null });
    } catch {
      this.onEnd(room.id);
      let message = '实例启动失败，请检查运行环境和编辑器安装。';
      try { await this.runtime.stop(room); }
      catch { message += ' 容器清理失败，请点击结束重试。'; }
      this.store.update(room.id, { status: 'error', port: null, error: message });
    }
  }
  async end(room: Room): Promise<void> {
    const existing = this.endings.get(room.id);
    if (existing) return existing;
    const task = this.finish(room).finally(() => this.endings.delete(room.id));
    this.endings.set(room.id, task);
    return task;
  }
  private async finish(room: Room): Promise<void> {
    // Wait for an in-flight create so it cannot resurrect an ended room.
    await this.starts.get(room.id);
    if (this.store.room(room.id)?.status === 'ended') return;
    this.store.update(room.id, { status: 'ending' });
    this.store.revokeRoom(room.id);
    this.onEnd(room.id);
    try {
      await this.runtime.stop(room);
      this.store.update(room.id, { status: 'ended', endedAt: Date.now(), port: null, error: null });
    } catch {
      this.store.update(room.id, { status: 'error', error: '容器停止失败，访问已撤销。请点击结束重试。', port: null });
      throw new Error('容器停止失败，请重试');
    }
  }
  active(room: Room | undefined): room is Room & { port: number } {
    return !!room && room.status === 'active' && room.port !== null && room.expiresAt > Date.now();
  }
  async editorSession(room: Room & { port: number }, name: string): Promise<string> {
    try { return await this.mintEditorSession(room, name); }
    catch {
      // A native editor can disappear while its portal and retained files survive.
      const port = await this.runtime.running(room);
      if (port !== room.port) throw new Error('Editor unavailable');
      return await this.mintEditorSession(room, name);
    }
  }
  private async mintEditorSession(room: Room & { port: number }, name: string): Promise<string> {
    const owner = await wedeRequest<{ token: string }>(room.port, '/api/auth/login', { password: room.password, username: 'Codingbox' });
    const invite = await wedeRequest<{ raw: string }>(room.port, '/api/auth/tokens', {
      role: 'editor', username: name, ttlHours: 1 / 60,
    }, owner.token);
    const editor = await wedeRequest<{ token: string }>(room.port, '/api/auth/redeem', { token: invite.raw });
    return editor.token;
  }
  async reconcile(): Promise<void> {
    for (const room of this.store.rooms()) {
      if (room.status === 'ended') continue;
      if (room.status === 'active' && room.expiresAt > Date.now()) {
        const port = await this.runtime.running(room);
        if (port) {
          try {
            await waitForEditor(port);
            this.store.update(room.id, { port });
            await this.onReady({ ...room, port });
            continue;
          } catch { /* stop broken instance below */ }
        }
      }
      await this.end(room);
    }
  }
  async sweep(): Promise<void> {
    this.store.prune();
    for (const room of this.store.rooms()) {
      if ((room.status === 'active' || room.status === 'starting' || room.status === 'ending') && room.expiresAt <= Date.now()) {
        try { await this.end(room); } catch { /* visible error; interviewer may retry */ }
      }
    }
  }
  async settle(): Promise<void> { await Promise.all([...this.starts.values(), ...this.endings.values()]); }
}
