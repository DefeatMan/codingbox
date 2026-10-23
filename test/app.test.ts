import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request as httpRequest } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import { createApplication, type Config } from '../src/app.ts';
import type { LogRecord } from '../src/log.ts';
import type { Runtime } from '../src/runtime.ts';
import type { Room } from '../src/store.ts';

const origin = 'http://localhost:3000';
const base = (room: Room) => `/rooms/${room.code.toLowerCase()}/`;
async function fixture(options: Partial<Config> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'codingbox-test-'));
  const editorAuth = { token: 'editor-secret', loginFailures: 0 };
  const upstream = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/auth/login') {
      if (editorAuth.loginFailures > 0) { editorAuth.loginFailures--; res.statusCode = 503; return res.end('{}'); }
      return res.end(JSON.stringify({ token: 'owner-secret' }));
    }
    if (req.url === '/api/auth/check') return res.end(JSON.stringify({ authenticated: req.headers.authorization === editorAuth.token, role: 'editor' }));
    if (req.url === '/api/auth/tokens') return res.end(JSON.stringify({ raw: 'invite-secret' }));
    if (req.url === '/api/auth/redeem') return res.end(JSON.stringify({ token: editorAuth.token }));
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => res.end(JSON.stringify({ upstream: true, path: req.url, body: Buffer.concat(chunks).toString(), headers: req.headers })));
  });
  const wsServer = new WebSocketServer({ server: upstream });
  wsServer.on('connection', (socket, req) => {
    socket.send(req.url === '/echo-headers' ? JSON.stringify(req.headers) : req.url!);
    socket.on('message', data => socket.send(data));
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const upstreamPort = (upstream.address() as { port: number }).port;
  const runtime: Runtime & { stopped: string[]; removed: string[]; remove(room: Room): Promise<void>; failRemove: boolean; failStart: boolean; failStop: boolean; recoveryChecks: number } = {
    removed: [], failRemove: false,
    async remove(room) { if (this.failRemove) throw new Error('private storage command'); this.removed.push(room.id); },
    stopped: [], failStart: false, failStop: false, recoveryChecks: 0,
    async start() { if (this.failStart) throw new Error('secret command'); return upstreamPort; },
    async stop(room: Room) { if (this.failStop) throw new Error('stop failed'); this.stopped.push(room.id); },
    async running() { this.recoveryChecks++; return upstreamPort; },
    archive() { return spawn(process.execPath, ['-e', 'process.stdout.write("archive")']); },
  };
  const logs: LogRecord[] = [];
  const application = createApplication({ publicUrl: origin, adminPassword: 'test-admin-password', dataDir: directory, maxRooms: 5,
    logSink: record => logs.push(record), ...options }, runtime);
  application.server.listen(0, '127.0.0.1'); await once(application.server, 'listening');
  const port = (application.server.address() as { port: number }).port;
  const request = (path: string, body?: unknown, options: { method?: string; cookie?: string; origin?: string; authorization?: string; proxyAuthorization?: string; host?: string } = {}) => new Promise<Response>((resolve, reject) => {
    const req = httpRequest(`http://127.0.0.1:${port}${path}`, {
      method: options.method ?? (body === undefined ? 'GET' : 'POST'), headers: { Host: options.host ?? 'localhost:3000',
        ...(options.cookie ? { Cookie: options.cookie } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(options.origin ? { Origin: options.origin } : {}),
        ...(options.authorization ? { Authorization: options.authorization } : {}),
        ...(options.proxyAuthorization ? { 'Proxy-Authorization': options.proxyAuthorization } : {}),
      },
    }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const headers = new Headers();
        for (const [key, value] of Object.entries(res.headers)) if (value) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
        resolve(new Response(new Uint8Array(Buffer.concat(chunks)), { status: res.statusCode, headers }));
      });
      res.on('error', reject);
    });
    req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const login = await request('/api/login', { password: 'test-admin-password' });
  assert.equal(login.status, 200, await login.text());
  const admin = { cookie: login.headers.get('set-cookie')!.split(';')[0] };
  const create = async () => {
    const response = await request('/api/rooms', { title: 'Interview', language: 'python', minutes: 60 }, admin);
    assert.equal(response.status, 202);
    const { room } = await response.json();
    await application.rooms.settle();
    return application.store.room(room.id)!;
  };
  return { ...application, runtime, editorAuth, logs, request, create, admin, port, async dispose() {
    await application.close();
    for (const client of wsServer.clients) client.terminate();
    wsServer.close();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  } };
}

test('admin access and CSRF protection', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.request('/api/rooms')).status, 401);
    assert.equal((await f.request('/api/login', { password: 'wrong' })).status, 401);
    assert.equal((await f.request('/api/rooms', {}, { ...f.admin, origin: 'https://attacker.test' })).status, 403);
    assert.equal((await f.request('/api/rooms', {}, f.admin)).status, 400);
    assert.equal((await f.request('/', undefined, { host: 'unknown.test' })).status, 421);
  } finally { await f.dispose(); }
});

