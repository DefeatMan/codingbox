import type { APIRequestContext } from '@playwright/test';

// Large history fixtures share the production create limit with starter tests.
export async function createRoom(request: APIRequestContext, data: Record<string, unknown>) {
  const response = await request.post('/api/rooms', { data });
  if (response.status() !== 429) return response;
  const seconds = Number(response.headers()['retry-after']);
  if (!Number.isFinite(seconds) || seconds < 1 || seconds > 60) return response;
  await new Promise(resolve => setTimeout(resolve, seconds * 1000));
  return request.post('/api/rooms', { data });
}
