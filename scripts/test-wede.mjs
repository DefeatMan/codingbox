import { cp, mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'codingbox-wede-test-'));
const run = (command, args) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd: directory, stdio: 'inherit' });
  child.once('error', reject);
  child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`${command} failed (${signal ?? code})`)));
});
try {
  for (const path of ['backend', 'web', 'vendor', 'go.mod', 'go.sum']) {
    await cp(join(root, 'third_party/wede', path), join(directory, path), {
      recursive: true, filter: path => !['node_modules', '.git', 'dist'].includes(basename(path)),
    });
  }
  await run(process.execPath, [join(root, 'docker/patch-wede.mjs'), directory]);
  await run('go', ['test', '-mod=vendor', '-race', './backend/internal/chat', './backend/internal/interview', './backend/internal/terminal', './backend/internal/collabdoc']);
} finally { await rm(directory, { recursive: true, force: true }); }
