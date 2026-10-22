import express, { type Request, type Response, type NextFunction } from 'express';
import { rateLimit } from 'express-rate-limit';
import httpProxy from 'http-proxy';
import { createServer, type IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { Store, hash, type Room } from './store.ts';
import { Rooms, RoomOperationError } from './rooms.ts';
import { sendArchives } from './archives.ts';
import type { Runtime } from './runtime.ts';

export interface Config {
  publicUrl: string; adminPassword: string; dataDir: string; maxRooms: number;
}
const cookieValue = (request: IncomingMessage, name: string) => request.headers.cookie?.split(';')
  .map(v => v.trim()).find(v => v.startsWith(`${name}=`))?.slice(name.length + 1);

export function createApplication(config: Config, runtime: Runtime) {
  const publicUrl = new URL(config.publicUrl);
  if (!['http:', 'https:'].includes(publicUrl.protocol) || publicUrl.pathname !== '/' || publicUrl.username || publicUrl.password || publicUrl.search || publicUrl.hash) {
    throw new Error('PUBLIC_URL must be an HTTP(S) origin without a path');
  }
  if (/^[\d.]+$/.test(publicUrl.hostname) || publicUrl.hostname === '[::1]') throw new Error('Use localhost or a domain for PUBLIC_URL, not an IP address');
  const secure = publicUrl.protocol === 'https:';
  const adminCookie = secure ? '__Host-codingbox_admin' : 'codingbox_admin';
  const store = new Store(config.dataDir);
  const rooms = new Rooms(store, runtime);
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  const server = createServer(app);
  // Browsers can reset upgraded connections while navigating or closing a tab.
  server.on('connection', socket => socket.on('error', () => socket.destroy()));
  const sockets = new Map<string, Set<Duplex>>();
  const routedRooms = new WeakMap<IncomingMessage, Room>();
  rooms.onEnd = id => {
    for (const socket of sockets.get(id) ?? []) socket.destroy(); sockets.delete(id);
  };
  const proxy = httpProxy.createProxyServer({ ws: true, changeOrigin: false, xfwd: false });
  proxy.on('proxyReqWs', (proxyRequest, request) => {
    proxyRequest.on('response', response => {
      if (response.statusCode !== 101) console.error('Editor WebSocket upgrade rejected:', response.statusCode, request.url?.split('?')[0]);
    });
    const room = routedRooms.get(request);
    if (!room) return;
    proxyRequest.once('upgrade', (_response, socket) => {
      socket.on('error', () => socket.destroy());
      const set = sockets.get(room.id);
      if (!set) { socket.destroy(); return; }
      set.add(socket);
      socket.once('close', () => set.delete(socket));
    });
  });
  proxy.on('error', (_error, _request, response) => {
    if ('writeHead' in response) {
      const res = response as Response;
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '编辑器暂时不可用，请返回门户重新加入。' }));
    } else response.destroy();
  });
  proxy.on('proxyRes', response => { delete response.headers['set-cookie']; });

  const host = (request: IncomingMessage) => (request.headers.host ?? '').toLowerCase();
  const roomPath = (request: IncomingMessage) => {
    const match = /^\/rooms\/([a-z2-9]{4}-?[a-z2-9]{4})(?=\/|\?|$)/i.exec(request.url ?? '');
    if (!match) return;
    return { code: match[1], prefix: match[0], suffix: (request.url ?? '').slice(match[0].length) };
  };
  const roomBase = (room: Room) => `/rooms/${room.code.toLowerCase()}/`;
  const publicRoom = (room: Room) => {
    const { password: _password, port: _port, container: _container, volume: _volume, ...info } = room;
    return { ...info, code: `${room.code.slice(0, 4)}-${room.code.slice(4)}`, joinUrl: `${publicUrl.origin}${roomBase(room)}` };
  };
  const allowedOrigin = (request: IncomingMessage) => !request.headers.origin || request.headers.origin === publicUrl.origin;
  const roomUnavailable = (res: Response, status = 403) => res.status(status).type('html').send(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>面试已结束 · Codingbox</title><body style="background:#0c0e14;color:#e8eaf2;font:18px system-ui;padding:10vw"><h1>房间暂不可访问</h1><p>面试可能已结束，或需要重新加入。</p><a style="color:#7c8cf8" href="${publicUrl.origin}">返回 Codingbox</a></body></html>`);

  // Room traffic is forwarded before JSON parsing; preserve streamed request bodies.
  app.use(async (req, res, next) => {
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (host(req) !== publicUrl.host) return res.status(421).send('Unknown host');
    const path = roomPath(req);
    if (!path) {
      if (req.path === '/rooms' || req.path.startsWith('/rooms/')) return roomUnavailable(res, 404);
      if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
      return next();
    }
    res.setHeader('Cache-Control', 'no-store');
    const room = store.byCode(path.code);
    if (!room) return roomUnavailable(res, 404);
    if (!rooms.active(room)) return roomUnavailable(res, 410);
    if (!allowedOrigin(req)) return res.status(403).send('Invalid origin');
    const canonical = roomBase(room);
    if (path.prefix !== canonical.slice(0, -1) || !path.suffix || path.suffix.startsWith('?')) {
      const suffix = path.suffix.startsWith('/') ? path.suffix.slice(1) : path.suffix;
      return res.redirect(308, canonical + suffix);
    }
    // The code is the admission credential. WEDE still authenticates its own APIs.
    req.url = path.suffix;
    if (req.path === '/__codingbox/bootstrap') {
      const name = z.string().trim().min(1).max(32).refine(value => Buffer.byteLength(value) <= 32)
        .parse(typeof req.query.name === 'string' ? req.query.name : '访客');
      let token = req.headers.authorization ?? '';
      let valid = false;
      try {
        const response = await fetch(`http://127.0.0.1:${room.port}/api/auth/check`, {
          headers: { Authorization: token }, signal: AbortSignal.timeout(3000),
        });
        valid = response.ok && (await response.json()).authenticated === true;
      } catch { /* editor may have restarted */ }
      if (!valid) token = await rooms.editorSession(room, name);
      if (!rooms.active(store.room(room.id))) return roomUnavailable(res, 410);
      return res.json({ token, name, portal: publicUrl.origin });
    }
    if (/^\/api\/(auth\/(login|redeem|tokens)|tunnel)(\/|$)/.test(req.path)) {
      return res.status(403).json({ error: '请通过 Codingbox 加入面试。' });
    }
    if (req.path === '/' && req.method === 'GET') {
      const port = await runtime.running(room);
      if (!port) return roomUnavailable(res, 503);
      if (port !== room.port) { store.update(room.id, { port }); room.port = port; }
    }
    routedRooms.set(req, room);
    req.headers['x-forwarded-proto'] = publicUrl.protocol.slice(0, -1);
    proxy.web(req, res, { target: `http://127.0.0.1:${room.port}` });
  });

  app.use(express.json({ limit: '8kb' }));
  app.use((req, res, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !allowedOrigin(req)) return res.status(403).json({ error: 'Invalid origin' });
    next();
  });
  const limiter = (limit: number) => rateLimit({ windowMs: 60_000, limit, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: '操作过于频繁，请稍后再试。' } });
  const requireAdmin = (req: Request, res: Response, next: NextFunction) => {
    if (!store.getSession(cookieValue(req, adminCookie), 'admin')) return res.status(401).json({ error: '请先登录面试官控制台。' });
    next();
  };

  app.get('/healthz', (_req, res) => res.json({ ok: true }));
  app.get('/api/session', (req, res) => res.json({ admin: !!store.getSession(cookieValue(req, adminCookie), 'admin') }));
  app.post('/api/login', limiter(8), (req, res) => {
    const body = z.object({ password: z.string().max(256) }).parse(req.body);
    if (!timingSafeEqual(Buffer.from(hash(body.password)), Buffer.from(hash(config.adminPassword)))) return res.status(401).json({ error: '面试官密码不正确。' });
    const token = store.session({ kind: 'admin', roomId: null, name: '', wedeToken: null, expiresAt: Date.now() + 12 * 3600_000 });
    res.cookie(adminCookie, token, { httpOnly: true, sameSite: 'strict', secure, path: '/', maxAge: 12 * 3600_000 });
    res.json({ ok: true });
  });
  app.post('/api/logout', (req, res) => {
    store.deleteSession(cookieValue(req, adminCookie) ?? '');
    res.clearCookie(adminCookie, { path: '/', secure, sameSite: 'strict' });
    res.json({ ok: true });
  });
  app.get('/api/rooms', requireAdmin, (req, res) => {
    if (req.query.tab === undefined) return res.json({ rooms: store.rooms().map(publicRoom) });
    const query = z.object({ tab: z.enum(['ongoing', 'completed']), q: z.string().trim().max(100).default(''),
      page: z.coerce.number().int().min(1).max(1_000_000).default(1), pageSize: z.coerce.number().int().min(1).max(50).default(10),
    }).parse(req.query);
    const result = store.roomPage(query.tab, query.q, query.page, query.pageSize);
    res.json({ ...result, rooms: result.rooms.map(publicRoom) });
  });
  app.post('/api/rooms', requireAdmin, limiter(15), (req, res) => {
    const body = z.object({ title: z.string().trim().min(1).max(80), language: z.enum(['python', 'typescript', 'go', 'cpp', 'rust']).default('python'), minutes: z.number().int().min(15).max(480) }).parse(req.body);
    if (store.roomCounts().ongoing >= config.maxRooms) return res.status(409).json({ error: '房间数量已达上限，请先结束已有房间。' });
    const room = store.createRoom(body.title, body.language, body.minutes);
    rooms.provision(room);
    res.status(202).json({ room: publicRoom(room) });
  });
  app.post('/api/join', limiter(20), (req, res) => {
    const body = z.object({ code: z.string().trim().regex(/^[a-zA-Z2-9]{4}-?[a-zA-Z2-9]{4}$/), name: z.string().trim().min(1).max(32).refine(s => Buffer.byteLength(s) <= 32, '名字过长') }).parse(req.body);
    const room = store.byCode(body.code);
    if (!rooms.active(room)) return res.status(404).json({ error: '面试码无效，或房间尚未就绪、已结束。' });
    res.json({ url: `${publicUrl.origin}${roomBase(room)}?name=${encodeURIComponent(body.name)}` });
  });
  app.post('/api/rooms/:id/end', requireAdmin, async (req, res) => {
    const room = store.room(String(req.params.id));
    if (!room) return res.status(404).json({ error: '房间不存在。' });
    await rooms.end(room);
    res.json({ room: publicRoom(store.room(room.id)!) });
  });
  const selectedRooms = z.object({ ids: z.array(z.string().uuid()).min(1).max(50).transform(ids => [...new Set(ids)]) });
  app.post('/api/rooms/batch-archive', requireAdmin, limiter(10), async (req, res) => {
    const { ids } = selectedRooms.parse(req.body);
    await sendArchives(runtime, rooms.leaseArchives(ids), res, true);
  });
  app.post('/api/rooms/batch-delete', requireAdmin, async (req, res) => {
    const { ids } = selectedRooms.parse(req.body);
    const deleted: string[] = []; const failed: { id: string; error: string }[] = [];
    for (const id of ids) {
      try { await rooms.remove(id); deleted.push(id); }
      catch (error) { failed.push({ id, error: error instanceof RoomOperationError ? error.message : '删除失败，记录已保留，请重试。' }); }
    }
    res.json({ deleted, failed });
  });
  app.delete('/api/rooms/:id', requireAdmin, async (req, res) => {
    await rooms.remove(z.string().uuid().parse(req.params.id));
    res.json({ ok: true });
  });
  app.get('/api/rooms/:id/archive', requireAdmin, async (req, res) => {
    await sendArchives(runtime, rooms.leaseArchives([String(req.params.id)]), res, false);
  });
  app.use('/api', (_req, res) => res.status(404).json({ error: '接口不存在。' }));
  app.use(express.static(fileURLToPath(new URL('../public', import.meta.url)), { index: 'index.html' }));
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return res.end();
    if (error instanceof RoomOperationError) return res.status(error.status).json({ error: error.message });
    if (error instanceof z.ZodError) return res.status(400).json({ error: '输入不正确，请检查名字、面试码或房间设置。' });
    if (error instanceof SyntaxError) return res.status(400).json({ error: '请求格式不正确。' });
    res.status(502).json({ error: '操作失败，请检查运行环境和编辑器状态后重试。' });
  });

  const upgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = roomPath(req);
    const room = path ? store.byCode(path.code) : undefined;
    if (host(req) !== publicUrl.host || !path || !rooms.active(room) || !allowedOrigin(req)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    let set = sockets.get(room.id);
    if (!set) { set = new Set(); sockets.set(room.id, set); }
    set.add(socket);
    socket.on('close', () => { set!.delete(socket); if (!set!.size) sockets.delete(room.id); });
    req.url = path.suffix || '/';
    routedRooms.set(req, room);
    req.headers['x-forwarded-proto'] = publicUrl.protocol.slice(0, -1);
    proxy.ws(req, socket, head, { target: `http://127.0.0.1:${room.port}` });
  };
  server.on('upgrade', upgrade);
  return { app, server, store, rooms, async close() {
    for (const id of sockets.keys()) rooms.onEnd(id);
    await rooms.settle();
    proxy.close();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    store.close();
  } };
}