test('room code admits directly through the shared origin without a membership cookie', async () => {
  const f = await fixture();
  try {
    const room = await f.create(); const other = await f.create();
    for (const r of [room, other]) {
      const response = await f.request(`${base(r)}__codingbox/bootstrap?name=Alex`);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).token, f.editorAuth.token);
      assert.equal(response.headers.get('set-cookie'), null);
      assert.equal((await f.request(base(r))).status, 200);
    }
    assert.equal((await f.request(`${base(room)}api/auth/login`, {})).status, 403);
    const listed = await (await f.request('/api/rooms', undefined, f.admin)).text();
    assert.ok(!listed.includes(room.password)); assert.ok(!listed.includes('owner-secret'));
  } finally { await f.dispose(); }
});

test('join returns a same-origin room path and direct aliases redirect canonically', async () => {
  const f = await fixture();
  try {
    const room = await f.create();
    const joined = await f.request('/api/join', { code: room.code, name: '</script>' });
    const target = new URL((await joined.json()).url);
    assert.equal(target.origin, origin); assert.equal(target.pathname, base(room));
    assert.equal(target.searchParams.get('name'), '</script>');
    assert.ok(!target.searchParams.has('ticket'));
    const alias = `/rooms/${room.code.slice(0, 4)}-${room.code.slice(4)}?name=Alex`;
    const redirect = await f.request(alias);
    assert.equal(redirect.status, 308); assert.equal(redirect.headers.get('location'), `${base(room)}?name=Alex`);
    assert.equal((await f.request('/rooms/ZZZZZZZZ/')).status, 404);
    assert.equal((await f.request('/rooms/bad/')).status, 404);
  } finally { await f.dispose(); }
});

test('HTTP proxy strips only the room prefix and preserves query and streamed body', async () => {
  const f = await fixture();
  try {
    const room = await f.create();
    const response = await f.request(`${base(room)}api/workspaces/default/files/write?path=nested%2Fmain.py`, { content: 'print("hello")' });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.path, '/api/workspaces/default/files/write?path=nested%2Fmain.py');
    assert.deepEqual(JSON.parse(result.body), { content: 'print("hello")' });
  } finally { await f.dispose(); }
});

test('HTTP and WebSocket proxies strip portal credentials and preserve editor authentication', async () => {
  const f = await fixture();
  try {
    const room = await f.create();
    const cookie = `${f.admin.cookie}; __Host-codingbox_admin=secure-secret; unrelated=private`;
    const response = await f.request(`${base(room)}echo-headers`, undefined, { cookie, authorization: 'editor-secret', proxyAuthorization: 'Basic proxy-secret' });
    const { headers } = await response.json();
    assert.equal(headers.cookie, undefined); assert.equal(headers['proxy-authorization'], undefined);
    assert.equal(headers.authorization, 'editor-secret');
    const client = new WebSocket(`ws://127.0.0.1:${f.port}${base(room)}echo-headers`, ['auth.editor-secret'], {
      headers: { Host: 'localhost:3000', Cookie: cookie, 'Proxy-Authorization': 'Basic proxy-secret' },
    });
    const [message] = await once(client, 'message');
    const forwarded = JSON.parse(String(message));
    assert.equal(forwarded.cookie, undefined); assert.equal(forwarded['proxy-authorization'], undefined);
    assert.equal(forwarded['sec-websocket-protocol'], 'auth.editor-secret');
    assert.equal(client.protocol, 'auth.editor-secret');
    const closed = once(client, 'close'); client.close(); await closed;
    assert.equal((await f.request('/api/rooms', undefined, f.admin)).status, 200);
  } finally { await f.dispose(); }
});

