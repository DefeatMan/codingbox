import 'dotenv/config';
import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';

test('two browsers join, collaborate, receive LSP responses, end and download code', async ({ browser, page, baseURL }, testInfo) => {
  const crashes: string[] = [];
  const lspResponses: unknown[] = [];
  const lspParticipants = new Set<string>();
  const diagnostics: string[] = [];
  page.on('pageerror', error => crashes.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '准备好了？' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('portal.png'), fullPage: true });
  await page.getByRole('button', { name: '面试官入口' }).click();
  await page.getByLabel('面试官密码', { exact: true }).fill(process.env.ADMIN_PASSWORD!);
  await page.getByRole('button', { name: '登录工作台' }).click();
  await expect(page.getByRole('heading', { name: '面试工作台.' })).toBeVisible();
  const title = `E2E ${Date.now()}`;
  await page.getByLabel('面试名称').fill(title);
  await page.getByRole('button', { name: '创建编程空间' }).click();
  const card = page.locator('.room-card').filter({ hasText: title });
  let roomId: string | null = null;
  const guestContext = await browser.newContext();
  const peerContext = await browser.newContext();
  try {
    await expect(card).toBeVisible();
    roomId = await card.getAttribute('data-room-id');
    await expect(card.locator('.status')).toHaveText('进行中', { timeout: 60_000 });
    const code = (await card.locator('.room-code').textContent())!;
    await page.screenshot({ path: testInfo.outputPath('dashboard.png'), fullPage: true });
    const guest = await guestContext.newPage(); const peer = await peerContext.newPage();
    for (const [participant, name] of [[guest, 'Alex'], [peer, 'Sam']] as const) {
      participant.on('pageerror', error => crashes.push(error.message));
      participant.on('websocket', socket => {
        if (!new URL(socket.url()).pathname.endsWith('/lsp')) return;
        socket.on('framereceived', event => {
          try {
            const message = JSON.parse(String(event.payload));
            if (message.result?.capabilities) { lspResponses.push(message.result.capabilities); lspParticipants.add(name); }
            if (message.method === 'textDocument/publishDiagnostics') {
              for (const diagnostic of message.params.diagnostics) diagnostics.push(diagnostic.message);
            }
          } catch { /* ignore non-JSON frames */ }
        });
      });
      await participant.goto(baseURL!);
      await participant.getByLabel('面试码', { exact: false }).fill(code);
      await participant.locator('#join-name').fill(name);
      await participant.getByRole('button', { name: '进入编程空间' }).click();
      await expect(participant).toHaveURL(url => url.origin === new URL(baseURL!).origin && /^\/rooms\/[a-z2-9]{8}\/$/.test(url.pathname), { timeout: 15_000 });
      await expect(participant.getByText('main.py', { exact: true }).first()).toBeVisible({ timeout: 30_000 });
      await participant.getByText('main.py', { exact: true }).first().click();
      await expect(participant.locator('.cm-content')).toContainText('def solve', { timeout: 20_000 });
    }
    // Observe the real editor's initialize response instead of opening a competing LSP client.
    await expect.poll(() => lspParticipants.size, { timeout: 15_000 }).toBe(2);
    for (const participant of [guest, peer]) {
      await expect(participant).toHaveTitle('Codingbox · 一起思考，一起编程');
      const icons = participant.locator('link[rel="icon"]');
      await expect(icons).toHaveCount(1);
      const iconUrl = await icons.getAttribute('href');
      expect(iconUrl).toContain('codingbox.svg');
      const editorIcon = await participant.request.get(new URL(iconUrl!, participant.url()).href);
      const portalIcon = await participant.request.get(new URL('/icon.svg', baseURL!).href);
      expect(editorIcon.ok()).toBeTruthy();
      expect(await editorIcon.text()).toBe(await portalIcon.text());
      await expect(participant.getByAltText('wede', { exact: true })).toHaveCount(0);
      await expect(participant.getByTitle('Open Folder (change workspace)', { exact: true })).toHaveCount(0);
      await expect(participant.getByTitle('Add Folder to Workspace', { exact: true })).toHaveCount(0);
      await expect(participant.getByLabel('编程语言', { exact: true })).toBeEnabled();
      await expect(participant.getByRole('button', { name: '运行代码', exact: true })).toBeEnabled();
      await expect(participant.getByTitle('Source Control', { exact: true })).toHaveCount(0);
      await expect(participant.getByTitle('API Client', { exact: true })).toHaveCount(0);
      await expect(participant.getByTitle('Hide terminals', { exact: true })).toBeVisible();
      await expect(participant.getByRole('button', { name: 'Terminal 1', exact: true })).toBeVisible();
    }
    await guest.keyboard.press('ControlOrMeta+Shift+P');
    await expect(guest.getByText('Toggle Terminal', { exact: true })).toBeVisible();
    await expect(guest.getByText('Open Folder…', { exact: true })).toHaveCount(0);
    await guest.getByPlaceholder('Type a command…').press('Escape');
    await expect(guest.getByPlaceholder('Type a command…')).toHaveCount(0);
    await guest.setViewportSize({ width: 390, height: 844 });
    await expect(guest.getByRole('button', { name: 'Code', exact: true })).toBeVisible();
    await expect(guest.getByLabel('编程语言', { exact: true })).toBeEnabled();
    await expect(guest.getByRole('button', { name: '运行代码', exact: true })).toBeVisible();
    await expect(guest.getByAltText('wede', { exact: true })).toHaveCount(0);
    await expect(guest.getByTitle('Add Folder to Workspace', { exact: true })).toHaveCount(0);
    await guest.screenshot({ path: testInfo.outputPath('mobile-interview.png'), fullPage: true });
    await guest.setViewportSize({ width: 1440, height: 1000 });
    await guest.getByTitle('New Terminal', { exact: true }).click();
    await expect(peer.getByText('Terminal 2', { exact: true })).toBeVisible();
    await peer.getByText('Terminal 2', { exact: true }).dblclick();
    const rename = peer.locator('input[value="Terminal 2"]');
    await rename.fill('Shared shell'); await peer.keyboard.press('Enter');
    await expect(guest.getByText('Shared shell', { exact: true })).toBeVisible();
    await peer.getByRole('button', { name: 'Close Shared shell', exact: true }).click();
    await expect(guest.getByText('Shared shell', { exact: true })).toHaveCount(0);
    await Promise.all([guest.getByTitle('New Terminal', { exact: true }).click(), peer.getByTitle('New Terminal', { exact: true }).click()]);
    for (const participant of [guest, peer]) {
      await expect(participant.getByText('Terminal 3', { exact: true })).toBeVisible();
      await expect(participant.getByText('Terminal 4', { exact: true })).toBeVisible();
      await participant.getByText('Terminal 1', { exact: true }).click();
    }
    const terminalMarker = `shared_output_${Date.now()}`;
    await guest.locator('.xterm:visible').click();
    await guest.keyboard.type(`echo ${terminalMarker}`); await guest.keyboard.press('Enter');
    await expect(peer.locator('.xterm:visible')).toContainText(terminalMarker);
    await peer.locator('.xterm:visible').click();
    await peer.keyboard.type('echo peer_output'); await peer.keyboard.press('Enter');
    await expect(guest.locator('.xterm:visible')).toContainText('peer_output');
    await peer.reload();
    await expect(peer.getByTitle('Hide terminals', { exact: true })).toBeVisible();
    await expect(peer.getByText('Terminal 3', { exact: true })).toBeVisible();
    await expect(peer.getByText('Terminal 4', { exact: true })).toBeVisible();
    await expect(peer.locator('.xterm:visible')).toContainText(terminalMarker);
    await peer.getByTitle('Hide terminals', { exact: true }).click();
    await guest.getByTitle('Hide terminals', { exact: true }).click();
    const available = await guest.evaluate(async () => {
      const token = localStorage.getItem('codingbox:' + location.pathname.split('/')[2] + ':wede_token');
      const headers = { Authorization: token! };
      const { workspaces } = await fetch(location.pathname + 'api/workspaces', { headers }).then(r => r.json());
      return await fetch(`${location.pathname}api/workspaces/${workspaces[0].id}/lsp/available`, { headers }).then(r => r.json());
    });
    expect(available.available.python).toBeTruthy();
    const marker = `# shared_${Date.now()}`;
    await guest.locator('.cm-content').click();
    await guest.keyboard.press('ControlOrMeta+End'); await guest.keyboard.insertText(`\n${marker}\n`);
    await expect(peer.locator('.cm-content')).toContainText(marker, { timeout: 15_000 });
    const responseMarker = '# reviewed_by_Sam';
    await peer.locator('.cm-content').click(); await peer.keyboard.press('ControlOrMeta+End'); await peer.keyboard.insertText(`\n${responseMarker}\n`);
    await expect(guest.locator('.cm-content')).toContainText(responseMarker);
    await guest.locator('.cm-content').click(); await guest.keyboard.press('ControlOrMeta+End');
    await guest.keyboard.insertText('\nprint(undefined_codingbox_name)\n');
    await expect.poll(() => diagnostics.join('\n'), { timeout: 15_000 }).toContain('undefined_codingbox_name');
    // Check persisted bytes, not only the shared in-memory document.
    await expect.poll(async () => guest.evaluate(async () => {
      const headers = { Authorization: localStorage.getItem('codingbox:' + location.pathname.split('/')[2] + ':wede_token')! };
      const { workspaces } = await fetch(location.pathname + 'api/workspaces', { headers }).then(r => r.json());
      const response = await fetch(`${location.pathname}api/workspaces/${workspaces[0].id}/files/read?path=main.py`, { headers });
      return await response.text();
    })).toContain(responseMarker);
    const initialized = lspResponses.length;
    await guest.getByText('README.md', { exact: true }).click();
    await expect(guest.locator('.cm-content')).toContainText('Python interview');
    await guest.getByText('main.py', { exact: true }).first().click();
    await expect(guest.locator('.cm-content')).toContainText(responseMarker);
    await expect.poll(() => lspResponses.length, { timeout: 15_000 }).toBeGreaterThan(initialized);
    await guest.screenshot({ path: testInfo.outputPath('collaboration.png'), fullPage: true });
    await card.getByRole('button', { name: '结束', exact: true }).click();
    await page.locator('#end-dialog').getByRole('button', { name: '结束面试', exact: true }).click();
    await expect(card.locator('.status')).toHaveText('已结束', { timeout: 20_000 });
    const denied = await guestContext.request.get(guest.url());
    expect(denied.status()).toBe(410);
    const downloadPromise = page.waitForEvent('download');
    await card.getByRole('link', { name: '下载代码' }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.tar\.gz$/);
    await download.saveAs(testInfo.outputPath('interview.tar.gz'));
    expect(crashes).toEqual([]);
  } catch (error) {
    if (roomId && process.env.RUNTIME !== 'native') {
      try { console.log(execFileSync('docker', ['logs', `codingbox-${roomId}`], { encoding: 'utf8' })); } catch {}
    }
    throw error;
  } finally {
    if (roomId) await page.request.post(`/api/rooms/${roomId}/end`, { data: {} }).catch(() => {});
    await guestContext.close(); await peerContext.close();
  }
});

