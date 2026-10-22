import { createRoom } from './helpers.ts';
import 'dotenv/config';
import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

test('ongoing pagination keeps rooms beyond the first page reachable', async ({ page }) => {
  await page.route('**/api/session', route => route.fulfill({ json: { admin: true } }));
  await page.route('**/api/rooms?*', route => {
    const pageNumber = Number(new URL(route.request().url()).searchParams.get('page'));
    const start = pageNumber === 2 ? 10 : 0;
    const rooms = Array.from({ length: pageNumber === 2 ? 1 : 10 }, (_, index) => ({
      id: `fixture-${start + index}`, title: `Ongoing ${start + index}`, status: 'error',
      code: 'ABCD-2345', createdAt: 1, endedAt: null, error: '测试实例尚未就绪',
    }));
    return route.fulfill({ json: { rooms, page: pageNumber, pages: 2, total: 11, counts: { ongoing: 11, completed: 0 } } });
  });
  await page.goto('/');
  await expect(page.locator('.room-card')).toHaveCount(10);
  await expect(page.getByRole('button', { name: '下一页' })).toBeVisible();
  await page.getByRole('button', { name: '下一页' }).click();
  await expect(page.locator('.room-card')).toHaveCount(1);
  await expect(page.getByRole('heading', { name: 'Ongoing 10', exact: true })).toBeVisible();
});

test('interview history supports search, pages, selection, export and permanent deletion', async ({ page, browser }, testInfo) => {
  test.setTimeout(300_000);
  const prefix = `History-${Date.now()}`;
  const ids: string[] = [];
  await page.goto('/');
  await page.getByRole('button', { name: '面试官入口' }).click();
  await page.getByLabel('面试官密码', { exact: true }).fill(process.env.ADMIN_PASSWORD!);
  await page.getByRole('button', { name: '登录工作台' }).click();
  await expect(page.getByRole('tab', { name: /进行中/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#create-form select[name="language"]')).toHaveCount(0);
  const peerContext = await browser.newContext();
  try {
    await page.getByLabel('面试名称').fill(prefix + ' Candidate');
    await page.getByRole('button', { name: '创建编程空间' }).click();
    const active = page.locator('.room-card').filter({ hasText: prefix + ' Candidate' });
    await expect(active.locator('.status')).toHaveText('进行中', { timeout: 60_000 });
    const id = (await active.getAttribute('data-room-id'))!; ids.push(id);
    const room = (await (await page.request.get('/api/rooms')).json()).rooms.find((r: { id: string }) => r.id === id);
    expect(room.language).toBe('python');
    const peer = await peerContext.newPage(); await peer.goto(room.joinUrl);
    await expect(peer.getByLabel('编程语言', { exact: true })).toHaveValue('python', { timeout: 30_000 });
    await peer.getByLabel('编程语言', { exact: true }).selectOption('rust');
    await expect(peer.getByLabel('编程语言', { exact: true })).toHaveValue('rust');
    await active.getByRole('button', { name: '结束', exact: true }).click();
    await page.locator('#end-dialog').getByRole('button', { name: '结束面试', exact: true }).click();
    await expect(page.getByRole('tab', { name: /已完成/ })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator(`[data-room-id="${id}"]`)).toBeVisible();
    // Eleven real records cross the default ten-row page boundary without requiring concurrent rooms.
    for (let i = 0; i < 10; i++) {
      const response = await createRoom(page.request, { title: `${prefix} Record ${i}`, minutes: 60 });
      expect(response.status()).toBe(202);
      const created = (await response.json()).room; ids.push(created.id);
      expect((await page.request.post(`/api/rooms/${created.id}/end`, { data: {} })).ok()).toBeTruthy();
    }
    await page.getByLabel('查询面试记录').fill(prefix);
    await page.getByRole('button', { name: '查询', exact: true }).click();
    await expect(page.locator('#page-info')).toHaveText('第 1 / 2 页 · 共 11 条');
    await expect(page.locator('.room-card')).toHaveCount(10);
    await page.getByLabel('全选本页').check();
    await expect(page.locator('#selection-count')).toHaveText('已选 10 项');
    await page.screenshot({ path: testInfo.outputPath('history-records.png'), fullPage: true });
    await page.getByRole('button', { name: '下一页' }).click();
    await expect(page.locator('#selection-count')).toHaveText('已选 0 项');
    await expect(page.locator('.room-card')).toHaveCount(1);
    await page.getByLabel('全选本页').check();
    const downloadEvent = page.waitForEvent('download');
    await page.getByRole('button', { name: '下载所选' }).click();
    const download = await downloadEvent;
    const file = testInfo.outputPath('history-bundle.tar.gz'); await download.saveAs(file);
    const manifest = JSON.parse(execFileSync('tar', ['-xOzf', file, 'manifest.json'], { encoding: 'utf8' }));
    expect(manifest.rooms).toHaveLength(1);
    const inner = `codingbox-${manifest.rooms[0].code}.tar.gz`;
    const innerFile = testInfo.outputPath(inner);
    execFileSync('tar', ['-xzf', file, '-C', testInfo.outputDir, inner]);
    expect(execFileSync('tar', ['-tzf', innerFile], { encoding: 'utf8' })).toContain('main.py');
    expect(readFileSync(file).length).toBeGreaterThan(0);
    await page.getByRole('button', { name: '删除所选' }).click();
    await page.locator('#delete-dialog').getByLabel('关闭', { exact: true }).click();
    await expect(page.locator('.room-card')).toHaveCount(1);
    await page.getByRole('button', { name: '删除所选' }).click();
    await page.getByRole('button', { name: '确认删除' }).click();
    await expect(page.locator('#page-info')).toHaveText('第 1 / 1 页 · 共 10 条');
    await page.getByLabel('全选本页').check();
    const bundleEvent = page.waitForEvent('download');
    await page.getByRole('button', { name: '下载所选' }).click();
    const bundle = await bundleEvent; await bundle.saveAs(testInfo.outputPath('ten-interviews.tar.gz'));
    await page.getByRole('button', { name: '删除所选' }).click();
    await page.getByRole('button', { name: '确认删除' }).click();
    await expect(page.getByText('没有找到匹配的面试', { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('history-empty.png'), fullPage: true });
    for (const deleted of ids) {
      expect((await page.request.get(`/api/rooms/${deleted}/archive`)).status()).toBe(404);
      if (process.env.RUNTIME !== 'native') {
        expect(() => execFileSync('docker', ['volume', 'inspect', `codingbox-${deleted}`], { stdio: 'pipe' })).toThrow();
      }
    }
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally {
    await peerContext.close();
    const remaining = (await (await page.request.get('/api/rooms')).json()).rooms.filter((r: { id: string }) => ids.includes(r.id));
    for (const r of remaining) if (r.status !== 'ended') await page.request.post(`/api/rooms/${r.id}/end`, { data: {} });
    if (remaining.length) await page.request.post('/api/rooms/batch-delete', { data: { ids: remaining.map((r: { id: string }) => r.id) } });
  }
});