test('bootstrap refreshes invalid tokens and recovers a disappeared editor', async () => {
  const f = await fixture();
  try {
    const room = await f.create();
    f.editorAuth.loginFailures = 1;
    const bootstrap = await f.request(`${base(room)}__codingbox/bootstrap`, undefined, { authorization: 'stale-token' });
    assert.equal(bootstrap.status, 200); assert.equal((await bootstrap.json()).token, f.editorAuth.token);
    assert.equal(f.runtime.recoveryChecks, 1);
    f.editorAuth.loginFailures = 2;
    const retained = await f.request(`${base(room)}__codingbox/bootstrap`, undefined, { authorization: f.editorAuth.token });
    assert.equal(retained.status, 200); assert.equal((await retained.json()).token, f.editorAuth.token);
    assert.equal(f.editorAuth.loginFailures, 2, 'valid token should not mint another session');
    assert.equal((await f.request(`${base(room)}__codingbox/bootstrap?name=${'x'.repeat(33)}`)).status, 400);
  } finally { await f.dispose(); }
});

test('end revokes HTTP and already-open WebSockets while retaining archive', { timeout: 10_000 }, async () => {
  const f = await fixture();
  try {
    const room = await f.create();
    const client = new WebSocket(`ws://127.0.0.1:${f.port}${base(room)}api/collab?test=1`, { headers: { Host: 'localhost:3000', Origin: origin } });
    const first = once(client, 'message'); await once(client, 'open');
    assert.equal(String((await first)[0]), '/api/collab?test=1');
    const echo = once(client, 'message'); client.send('hello'); assert.equal(String((await echo)[0]), 'hello');
    const closed = once(client, 'close');
    assert.equal((await f.request(`/api/rooms/${room.id}/end`, {}, f.admin)).status, 200);
    await closed;
    assert.equal((await f.request(base(room))).status, 410);
    assert.equal((await f.request('/api/join', { code: room.code, name: 'Alex' })).status, 404);
    assert.equal(await (await f.request(`/api/rooms/${room.id}/archive`, undefined, f.admin)).text(), 'archive');
    assert.ok(f.runtime.stopped.includes(room.id));
  } finally { await f.dispose(); }
});

test('HTTP and WebSocket reject invalid codes and hostile origins', async () => {
  const f = await fixture();
  try {
    const room = await f.create();
    assert.equal((await f.request(base(room), undefined, { origin: 'https://attacker.test' })).status, 403);
    for (const [path, requestOrigin] of [[base(room), 'https://attacker.test'], ['/rooms/ZZZZZZZZ/', origin], ['/api/collab', origin]]) {
      const client = new WebSocket(`ws://127.0.0.1:${f.port}${path}`, { headers: { Host: 'localhost:3000', Origin: requestOrigin! } });
      const status = await new Promise<number>(resolve => { client.on('unexpected-response', (_req, response) => { response.resume(); resolve(response.statusCode!); }); client.on('error', () => {}); });
      assert.equal(status, 403); client.terminate();
    }
  } finally { await f.dispose(); }
});

test('provision failure is visible, sanitized and cleaned up', async () => {
  const f = await fixture();
  try {
    f.runtime.failStart = true; const room = await f.create();
    assert.equal(room.status, 'error'); assert.ok(f.runtime.stopped.includes(room.id));
    assert.ok(!room.error?.includes('secret command'));
  } finally { await f.dispose(); }
});

test('failed stop blocks admission and can be retried', async () => {
  const f = await fixture();
  try {
    const room = await f.create(); f.runtime.failStop = true;
    assert.equal((await f.request(`/api/rooms/${room.id}/end`, {}, f.admin)).status, 502);
    assert.equal(f.store.room(room.id)?.status, 'error');
    assert.equal((await f.request(base(room))).status, 410);
    f.runtime.failStop = false;
    assert.equal((await f.request(`/api/rooms/${room.id}/end`, {}, f.admin)).status, 200);
  } finally { await f.dispose(); }
});

test('expired room is denied immediately and swept', async () => {
  const f = await fixture();
  try {
    const room = await f.create(); const realNow = Date.now;
    Date.now = () => room.expiresAt + 1;
    try {
      assert.equal((await f.request(base(room))).status, 410);
      assert.equal((await f.request('/api/join', { code: room.code, name: 'Alex' })).status, 404);
      await f.rooms.sweep(); assert.equal(f.store.room(room.id)?.status, 'ended');
    } finally { Date.now = realNow; }
  } finally { await f.dispose(); }
});