test('switching languages updates both browsers and preserves each project', async ({ browser, page, baseURL }) => {
  await page.request.post('/api/login', { data: { password: process.env.ADMIN_PASSWORD } });
  const created = await page.request.post('/api/rooms', { data: { title: `E2E switch ${Date.now()}`, language: 'go', minutes: 60 } });
  expect(created.status()).toBe(202);
  const { room } = await created.json();
  const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
  try {
    await expect.poll(async () => (await (await page.request.get('/api/rooms')).json()).rooms.find((r: { id: string }) => r.id === room.id).status, { timeout: 60_000 }).toBe('active');
    const participants = [];
    for (const [index, context] of contexts.entries()) {
      const joined = await context.request.post(new URL('/api/join', baseURL!).toString(), { data: { code: room.code, name: `Switcher ${index}` } });
      const participant = await context.newPage();
      await participant.goto((await joined.json()).url);
      await expect(participant.getByLabel('编程语言', { exact: true })).toHaveValue('go', { timeout: 30_000 });
      await expect(participant.locator('.cm-content')).toContainText('func solve');
      participants.push(participant);
    }
    const [guest, peer] = participants;
    await guest.locator('.cm-content').click(); await guest.keyboard.press('ControlOrMeta+End'); await guest.keyboard.insertText('\n// saved_go_edit\n');
    await expect(peer.locator('.cm-content')).toContainText('saved_go_edit');
    await guest.getByLabel('编程语言', { exact: true }).selectOption('cpp');
    for (const participant of participants) {
      await expect(participant.getByLabel('编程语言', { exact: true })).toHaveValue('cpp', { timeout: 15_000 });
      await expect(participant.locator('.cm-content')).toContainText('#include', { timeout: 15_000 });
    }
    await guest.locator('.cm-content').click(); await guest.keyboard.press('ControlOrMeta+End'); await guest.keyboard.insertText('\n// saved_cpp_edit\n');
    await expect(peer.locator('.cm-content')).toContainText('saved_cpp_edit');
    await guest.getByRole('button', { name: '运行代码', exact: true }).click();
    for (const participant of participants) {
      await expect(participant.getByText('Run · C++', { exact: true })).toBeVisible();
      await participant.getByText('Run · C++', { exact: true }).click();
      await expect(participant.locator('.xterm:visible')).toContainText('[退出码 0]', { timeout: 45_000 });
    }

    await guest.locator('.xterm:visible').click(); await guest.keyboard.type('pwd'); await guest.keyboard.press('Enter');
    await expect(guest.locator('.xterm:visible')).toContainText('/languages/cpp');
    await peer.getByLabel('编程语言', { exact: true }).selectOption('rust');
    for (const participant of participants) {
      await expect(participant.getByLabel('编程语言', { exact: true })).toHaveValue('rust', { timeout: 15_000 });
      await expect(participant.locator('.cm-content')).toContainText('fn solve', { timeout: 15_000 });
    }
    await guest.getByLabel('编程语言', { exact: true }).selectOption('go');
    for (const participant of participants) await expect(participant.locator('.cm-content')).toContainText('saved_go_edit', { timeout: 15_000 });
    await peer.getByLabel('编程语言', { exact: true }).selectOption('cpp');
    for (const participant of participants) await expect(participant.locator('.cm-content')).toContainText('saved_cpp_edit', { timeout: 15_000 });
    await guest.reload();
    await expect(guest.getByLabel('编程语言', { exact: true })).toHaveValue('cpp', { timeout: 20_000 });
    await expect(guest.locator('.cm-content')).toContainText('saved_cpp_edit', { timeout: 20_000 });
  } finally {
    await Promise.allSettled(contexts.map(context => context.close()));
    await page.request.post(`/api/rooms/${room.id}/end`, { data: {} });
  }
});

