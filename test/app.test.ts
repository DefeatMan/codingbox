import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request as httpRequest } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import { createApplication } from '../src/app.ts';
import type { Runtime } from '../src/runtime.ts';
import type { Room } from '../src/store.ts';

const origin = 'http://localhost:3000';
const base = (room: Room) => `/rooms/${room.code.toLowerCase()}/`;
async function fixture() {
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
    req.on('end', () => res.end(JSON.stringify({ upstream: true, path: req.url, body: Buffer.concat(chunks).toString() })));
  });
  const wsServer = new WebSocketServer({ server: upstream });
  wsServer.on('connection', (socket, req) => {
    socket.send(req.url!);
    socket.on('message', data => socket.send(data));
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const upstreamPort = (upstream.address() as { port: number }).port;
  const runtime: Runtime & { stopped: string[]; failStart: boolean; failStop: boolean; recoveryChecks: number } = {
    stopped: [], failStart: false, failStop: false, recoveryChecks: 0,
    async start() { if (this.failStart) throw new Error('secret command'); return upstreamPort; },
    async stop(room: Room) { if (this.failStop) throw new Error('stop failed'); this.stopped.push(room.id); },
    async running() { this.recoveryChecks++; return upstreamPort; },
    archive() { return spawn(process.execPath, ['-e', 'process.stdout.write("archive")']); },
  };
  const application = createApplication({ publicUrl: origin, adminPassword: 'test-admin-password', dataDir: directory, maxRooms: 5 }, runtime);
  application.server.listen(0, '127.0.0.1'); await once(application.server, 'listening');
  const port = (application.server.address() as { port: number }).port;
  const request = (path: string, body?: unknown, options: { cookie?: string; origin?: string; authorization?: string; host?: string } = {}) => new Promise<Response>((resolve, reject) => {
    const req = httpRequest(`http://127.0.0.1:${port}${path}`, {
      method: body === undefined ? 'GET' : 'POST', headers: { Host: options.host ?? 'localhost:3000',
        ...(options.cookie ? { Cookie: options.cookie } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(options.origin ? { Origin: options.origin } : {}),
        ...(options.authorization ? { Authorization: options.authorization } : {}),
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
  return { ...application, runtime, editorAuth, request, create, admin, port, async dispose() {
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