test('startup reconciliation refreshes ports and cleans interrupted provisioning', async () => {
  const f = await fixture();
  try {
    const active = await f.create(); f.store.update(active.id, { port: 1 });
    const interrupted = f.store.createRoom('Interrupted', 'go', 60);
    await f.rooms.reconcile();
    assert.equal(f.store.room(active.id)?.port, active.port);
    assert.equal(f.store.room(interrupted.id)?.status, 'ended');
    assert.ok(f.runtime.stopped.includes(interrupted.id));
  } finally { await f.dispose(); }
});

test('reconciliation isolates inspect and stop failures, and sweep retries recovering rooms', async () => {
  const f = await fixture();
  try {
    const broken = await f.create(); const healthy = await f.create();
    const interrupted = f.store.createRoom('Interrupted', 'python', 60);
    const inspect = f.runtime.running.bind(f.runtime); const stop = f.runtime.stop.bind(f.runtime);
    f.runtime.running = async room => { if (room.id === broken.id) throw new Error(`inspect WEDE_PASSWORD=${room.password}`); return inspect(room); };
    f.runtime.stop = async room => { if (room.id === interrupted.id) throw new Error('stop unavailable'); return stop(room); };
    f.store.update(healthy.id, { port: 1 });
    await f.rooms.reconcile();
    assert.equal(f.store.room(broken.id)?.status, 'recovering');
    assert.equal(f.store.room(broken.id)?.port, null);
    assert.equal((await f.request(base(broken))).status, 410);
    assert.equal(f.store.room(interrupted.id)?.status, 'error');
    assert.equal(f.store.room(healthy.id)?.port, healthy.port);
    assert.equal(f.store.room(healthy.id)?.status, 'active');
    assert.ok(f.logs.some(log => log.operation === 'room.recover' && log.roomId === broken.id));
    assert.ok(f.logs.some(log => log.operation === 'room.end' && log.roomId === interrupted.id));
    assert.ok(!JSON.stringify(f.logs).includes(broken.password));
    f.runtime.running = async room => { assert.equal(room.status, 'recovering'); return inspect(room); };
    await f.rooms.sweep();
    assert.equal(f.store.room(broken.id)?.status, 'active');
    assert.equal(f.store.room(broken.id)?.error, null);
    f.runtime.stop = stop;
    await f.rooms.end(f.store.room(interrupted.id)!);
    assert.equal(f.store.room(interrupted.id)?.status, 'ended');
  } finally { await f.dispose(); }
});

test('settling waits for every recovery in an in-flight sweep before storage can close', { timeout: 10_000 }, async () => {
  const f = await fixture();
  const releases: (() => void)[] = [];
  let unblock = false;
  try {
    const first = await f.create(); const second = await f.create();
    for (const room of [first, second]) f.store.update(room.id, { status: 'recovering', port: null });
    let enteredFirst!: () => void; let enteredSecond!: () => void;
    const firstStarted = new Promise<void>(resolve => { enteredFirst = resolve; });
    const secondStarted = new Promise<void>(resolve => { enteredSecond = resolve; });
    f.runtime.running = async () => {
      if (unblock) return first.port;
      const gate = new Promise<void>(resolve => releases.push(resolve));
      (releases.length === 1 ? enteredFirst : enteredSecond)();
      await gate; return first.port;
    };
    const sweep = f.rooms.sweep(); await firstStarted;
    assert.equal(f.rooms.sweep(), sweep);
    let settled = false;
    const settling = f.rooms.settle().then(() => { settled = true; });
    releases[0](); await secondStarted;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false);
    releases[1](); await settling; await sweep;
    assert.equal(f.store.room(first.id)?.status, 'active');
    assert.equal(f.store.room(second.id)?.status, 'active');
  } finally { unblock = true; for (const release of releases) release(); await f.dispose(); }
});

