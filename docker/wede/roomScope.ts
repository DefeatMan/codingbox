// Room paths separate navigation and persisted UI state on one public origin.
// This is a routing namespace, not a browser security boundary.
const match = /^\/rooms\/([a-z2-9]{8})(?:\/|$)/i.exec(window.location.pathname)
export const roomBase = match ? `/rooms/${match[1].toLowerCase()}` : ''
const storagePrefix = match ? `codingbox:${match[1].toLowerCase()}:` : ''

export const roomStorage = {
  getItem: (key: string) => window.localStorage.getItem(storagePrefix + key),
  setItem: (key: string, value: string) => window.localStorage.setItem(storagePrefix + key, value),
  removeItem: (key: string) => window.localStorage.removeItem(storagePrefix + key),
}

export function roomPath(path: string): string {
  if (!roomBase || !path.startsWith('/') || path.startsWith('//') || path === roomBase || path.startsWith(roomBase + '/')) return path
  return roomBase + path
}

export const roomFetch: typeof window.fetch = (input, init) =>
  window.fetch(typeof input === 'string' ? roomPath(input) : input, init)

if (roomBase) {
  if (!roomStorage.getItem('wede_theme')) roomStorage.setItem('wede_theme', 'dark')
  let settings: Record<string, unknown> = { fontSize: 14, tabWidth: 2, wordWrap: false, autoSave: true, minimap: false, formatOnSave: false }
  try { settings = { ...settings, ...JSON.parse(roomStorage.getItem('wede_editor_settings') || '{}') } } catch { /* use defaults */ }
  roomStorage.setItem('wede_editor_settings', JSON.stringify({ ...settings, collab: true, lsp: true }))
  const params = new URLSearchParams(window.location.search)
  const name = params.get('name')?.trim()
  if (name && new TextEncoder().encode(name).length <= 32) roomStorage.setItem('wede_username', name)
  if (params.has('name')) {
    params.delete('name')
    const query = params.toString()
    history.replaceState(null, '', window.location.pathname + (query ? '?' + query : '') + window.location.hash)
  }
}
