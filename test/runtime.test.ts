import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import { DockerRuntime } from '../src/runtime.ts';
import type { Room } from '../src/store.ts';

async function dockerFixture(firstError: string) {
  const directory = await mkdtemp(join(tmpdir(), 'codingbox-docker-test-'));
  const attempts = join(directory, 'attempts');
  await writeFile(join(directory, 'docker'), `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv[2] === 'run') { process.stdout.write('archive'); process.exit(0); }
if (process.argv[2] !== 'rm') process.exit(2);
const path = ${JSON.stringify(attempts)};
const count = fs.existsSync(path) ? Number(fs.readFileSync(path, 'utf8')) + 1 : 1;
fs.writeFileSync(path, String(count));
console.error(count === 1 ? ${JSON.stringify(firstError)} : 'Error response from daemon: No such container: test');
process.exit(1);
`, { mode: 0o700 });
  const previousPath = process.env.PATH;
  process.env.PATH = directory + delimiter + (previousPath ?? '');
  const child = new DockerRuntime('test-image').archive({ volume: 'test-volume' } as Room);
  child.stdout!.resume(); child.stderr!.resume();
  await once(child, 'close');
  return {
    cleanup: child.cleanup!, attempts: async () => Number(await readFile(attempts, 'utf8')),
    async dispose() {
      if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('archive cleanup waits for Docker automatic removal before releasing its caller', async () => {
  const f = await dockerFixture('Error response from daemon: removal of container test is already in progress');
  try { await f.cleanup(); assert.equal(await f.attempts(), 2); }
  finally { await f.dispose(); }
});

test('archive cleanup preserves unexpected Docker errors for diagnostics', async () => {
  const f = await dockerFixture('Error response from daemon: permission denied');
  try {
    await assert.rejects(f.cleanup(), /permission denied/);
    assert.equal(await f.attempts(), 1);
  } finally { await f.dispose(); }
});