for (const entry of ['homepage', 'bootstrap', 'sweep'] as const) {
  test(`end waits for ${entry} recovery and rejects new launch attempts`, { timeout: 10_000 }, async () => {
    const f = await fixture();
    let release: (() => void) | undefined;
    try {
      const room = await f.create();
      let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
      let launches = 0;
      f.runtime.running = () => new Promise<number>(resolve => { launches++; release = () => resolve(room.port!); started(); });
      if (entry === 'bootstrap') f.editorAuth.loginFailures = 1;
      if (entry === 'sweep') f.store.update(room.id, { status: 'recovering', port: null });
      const opening = entry === 'sweep' ? f.rooms.sweep()
        : f.request(base(room) + (entry === 'bootstrap' ? '__codingbox/bootstrap' : ''));
      await ready;
      const ending = f.rooms.end(room);
      assert.equal(f.rooms.active(f.store.room(room.id)), false);
      assert.equal(await f.rooms.running(room), null);
      assert.equal(launches, 1); assert.equal(f.runtime.stopped.length, 0);
      release!(); await ending;
      const result = await opening;
      if (result) assert.notEqual(result.status, 200);
      assert.equal(f.store.room(room.id)?.status, 'ended');
      assert.deepEqual(f.runtime.stopped, [room.id]);
      await f.rooms.sweep(); assert.equal(launches, 1);
    } finally { release?.(); await f.dispose(); }
  });
}

test('room creation defaults to Python without a language choice', async () => {
  const f = await fixture();
  try {
    const response = await f.request('/api/rooms', { title: 'Default Python', minutes: 60 }, f.admin);
    assert.equal(response.status, 202);
    assert.equal((await response.json()).room.language, 'python');
  } finally { await f.dispose(); }
});

test('history is filtered, searched literally, paginated and clamped after deletion', async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 12; i++) {
      const r = f.store.createRoom(`History ${i} ${i === 0 ? '100%_match' : ''}`, 'python', 60);
      f.store.update(r.id, { status: 'ended', endedAt: i + 1 });
    }
    await f.create();
    const first = await (await f.request('/api/rooms?tab=completed&pageSize=10', undefined, f.admin)).json();
    assert.equal(first.total, 12); assert.equal(first.rooms.length, 10); assert.equal(first.pages, 2);
    assert.deepEqual(first.counts, { ongoing: 1, completed: 12 });
    assert.equal(first.rooms[0].title.trim(), 'History 11');
    const second = await (await f.request('/api/rooms?tab=completed&page=2&pageSize=10', undefined, f.admin)).json();
    assert.equal(second.rooms.length, 2);
    const literal = await (await f.request('/api/rooms?tab=completed&q=%25_', undefined, f.admin)).json();
    assert.equal(literal.total, 1);
    const code = literal.rooms[0].code;
    assert.equal((await (await f.request(`/api/rooms?tab=completed&q=${code.toLowerCase()}`, undefined, f.admin)).json()).total, 1);
    const ongoing = await (await f.request('/api/rooms?tab=ongoing', undefined, f.admin)).json();
    assert.equal(ongoing.total, 1); assert.equal(ongoing.rooms[0].status, 'active');
    const deleted = await f.request('/api/rooms/batch-delete', { ids: second.rooms.map((r: Room) => r.id) }, f.admin);
    assert.equal(deleted.status, 200);
    const clamped = await (await f.request('/api/rooms?tab=completed&page=2&pageSize=10', undefined, f.admin)).json();
    assert.equal(clamped.page, 1); assert.equal(clamped.total, 10);
    assert.equal((await f.request('/api/rooms?tab=completed&page=0', undefined, f.admin)).status, 400);
  } finally { await f.dispose(); }
});

test('deletion is admin-only, ended-only, removes data and reports partial failures', async () => {
  const f = await fixture();
  try {
    const active = await f.create(); const ended = await f.create(); await f.rooms.end(ended);
    const path = `/api/rooms/${ended.id}`;
    assert.equal((await f.request(path, undefined, { method: 'DELETE' })).status, 401);
    assert.equal((await f.request(path, undefined, { ...f.admin, method: 'DELETE', origin: 'https://attacker.test' })).status, 403);
    assert.equal((await f.request(`/api/rooms/${active.id}`, undefined, { ...f.admin, method: 'DELETE' })).status, 409);
    f.runtime.failRemove = true;
    assert.equal((await f.request(path, undefined, { ...f.admin, method: 'DELETE' })).status, 502);
    assert.equal(f.store.room(ended.id)?.status, 'ended');
    f.runtime.failRemove = false;
    const result = await (await f.request('/api/rooms/batch-delete', { ids: [active.id, ended.id] }, f.admin)).json();
    assert.deepEqual(result.deleted, [ended.id]); assert.equal(result.failed[0].id, active.id);
    assert.equal(f.store.room(ended.id), undefined); assert.ok(f.store.room(active.id));
    assert.deepEqual(f.runtime.removed, [ended.id]);
    assert.equal((await f.request(path, undefined, { ...f.admin, method: 'DELETE' })).status, 404);
    assert.equal((await f.request('/api/rooms/batch-delete', { ids: [] }, f.admin)).status, 400);
  } finally { await f.dispose(); }
});

