import { Store, type Room } from './store.ts';
import { type Runtime, waitForEditor, wedeRequest } from './runtime.ts';
import { createLogger, type Logger } from './log.ts';

export class RoomOperationError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export class Rooms {
  private starts = new Map<string, Promise<void>>();
  private endings = new Map<string, Promise<void>>();
  private inspections = new Map<string, Promise<number | null>>();
  private sweeping?: Promise<void>;
  private deleting = new Map<string, Promise<void>>();
  private archiveReaders = new Map<string, number>();
  onEnd: (id: string) => void = () => {};
  onReady: (room: Room & { port: number }) => Promise<void> = async () => {};
  constructor(readonly store: Store, readonly runtime: Runtime, private log: Logger = createLogger()) {}

  provision(room: Room): void {
    const task = this.start(room).finally(() => this.starts.delete(room.id));
    this.starts.set(room.id, task);
  }
  private async start(room: Room): Promise<void> {
    const startedAt = Date.now();
    try {
      const port = await this.runtime.start(room);
      await waitForEditor(port);
      this.store.update(room.id, { port });
      await this.onReady({ ...room, port });
      this.store.update(room.id, { status: 'active', port, error: null });
    } catch (error) {
      this.log({ operation: 'room.start', startedAt, roomId: room.id, error });
      this.onEnd(room.id);
      let message = '实例启动失败，请检查运行环境和编辑器安装。';
      const cleanupStarted = Date.now();
      try { await this.runtime.stop(room); }
      catch (error) {
        this.log({ operation: 'room.start.cleanup', startedAt: cleanupStarted, roomId: room.id, error });
        message += ' 容器清理失败，请点击结束重试。';
      }
      this.store.update(room.id, { status: 'error', port: null, error: message });
    }
  }
  async end(room: Room): Promise<void> {
    const existing = this.endings.get(room.id);
    if (existing) return existing;
    this.store.revokeRoom(room.id);
    this.onEnd(room.id);
    const task = this.finish(room).finally(() => this.endings.delete(room.id));
    this.endings.set(room.id, task);
    return task;
  }
  private completedRoom(id: string): Room {
    const room = this.store.room(id);
    if (!room) throw new RoomOperationError(404, '面试记录不存在。');
    if (room.status !== 'ended') throw new RoomOperationError(409, '请先结束面试。');
    return room;
  }
  leaseArchives(ids: string[]) {
    const rooms = ids.map(id => {
      const room = this.completedRoom(id);
      if (this.deleting.has(id)) throw new RoomOperationError(409, '记录正在删除，请稍后重试。');
      return room;
    });
    for (const room of rooms) this.archiveReaders.set(room.id, (this.archiveReaders.get(room.id) ?? 0) + 1);
    let released = false;
    return { rooms, release: () => {
      if (released) return;
      released = true;
      for (const room of rooms) {
        const count = (this.archiveReaders.get(room.id) ?? 1) - 1;
        if (count) this.archiveReaders.set(room.id, count); else this.archiveReaders.delete(room.id);
      }
    } };
  }
  async remove(id: string): Promise<void> {
    const existing = this.deleting.get(id);
    if (existing) return existing;
    const room = this.completedRoom(id);
    if (this.archiveReaders.has(id)) throw new RoomOperationError(409, '代码正在下载，请下载完成后再删除。');
    const startedAt = Date.now();
    const task = this.runtime.remove(room).then(() => this.store.deleteEndedRoom(id)).catch(error => {
      this.log({ operation: 'room.delete', startedAt, roomId: id, error });
      throw new RoomOperationError(502, '删除失败，记录已保留，请重试。');
    }).finally(() => this.deleting.delete(id));
    this.deleting.set(id, task);
    return task;
  }
  private async finish(room: Room): Promise<void> {
    // Wait for an in-flight create so it cannot resurrect an ended room.
    await this.starts.get(room.id);
    // Native running checks may launch an editor; end must stop that process too.
    await this.inspections.get(room.id)?.catch(() => {});
    if (this.store.room(room.id)?.status === 'ended') return;
    this.store.update(room.id, { status: 'ending' });
    const startedAt = Date.now();
    try {
      await this.runtime.stop(room);
      this.store.update(room.id, { status: 'ended', endedAt: Date.now(), port: null, error: null });
    } catch (error) {
      this.log({ operation: 'room.end', startedAt, roomId: room.id, error });
      this.store.update(room.id, { status: 'error', error: '容器停止失败，访问已撤销。请点击结束重试。', port: null });
      throw new RoomOperationError(502, '容器停止失败，请重试');
    }
  }
  active(room: Room | undefined): room is Room & { port: number } {
    return !!room && !this.endings.has(room.id) && room.status === 'active' && room.port !== null && room.expiresAt > Date.now();
  }
  // All request/reconciliation paths go through this owner because native
  // running() can restart a retained editor. No new restart may begin after end.
  async running(room: Room): Promise<number | null> {
    const current = this.store.room(room.id);
    if (!current || this.endings.has(room.id) || current.expiresAt <= Date.now()
      || !['active', 'recovering'].includes(current.status)) return null;
    let task = this.inspections.get(room.id);
    if (!task) {
      task = this.runtime.running(current).finally(() => this.inspections.delete(room.id));
      this.inspections.set(room.id, task);
    }
    const port = await task;
    return this.endings.has(room.id) || current.expiresAt <= Date.now() ? null : port;
  }
  async editorSession(room: Room & { port: number }, name: string): Promise<string> {
    try { return await this.mintEditorSession(room, name); }
    catch {
      // A native editor can disappear while its portal and retained files survive.
      const port = await this.running(room);
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
      if ((room.status === 'active' || room.status === 'recovering') && room.expiresAt > Date.now()) {
        await this.recover(room);
      } else {
        try { await this.end(room); } catch { /* end recorded the failure; recover the next room */ }
      }
    }
  }
  private recover(room: Room): Promise<void> {
    const existing = this.starts.get(room.id) ?? this.endings.get(room.id);
    if (existing) return existing;
    this.store.update(room.id, { status: 'recovering', port: null });
    const task = this.restore(room).finally(() => this.starts.delete(room.id));
    this.starts.set(room.id, task);
    return task;
  }
  private async restore(room: Room): Promise<void> {
    const startedAt = Date.now();
    try {
      const port = await this.running(room);
      if (!port) throw new Error('Editor is not running');
      await waitForEditor(port);
      await this.onReady({ ...room, port });
      if (!this.endings.has(room.id)) this.store.update(room.id, { status: 'active', port, error: null });
    } catch (error) {
      if (this.endings.has(room.id)) return;
      this.log({ operation: 'room.recover', startedAt, roomId: room.id, error });
      this.onEnd(room.id);
      this.store.update(room.id, { status: 'recovering', port: null, error: '编程空间恢复失败，正在重试；也可以结束后重新创建。' });
    }
  }
  sweep(): Promise<void> {
    if (this.sweeping) return this.sweeping;
    const task = this.sweepRooms().finally(() => { this.sweeping = undefined; });
    this.sweeping = task;
    return task;
  }
  private async sweepRooms(): Promise<void> {
    this.store.prune();
    for (const room of this.store.rooms()) {
      if ((room.status === 'active' || room.status === 'recovering' || room.status === 'starting' || room.status === 'ending') && room.expiresAt <= Date.now()) {
        try { await this.end(room); } catch { /* visible error; interviewer may retry */ }
      } else if (room.status === 'recovering') {
        await this.recover(room);
      }
    }
  }
  // A sweep may start the next recovery after the current task settles.
  async settle(): Promise<void> { await Promise.allSettled([this.sweeping, ...this.starts.values(), ...this.endings.values(), ...this.inspections.values(), ...this.deleting.values()]); }
}
