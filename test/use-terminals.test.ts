import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function hookFixture(fetch: (path: string, options?: unknown) => Promise<unknown>) {
  const states: unknown[] = [];
  const refs: { current: unknown }[] = [];
  const effects: (() => (() => void))[] = [];
  let stateIndex = 0; let refIndex = 0; let poll = () => {};
  const react = {
    useState(initial: unknown) {
      const index = stateIndex++;
      if (index >= states.length) states.push(initial);
      return [states[index], (next: unknown) => { states[index] = typeof next === 'function' ? next(states[index]) : next; }];
    },
    useEffect(effect: () => (() => void)) { effects.push(effect); },
    useRef(current: unknown) { return refs[refIndex++] ?? (refs[refIndex - 1] = { current }); },
    useCallback(callback: unknown) { return callback; },
  };
  const source = ts.transpileModule(readFileSync('docker/wede/useTerminals.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports: Record<string, (...args: unknown[]) => { addTerminal(name?: string, initial?: string): void }> = {};
  vm.runInNewContext(source, {
    exports, require(name: string) {
      if (name === 'react') return react;
      if (name === '../api') return { workspaceUrl: (workspace: string, path: string) => workspace + path };
      throw new Error('Unexpected import: ' + name);
    },
    setTimeout(callback: () => void) { poll = callback; return 1; }, clearTimeout() {},
  });
  return { states, effects, poll: () => poll(), render(workspace = 'workspace') {
    stateIndex = 0; refIndex = 0; effects.length = 0;
    return exports.useTerminals(fetch, workspace);
  } };
}

test('Run polling accepts a new server instance after revision resets', async () => {
  let run: unknown = { instance: 'before-restart', revision: 5, terminal: { id: 0, runSession: 'codingbox-run-before-5', generation: 5 } };
  const f = hookFixture(async () => ({ ok: true, json: async () => run }));
  f.render(); const dispose = f.effects[1]();
  const currentSession = () => (f.states[1] as { runSession: string } | null)?.runSession;
  await flush(); assert.equal(currentSession(), 'codingbox-run-before-5');
  run = { instance: 'after-restart', revision: 0, terminal: null };
  f.poll(); await flush(); assert.equal(f.states[1], null);
  run = { instance: 'after-restart', revision: 1, terminal: { id: 0, runSession: 'codingbox-run-after-1', generation: 1 } };
  f.poll(); await flush(); assert.equal(currentSession(), 'codingbox-run-after-1');
  dispose();
});

test('manual terminals recover at revision zero without replaying old commands or accepting stale instances', async () => {
  let state = { instance: 'before', revision: 5, createdId: 2, terminals: [{ id: 1, name: 'Old' }, { id: 2, name: 'Existing' }] };
  const f = hookFixture(async () => ({ ok: true, json: async () => state }));
  const api = f.render(); const dispose = f.effects[0](); await flush();
  state = { ...state, revision: 6 };
  api.addTerminal('Existing', 'echo do-not-repeat'); await flush();
  const current = () => f.states[0] as { id: number; name: string; initial?: string }[];
  assert.equal(current()[1].initial, 'echo do-not-repeat');
  state = { instance: 'after', revision: 0, createdId: 0, terminals: [{ id: 1, name: 'Terminal 1' }] };
  f.poll(); await flush(); assert.equal(current().length, 1); assert.equal(current()[0].name, 'Terminal 1');
  state = { ...state, revision: 1, terminals: [{ id: 1, name: 'Terminal 1' }, { id: 2, name: 'New' }] };
  f.poll(); await flush(); assert.equal(current()[1].initial, undefined); assert.equal(current()[1].name, 'New');
  state = { ...state, revision: 0, terminals: [] };
  f.poll(); await flush(); assert.equal(current().length, 2);
  state = { ...state, instance: 'before', revision: 999, terminals: [] };
  f.poll(); await flush(); assert.equal(current()[1].name, 'New');
  dispose();
});

test('terminal mutation replies from a previous workspace cannot replace the current list', async () => {
  let reply!: (value: unknown) => void;
  const pending = new Promise(resolve => { reply = resolve; });
  const f = hookFixture(async (path, options) => options ? pending : {
    ok: true, json: async () => ({ instance: path, revision: 0, terminals: [{ id: 1, name: path }] }),
  });
  const old = f.render('python'); const disposeOld = f.effects[0](); await flush();
  old.addTerminal('Late terminal');
  disposeOld(); f.render('go'); const dispose = f.effects[0](); await flush();
  reply({ ok: true, json: async () => ({ instance: 'python', revision: 50, createdId: 2, terminals: [{ id: 2, name: 'Late terminal' }] }) });
  await flush();
  assert.equal((f.states[0] as { name: string }[])[0].name, 'go/terminal/sessions');
  dispose();
});