test('batch export contains selected archives and a manifest; running rooms are rejected', async () => {
  const f = await fixture(); const directory = mkdtempSync(join(tmpdir(), 'codingbox-bundle-test-'));
  try {
    const first = await f.create(); const second = await f.create(); const active = await f.create();
    await f.rooms.end(first); await f.rooms.end(second);
    assert.equal((await f.request('/api/rooms/batch-archive', { ids: [first.id] })).status, 401);
    assert.equal((await f.request('/api/rooms/batch-archive', { ids: [first.id, active.id] }, f.admin)).status, 409);
    const response = await f.request('/api/rooms/batch-archive', { ids: [first.id, second.id] }, f.admin);
    assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'application/gzip');
    const file = join(directory, 'bundle.tar.gz'); writeFileSync(file, Buffer.from(await response.arrayBuffer()));
    const files = execFileSync('tar', ['-tzf', file], { encoding: 'utf8' }).trim().split('\n');
    assert.deepEqual(files.sort(), [`codingbox-${first.code}.tar.gz`, `codingbox-${second.code}.tar.gz`, 'manifest.json'].sort());
    const manifest = JSON.parse(execFileSync('tar', ['-xOzf', file, 'manifest.json'], { encoding: 'utf8' }));
    assert.deepEqual(manifest.rooms.map((r: Room) => r.id), [first.id, second.id]);
    assert.ok(!JSON.stringify(manifest).includes(first.password));
    f.runtime.archive = () => spawn(process.execPath, ['-e', 'process.exit(1)']);
    assert.equal((await f.request('/api/rooms/batch-archive', { ids: [first.id] }, f.admin)).status, 502);
    assert.equal((await f.request(`/api/rooms/${first.id}`, undefined, { ...f.admin, method: 'DELETE' })).status, 200, 'failed export must release its lease');
  } finally { await f.dispose(); rmSync(directory, { recursive: true, force: true }); }
});

