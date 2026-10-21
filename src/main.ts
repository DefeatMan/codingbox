import 'dotenv/config';
import { resolve } from 'node:path';
import { createApplication } from './app.ts';
import { DockerRuntime } from './runtime.ts';
import { NativeRuntime } from './native-runtime.ts';

const password = process.env.ADMIN_PASSWORD;
if (!password || password.length < 12 || password === 'replace-with-a-long-random-password') {
  throw new Error('Set ADMIN_PASSWORD to a unique password of at least 12 characters in .env');
}
const port = Number(process.env.PORT ?? 3000);
const maxRooms = Number(process.env.MAX_ACTIVE_ROOMS ?? 5);
if (!Number.isInteger(port) || port < 1 || port > 65535 || !Number.isInteger(maxRooms) || maxRooms < 1) throw new Error('Invalid PORT or MAX_ACTIVE_ROOMS');
const runtime = process.env.RUNTIME === 'native'
  ? new NativeRuntime(process.env.WEDE_BINARY ?? './bin/wede', './templates', resolve(process.env.DATA_DIR ?? '.data', 'native'))
  : new DockerRuntime(process.env.WEDE_IMAGE ?? 'codingbox-wede:local', process.env.ROOM_MEMORY ?? '1g', process.env.ROOM_CPUS ?? '1');
const application = createApplication({
  publicUrl: process.env.PUBLIC_URL ?? `http://localhost:${port}`, adminPassword: password,
  dataDir: resolve(process.env.DATA_DIR ?? '.data'), maxRooms,
}, runtime);
await application.rooms.reconcile();
application.server.listen(port, process.env.HOST ?? '127.0.0.1', () => {
  console.log(`Codingbox: ${process.env.PUBLIC_URL ?? `http://localhost:${port}`}`);
});
let sweeping = false;
const timer = setInterval(async () => {
  if (sweeping) return;
  sweeping = true;
  try { await application.rooms.sweep(); } finally { sweeping = false; }
}, 15_000);
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  await application.close();
  process.exit(0);
});
