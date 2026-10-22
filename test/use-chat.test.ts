import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

test('Git activity preserves distinct legacy chat records with identical IDs', () => {
  const states: unknown[] = [];
  const effects: (() => (() => void))[] = [];
  let socket: { onmessage: (event: { data: string }) => void };
  class Socket {
    static OPEN = 1;
    onmessage = (_event: { data: string }) => {};
    constructor() { socket = this; }
    close() {}
  }
  const react = {
    useState(initial: unknown) {
      const index = states.length;
      states.push(typeof initial === 'function' ? initial() : initial);
      return [states[index], (next: unknown) => { states[index] = next; }];
    },
    useEffect(effect: () => (() => void)) { effects.push(effect); },
    useRef(current: unknown) { return { current }; },
    useCallback(callback: unknown) { return callback; },
  };
  const source = ts.transpileModule(readFileSync('docker/wede/useChat.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports: Record<string, (...args: unknown[]) => unknown> = {};
  vm.runInNewContext(source, {
    exports, require(name: string) {
      if (name === 'react') return react;
      if (name === '../roomScope') return { roomBase: '/rooms/abcd2345', roomPath: (path: string) => '/rooms/abcd2345' + path };
      throw new Error('Unexpected import: ' + name);
    },
    WebSocket: Socket, location: { protocol: 'https:', port: '', host: 'codingbox.test' },
    setTimeout, clearTimeout,
  });
  exports.useChat('workspace', 'test-token', 'Alex', '#888888');
  const dispose = effects[0]();
  const frame = (value: unknown) => socket.onmessage({ data: JSON.stringify(value) });
  const history = [
    { id: 'h-same-second', kind: 'user', text: 'first legacy message', time: '2026-01-01T00:00:00Z' },
    { id: 'h-same-second', kind: 'user', text: 'second legacy message', time: '2026-01-01T00:00:00Z' },
  ];
  const activity = { id: 'git-commit', kind: 'git', text: 'commit', time: '2026-01-01T00:00:01Z' };
  frame({ type: 'history', messages: history });
  frame({ type: 'activity', messages: [activity] });
  frame({ type: 'activity', messages: [activity] });
  const messages = states[0] as { text: string }[];
  assert.deepEqual(Array.from(messages, message => message.text), ['first legacy message', 'second legacy message', 'commit']);
  dispose();
});