test('direct and prepared exports share a limit without leasing rejected rooms', { timeout: 10_000 }, async () => {
  const f = await fixture({ maxExports: 1 });
  let release: (() => void) | undefined;
  try {
    const first = await f.create(); const second = await f.create();
    await f.rooms.end(first); await f.rooms.end(second);
    const archive = f.runtime.archive;
    let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
    f.runtime.archive = () => {
      const child = spawn(process.execPath, ['-e', 'process.stdin.once("data", () => process.stdout.write("archive"))'], { stdio: ['pipe', 'pipe', 'pipe'] });
      release = () => child.stdin!.end('go'); started(); return child;
    };
    const download = f.request(`/api/rooms/${first.id}/archive`, undefined, f.admin);
    await ready;
    assert.equal((await f.request(`/api/rooms/${second.id}/archive`, undefined, f.admin)).status, 429);
    const rejected = await f.request('/api/rooms/batch-archive', { ids: [second.id], delivery: 'download' }, f.admin);
    assert.equal(rejected.status, 429); assert.equal(rejected.headers.get('retry-after'), '5');
    assert.equal((await f.request(`/api/rooms/${second.id}`, undefined, { ...f.admin, method: 'DELETE' })).status, 200);
    release!(); assert.equal(await (await download).text(), 'archive');
    f.runtime.archive = archive;
    let next: Response | undefined;
    for (let i = 0; i < 100; i++) {
      next = await f.request(`/api/rooms/${first.id}/archive`, undefined, f.admin);
      if (next.status !== 429) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(next?.status, 200, 'completed export must release its capacity');
  } finally { release?.(); await f.dispose(); }
});

test('prepared download requires admin, is consumed once and retains its deletion lease', async () => {
  const f = await fixture();
  try {
    const room = await f.create(); await f.rooms.end(room);
    const prepare = await f.request('/api/rooms/batch-archive', { ids: [room.id], delivery: 'download' }, f.admin);
    assert.equal(prepare.status, 200);
    const { url } = await prepare.json();
    assert.match(url, /^\/api\/archives\/[a-f0-9-]+$/);
    assert.equal((await f.request(url)).status, 401);
    assert.equal((await f.request(url, undefined, { ...f.admin, method: 'HEAD' })).status, 405);
    assert.equal((await f.request(`/api/rooms/${room.id}`, undefined, { ...f.admin, method: 'DELETE' })).status, 409);
    const download = await f.request(url, undefined, f.admin);
    assert.equal(download.status, 200);
    assert.match(download.headers.get('content-disposition')!, /attachment; filename="codingbox-interviews.tar.gz"/);
    const data = Buffer.from(await download.arrayBuffer());
    assert.equal(Number(download.headers.get('content-length')), data.length);
    assert.equal(data.readUInt16BE(0), 0x1f8b);
    assert.equal((await f.request(url, undefined, f.admin)).status, 410);
    assert.equal((await f.request(`/api/rooms/${room.id}`, undefined, { ...f.admin, method: 'DELETE' })).status, 200);
  } finally { await f.dispose(); }
});

test('unused prepared downloads expire and shutdown releases ready reservations', async () => {
  const f = await fixture({ maxExports: 1, archiveReadyTimeoutMs: 100 });
  try {
    const room = await f.create(); await f.rooms.end(room);
    const prepared = await f.request('/api/rooms/batch-archive', { ids: [room.id], delivery: 'download' }, f.admin);
    const { url } = await prepared.json();
    assert.equal((await f.request(`/api/rooms/${room.id}/archive`, undefined, f.admin)).status, 429);
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal((await f.request(url, undefined, f.admin)).status, 410);
    const next = await f.request('/api/rooms/batch-archive', { ids: [room.id], delivery: 'download' }, f.admin);
    assert.equal(next.status, 200);
    const nextUrl = (await next.json()).url;
    await f.archives.close();
    assert.equal((await f.request(nextUrl, undefined, f.admin)).status, 410);
    assert.equal((await f.request(`/api/rooms/${room.id}`, undefined, { ...f.admin, method: 'DELETE' })).status, 200);
  } finally { await f.dispose(); }
});

test('archive worker cleanup finishes before releasing its room or sending success', { timeout: 10_000 }, async () => {
  const f = await fixture({ maxExports: 1 });
  let release: (() => void) | undefined;
  try {
    const room = await f.create(); await f.rooms.end(room);
    let started!: () => void; const cleaning = new Promise<void>(resolve => { started = resolve; });
    f.runtime.archive = () => Object.assign(spawn(process.execPath, ['-e', 'process.stdout.write("archive")']), {
      cleanup: () => new Promise<void>(resolve => { release = resolve; started(); }),
    });
    const download = f.request(`/api/rooms/${room.id}/archive`, undefined, f.admin);
    await cleaning;
    assert.equal((await f.request(`/api/rooms/${room.id}`, undefined, { ...f.admin, method: 'DELETE' })).status, 409);
    assert.equal((await f.request(`/api/rooms/${room.id}/archive`, undefined, f.admin)).status, 429);
    release!(); assert.equal((await download).status, 200);
    assert.equal((await f.request(`/api/rooms/${room.id}`, undefined, { ...f.admin, method: 'DELETE' })).status, 200);
  } finally { release?.(); await f.dispose(); }
});

test('archive worker cleanup failures retain diagnostic context without sending a successful file', async () => {
  const f = await fixture();
  try {
    const room = await f.create(); await f.rooms.end(room);
    f.runtime.archive = () => Object.assign(spawn(process.execPath, ['-e', 'process.stdout.write("archive")']), {
      async cleanup() { throw new Error(`worker cleanup failed WEDE_PASSWORD=${room.password}`); },
    });
    const response = await f.request(`/api/rooms/${room.id}/archive`, undefined, f.admin);
    assert.equal(response.status, 502);
    assert.equal(response.headers.get('content-disposition'), null);
    assert.ok(f.logs.some(record => record.operation === 'archive.worker.cleanup' && record.roomId === room.id));
    assert.ok(!JSON.stringify(f.logs).includes(room.password));
  } finally { await f.dispose(); }
});

test('download and deletion reservations cannot overlap', { timeout: 10_000 }, async () => {
  const f = await fixture();
  let releaseExport: (() => void) | undefined;
  let completeRemoval: (() => void) | undefined;
  try {
    const r = await f.create(); await f.rooms.end(r);
    const exportStarted = new Promise<void>(resolve => {
      f.runtime.archive = () => {
        const child = spawn(process.execPath, ['-e', 'process.stdin.once("data", () => process.stdout.write("archive"))'], { stdio: ['pipe', 'pipe', 'pipe'] });
        releaseExport = () => child.stdin!.end('go'); resolve(); return child;
      };
    });
    const downloading = f.request(`/api/rooms/${r.id}/archive`, undefined, f.admin);
    await exportStarted;
    assert.equal((await f.request(`/api/rooms/${r.id}`, undefined, { ...f.admin, method: 'DELETE' })).status, 409);
    releaseExport!(); assert.equal(await (await downloading).text(), 'archive');
    let started!: () => void;
    const removing = new Promise<void>(resolve => { started = resolve; });
    f.runtime.remove = () => new Promise<void>(resolve => { completeRemoval = resolve; started(); });
    const deletion = f.request(`/api/rooms/${r.id}`, undefined, { ...f.admin, method: 'DELETE' });
    await removing;
    assert.equal((await f.request(`/api/rooms/${r.id}/archive`, undefined, f.admin)).status, 409);
    completeRemoval!(); assert.equal((await deletion).status, 200);
  } finally { releaseExport?.(); completeRemoval?.(); await f.dispose(); }
});

test('disconnecting an export stops its child and releases the deletion reservation', { timeout: 10_000 }, async () => {
  const f = await fixture();
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const room = await f.create(); await f.rooms.end(room);
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    f.runtime.archive = () => {
      child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)']); started(); return child;
    };
    const request = httpRequest(`http://127.0.0.1:${f.port}/api/rooms/${room.id}/archive`, { headers: { Host: 'localhost:3000', Cookie: f.admin.cookie } });
    request.on('error', () => {}); request.end();
    await ready;
    const closed = once(child!, 'close'); request.destroy(); await closed;
    assert.equal((await f.request(`/api/rooms/${room.id}`, undefined, { ...f.admin, method: 'DELETE' })).status, 200);
  } finally { child?.kill(); await f.dispose(); }
});

