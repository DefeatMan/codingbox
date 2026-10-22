import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const secret = () => randomBytes(32).toString('base64url');
export type RoomStatus = 'starting' | 'active' | 'ending' | 'ended' | 'error';
export interface Room {
  id: string; code: string; title: string; language: string; status: RoomStatus;
  createdAt: number; expiresAt: number; endedAt: number | null;
  container: string; volume: string; port: number | null; password: string; error: string | null;
}
export interface Session {
  kind: 'admin' | 'handoff' | 'room'; roomId: string | null; name: string;
  expiresAt: number; wedeToken: string | null;
}

export class Store {
  private db: DatabaseSync;
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, 'codingbox.sqlite');
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS rooms (
        id TEXT PRIMARY KEY, code TEXT UNIQUE NOT NULL, title TEXT NOT NULL,
        language TEXT NOT NULL, status TEXT NOT NULL, createdAt INTEGER NOT NULL,
        expiresAt INTEGER NOT NULL, endedAt INTEGER, container TEXT NOT NULL,
        volume TEXT NOT NULL, port INTEGER, password TEXT NOT NULL, error TEXT
      );
      CREATE TABLE IF NOT EXISTS sessions (
        hash TEXT PRIMARY KEY, kind TEXT NOT NULL, roomId TEXT, name TEXT NOT NULL,
        expiresAt INTEGER NOT NULL, wedeToken TEXT
      );
      CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expiresAt);
      CREATE INDEX IF NOT EXISTS rooms_history ON rooms(status, COALESCE(endedAt, createdAt) DESC, id DESC);
    `);
  }
  createRoom(title: string, language: string, minutes: number): Room {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code: string;
    do { code = Array.from(randomBytes(8), b => alphabet[b % alphabet.length]).join(''); }
    while (this.byCode(code));
    const id = randomUUID();
    const room: Room = {
      id, code, title, language, status: 'starting', createdAt: Date.now(),
      expiresAt: Date.now() + minutes * 60_000, endedAt: null,
      container: `codingbox-${id}`, volume: `codingbox-${id}`, port: null,
      password: secret(), error: null,
    };
    this.db.prepare('INSERT INTO rooms VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      room.id, room.code, room.title, room.language, room.status, room.createdAt,
      room.expiresAt, room.endedAt, room.container, room.volume, room.port, room.password, room.error,
    );
    return room;
  }
  rooms(): Room[] { return this.db.prepare('SELECT * FROM rooms ORDER BY createdAt DESC').all() as unknown as Room[]; }
  roomCounts(): { ongoing: number; completed: number } {
    const row = this.db.prepare("SELECT COUNT(*) AS total, COUNT(CASE WHEN status = 'ended' THEN 1 END) AS completed FROM rooms").get() as { total: number; completed: number };
    return { ongoing: row.total - row.completed, completed: row.completed };
  }
  roomPage(tab: 'ongoing' | 'completed', query: string, requestedPage: number, pageSize: number) {
    const where = `status ${tab === 'completed' ? '=' : '!='} 'ended' AND (instr(lower(title), lower(?)) > 0 OR instr(code, NULLIF(?, '')) > 0)`;
    const params = [query, query.replaceAll('-', '').toUpperCase()];
    const { total } = this.db.prepare(`SELECT COUNT(*) AS total FROM rooms WHERE ${where}`).get(...params) as { total: number };
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(requestedPage, pages);
    const rooms = this.db.prepare(`SELECT * FROM rooms WHERE ${where} ORDER BY COALESCE(endedAt, createdAt) DESC, id DESC LIMIT ? OFFSET ?`)
      .all(...params, pageSize, (page - 1) * pageSize) as unknown as Room[];
    return { rooms, total, page, pageSize, pages, counts: this.roomCounts() };
  }
  deleteEndedRoom(id: string): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.db.prepare("DELETE FROM rooms WHERE id = ? AND status = 'ended'").run(id);
      if (result.changes !== 1) throw new Error('Completed room is no longer available');
      this.revokeRoom(id);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  room(id: string): Room | undefined { return this.db.prepare('SELECT * FROM rooms WHERE id = ?').get(id) as unknown as Room | undefined; }
  byCode(code: string): Room | undefined { return this.db.prepare('SELECT * FROM rooms WHERE code = ?').get(code.replaceAll('-', '').toUpperCase()) as unknown as Room | undefined; }
  update(id: string, changes: Partial<Pick<Room, 'status' | 'port' | 'endedAt' | 'error'>>): void {
    const entries = Object.entries(changes);
    if (entries.length) this.db.prepare(`UPDATE rooms SET ${entries.map(([key]) => `${key} = ?`).join(', ')} WHERE id = ?`)
      .run(...entries.map(([, value]) => value!), id);
  }
  session(input: Session): string {
    const token = secret();
    this.db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)').run(
      hash(token), input.kind, input.roomId, input.name, input.expiresAt, input.wedeToken,
    );
    return token;
  }
  getSession(token: string | undefined, kind: Session['kind']): Session | undefined {
    if (!token) return;
    return this.db.prepare('SELECT kind, roomId, name, expiresAt, wedeToken FROM sessions WHERE hash = ? AND kind = ? AND expiresAt > ?')
      .get(hash(token), kind, Date.now()) as unknown as Session | undefined;
  }
  deleteSession(token: string): void { this.db.prepare('DELETE FROM sessions WHERE hash = ?').run(hash(token)); }
  revokeRoom(id: string): void { this.db.prepare('DELETE FROM sessions WHERE roomId = ?').run(id); }
  prune(): void { this.db.prepare('DELETE FROM sessions WHERE expiresAt <= ?').run(Date.now()); }
  close(): void { this.db.close(); }
}