test('mobile join page fits and invalid codes show an error', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '准备好了？' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByLabel('面试码', { exact: false }).fill('ZZZZ-ZZZZ');
  await page.locator('#join-name').fill('Candidate');
  await page.getByRole('button', { name: '进入编程空间' }).click();
  await expect(page.locator('#join-error')).toContainText('面试码无效');
});

for (const language of ['python', 'typescript', 'go', 'cpp', 'rust'] as const) {
  test(`${language} starter has LSP and runs through the room terminal`, async ({ page, baseURL }) => {
    await page.request.post('/api/login', { data: { password: process.env.ADMIN_PASSWORD } });
    const created = await page.request.post('/api/rooms', { data: { title: `E2E ${language} ${Date.now()}`, language, minutes: 60 } });
    expect(created.status()).toBe(202);
    const { room } = await created.json();
    try {
      await expect.poll(async () => {
        const response = await page.request.get('/api/rooms');
        return (await response.json()).rooms.find((entry: { id: string }) => entry.id === room.id).status;
      }, { timeout: 60_000 }).toBe('active');
      const joined = await page.request.post('/api/join', { data: { code: room.code, name: 'Language check' } });
      const { url } = await joined.json();
      let initialized = false;
      let docConnections = 0;
      let docSyncs = 0;
      await page.addInitScript(() => {
        const Original = window.WebSocket;
        const sockets: WebSocket[] = [];
        Object.assign(window, { codingboxDocSockets: sockets });
        window.WebSocket = class extends Original {
          constructor(url: string | URL, protocols?: string | string[]) {
            super(url, protocols);
            if (String(url).includes('/doc/')) sockets.push(this);
          }
        };
      });
      page.on('websocket', socket => {
        if (new URL(socket.url()).pathname.includes('/doc/')) {
          docConnections++;
          socket.on('framereceived', ({ payload }) => {
            if (Buffer.isBuffer(payload) && payload[0] === 0 && payload[1] === 1) docSyncs++;
          });
        }
        if (!new URL(socket.url()).pathname.endsWith('/lsp')) return;
        socket.on('framereceived', event => {
          try { if (JSON.parse(String(event.payload)).result?.capabilities) initialized = true; } catch {}
        });
      });
      await page.goto(url);
      const filename = { python: 'main.py', go: 'main.go', typescript: 'main.ts', cpp: 'main.cpp', rust: 'main.rs' }[language];
      await page.getByText(filename, { exact: true }).first().click();
      await expect(page.locator('.cm-content')).toContainText('solve');
      await expect.poll(() => initialized, { timeout: 30_000 }).toBe(true);
      const original = await page.locator('.cm-content').innerText();
      for (let i = 0; i < 2; i++) {
        const connections = docConnections;
        const syncs = docSyncs;
        await page.evaluate(() => {
          const sockets = (window as unknown as { codingboxDocSockets: WebSocket[] }).codingboxDocSockets;
          sockets.at(-1)!.close();
        });
        await expect.poll(() => docConnections, { timeout: 15_000 }).toBeGreaterThan(connections);
        await expect.poll(() => docSyncs, { timeout: 15_000 }).toBeGreaterThan(syncs);
        await expect.poll(() => page.locator('.cm-content').innerText()).toBe(original);
      }
      await page.reload();
      await expect(page.locator('.cm-content')).toContainText('solve');
      await expect.poll(() => page.locator('.cm-content').innerText()).toBe(original);
      // Edit and immediately run: the button must wait for CRDT disk persistence.
      await page.locator('.cm-content').click();
      await page.keyboard.press('ControlOrMeta+A');
      await page.keyboard.insertText(original.replace('1, 2, 3', '1, 2, 30'));
      await page.getByRole('button', { name: '运行代码', exact: true }).click();
      await expect(page.locator('.xterm:visible')).toContainText('[退出码 0]', { timeout: 45_000 });
      await expect(page.locator('.xterm:visible')).toContainText('33');
      await expect(page.getByTitle('Open Browser Preview', { exact: true })).toHaveCount(0);
      const runTab = page.getByRole('button', { name: /^Run · / });
      await expect(runTab).toHaveCount(1);
      // Reload reattaches the existing session without rerunning the command.
      await page.reload();
      await expect(runTab).toHaveCount(1);

      if (language === 'python') {
        await page.locator('.cm-content').click();
        await page.keyboard.press('ControlOrMeta+A');
        await page.keyboard.insertText('name = input("Your name: ")\nprint("Hello " + name)\nraise SystemExit(7)\n');
        await page.getByRole('button', { name: '运行代码', exact: true }).click();
        await expect(runTab).toHaveCount(2);
        await expect(page.locator('.xterm:visible')).toContainText('Your name:');
        await page.locator('.xterm:visible').click();
        await page.keyboard.type('Candidate'); await page.keyboard.press('Enter');
        await expect(page.locator('.xterm:visible')).toContainText('Hello Candidate');
        await expect(page.locator('.xterm:visible')).toContainText('[退出码 7]');
      }

    } finally { await page.request.post(new URL(`/api/rooms/${room.id}/end`, baseURL!).toString(), { data: {} }); }
  });
}