test('concurrent delete requests share one storage removal', { timeout: 10_000 }, async () => {
  const f = await fixture();
  let complete: (() => void) | undefined;
  try {
    const room = await f.create(); await f.rooms.end(room);
    let calls = 0; let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    f.runtime.remove = () => new Promise<void>(resolve => { calls++; complete = resolve; started(); });
    const first = f.rooms.remove(room.id); await ready;
    const second = f.rooms.remove(room.id);
    assert.equal(calls, 1); complete!(); await Promise.all([first, second]);
    assert.equal(f.store.room(room.id), undefined);
  } finally { complete?.(); await f.dispose(); }
});

test('export cancellation kills a stubborn child even after stdout closes', { timeout: 10_000 }, async () => {
  const f = await fixture();
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const room = await f.create(); await f.rooms.end(room);
    let outputClosed!: () => void;
    const ready = new Promise<void>(resolve => { outputClosed = resolve; });
    f.runtime.archive = () => {
      child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); process.stdout.end(); process.stderr.write("ready"); setInterval(() => {}, 1000)']);
      void Promise.all([once(child.stdout!, 'end'), once(child.stderr!, 'data')]).then(outputClosed);
      return child;
    };
    const download = httpRequest(`http://127.0.0.1:${f.port}/api/rooms/${room.id}/archive`, { headers: { Host: 'localhost:3000', Cookie: f.admin.cookie } });
    download.on('error', () => {}); download.end();
    await ready;
    const closed = once(child!, 'close', { signal: AbortSignal.timeout(5000) });
    download.destroy(); await closed;
    assert.equal(child!.signalCode, 'SIGKILL');
    assert.equal((await f.request(`/api/rooms/${room.id}`, undefined, { ...f.admin, method: 'DELETE' })).status, 200);
  } finally { child?.kill('SIGKILL'); await f.dispose(); }
});
