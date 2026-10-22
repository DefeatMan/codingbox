import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

test('Run polling accepts a new server instance after revision resets', async () => {
  const states: unknown[] = [];
  const effects: (() => (() => void))[] = [];
  let poll: () => void = () => {};
  let run: unknown = { instance: 'before-restart', revision: 5, terminal: { id: 0, runSession: 'codingbox-run-before-5', generation: 5 } };
  const react = {
    useState(initial: unknown) {
      const index = states.length;
      states.push(initial);
      return [initial, (next: unknown) => { states[index] = typeof next === 'function' ? next(states[index]) : next; }];
    },
    useEffect(effect: () => (() => void)) { effects.push(effect); },
    useRef(current: unknown) { return { current }; },
    useCallback(callback: unknown) { return callback; },
  };
  const source = ts.transpileModule(readFileSync('docker/wede/useTerminals.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports: Record<string, (...args: unknown[]) => unknown> = {};
  vm.runInNewContext(source, {
    exports, require(name: string) {
      if (name === 'react') return react;
      if (name === '../api') return { workspaceUrl: (_workspace: string, path: string) => path };
      throw new Error('Unexpected import: ' + name);
    },
    setTimeout(callback: () => void) { poll = callback; return 1; }, clearTimeout() {},
  });
  exports.useTerminals(async () => ({ ok: true, json: async () => run }), 'workspace');
  const dispose = effects[1]();
  const flush = () => new Promise<void>(resolve => setImmediate(resolve));
  const currentSession = () => (states[1] as { runSession: string } | null)?.runSession;
  await flush();
  assert.equal(currentSession(), 'codingbox-run-before-5');
  run = { instance: 'after-restart', revision: 0, terminal: null };
  poll(); await flush();
  assert.equal(states[1], null, 'Old Run must disappear when the server instance changes');
  run = { instance: 'after-restart', revision: 1, terminal: { id: 0, runSession: 'codingbox-run-after-1', generation: 1 } };
  poll(); await flush();
  assert.equal(currentSession(), 'codingbox-run-after-1');
  dispose();
});