test('one origin supports two room tabs with independent state and shared peers', async ({ browser, page, baseURL }) => {
  await page.request.post('/api/login', { data: { password: process.env.ADMIN_PASSWORD } });
  const rooms: { id: string; code: string }[] = [];
  const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
  try {
    for (let i = 0; i < 2; i++) {
      const created = await page.request.post('/api/rooms', { data: { title: `Same-origin ${Date.now()} ${i}`, language: 'python', minutes: 60 } });
      expect(created.status()).toBe(202); rooms.push((await created.json()).room);
    }
    await expect.poll(async () => {
      const listed = (await (await page.request.get('/api/rooms')).json()).rooms;
      return rooms.filter(room => listed.find((r: { id: string; status: string }) => r.id === room.id)?.status === 'active').length;
    }, { timeout: 60_000 }).toBe(2);
    const pairs = [];
    const rootApiRequests: string[] = [];
    const initialized = new Set<string>();
    for (const [i, room] of rooms.entries()) {
      const pair = [];
      for (const [j, context] of contexts.entries()) {
        const joined = await context.request.post(new URL('/api/join', baseURL!).toString(), { data: { code: room.code, name: `Participant ${j}` } });
        expect(joined.ok()).toBe(true);
        const participant = await context.newPage();
        participant.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/')) rootApiRequests.push(request.url()); });
        participant.on('websocket', socket => {
          if (!new URL(socket.url()).pathname.endsWith('/lsp')) return;
          socket.on('framereceived', event => {
            try { if (JSON.parse(String(event.payload)).result?.capabilities) initialized.add(`${i}:${j}`); } catch {}
          });
        });
        await participant.goto((await joined.json()).url);
        await expect(participant.locator('.cm-content')).toContainText('def solve', { timeout: 30_000 });
        pair.push(participant);
      }
      pairs.push(pair);
    }
    await expect.poll(() => initialized.size, { timeout: 30_000 }).toBe(4);
    const markers = rooms.map((room, i) => `room_${i}_${room.id.replaceAll('-', '')}`);
    // A browser context has one focused tab; type sequentially, then run both rooms concurrently.
    for (const [i, [guest, peer]] of pairs.entries()) {
      await guest.bringToFront();
      await guest.locator('.cm-content').click(); await guest.keyboard.press('ControlOrMeta+A');
      await guest.keyboard.insertText(`print("${markers[i]}")\n`);
      await expect(peer.locator('.cm-content')).toContainText(markers[i]);
    }
    await Promise.all(pairs.map(async ([guest, peer], i) => {
      await guest.getByRole('button', { name: '运行代码', exact: true }).click();
      await expect(guest.locator('.xterm:visible')).toContainText('[退出码 0]', { timeout: 30_000 });
      await peer.getByText('Run · Python', { exact: true }).click();
      await expect(peer.locator('.xterm:visible')).toContainText(markers[i]);
    }));
    const token = (participant: typeof page) => participant.evaluate(() => localStorage.getItem('codingbox:' + location.pathname.split('/')[2] + ':wede_token'));
    const before = await Promise.all(pairs.map(([guest]) => token(guest)));
    expect(before[0]).toBeTruthy(); expect(before[1]).toBeTruthy(); expect(before[0]).not.toBe(before[1]);
    await pairs[0][0].getByTitle('Light mode', { exact: true }).click();
    await expect(pairs[0][0].locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(pairs[1][0].locator('html')).toHaveAttribute('data-theme', 'dark');
    await pairs[0][0].reload();
    await expect(pairs[0][0].locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(pairs[0][0].locator('.cm-content')).toContainText(markers[0]);
    expect(await token(pairs[1][0])).toBe(before[1]);
    await pairs[0][0].getByLabel('编程语言', { exact: true }).selectOption('go');
    for (const participant of pairs[0]) await expect(participant.locator('.cm-content')).toContainText('func solve', { timeout: 20_000 });
    await pairs[1][0].reload();
    await expect(pairs[1][0].getByLabel('编程语言', { exact: true })).toHaveValue('python');
    await expect(pairs[1][0].locator('.cm-content')).toContainText(markers[1]);
    await pairs[0][0].getByLabel('编程语言', { exact: true }).selectOption('python');
    await expect(pairs[0][0].locator('.cm-content')).toContainText(markers[0], { timeout: 20_000 });
    await page.request.post(`/api/rooms/${rooms[0].id}/end`, { data: {} });
    expect((await contexts[0].request.get(pairs[0][0].url())).status()).toBe(410);
    await pairs[1][0].reload();
    await expect(pairs[1][0].locator('.cm-content')).toContainText(markers[1]);
    expect(rootApiRequests).toEqual([]);
  } finally {
    await Promise.allSettled(contexts.map(context => context.close()));
    for (const room of rooms) await page.request.post(`/api/rooms/${room.id}/end`, { data: {} });
  }
});
