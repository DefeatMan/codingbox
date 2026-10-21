import { useEffect, useRef, useState } from 'react'
import type { AuthFetch } from '../types'

export interface LanguageSelection {
  language: string
  revision: number
  workspaceId: string
  entry: string
  command: string
}
export default function InterviewLanguage({ authFetch, readOnly, onActivate, onRun }: {
  authFetch: AuthFetch
  readOnly: boolean
  onActivate: (selection: LanguageSelection) => Promise<void>
  onRun: (selection: LanguageSelection) => Promise<void>
}) {
  const [selection, setSelection] = useState<LanguageSelection | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const current = useRef<LanguageSelection | null>(null)
  const pending = useRef<Promise<void>>(Promise.resolve())
  const activate = useRef(onActivate)
  activate.current = onActivate
  const apply = useRef(async (_data: LanguageSelection) => {})
  apply.current = async data => {
    if (current.current && data.revision < current.current.revision) return
    const previous = current.current
    const changed = !previous || previous.revision !== data.revision || previous.workspaceId !== data.workspaceId
    current.current = data
    setSelection(data)
    if (changed) {
      const task = pending.current.then(async () => {
        if (current.current?.revision !== data.revision || current.current.workspaceId !== data.workspaceId) return
        await activate.current(data)
      })
      pending.current = task.catch(() => {})
      try { await task; setError('') }
      catch {
        if (current.current === data) current.current = previous
        setError('打开项目失败，请重试')
      }
    }
  }
  useEffect(() => {
    let disposed = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const response = await authFetch('/api/interview/language')
        if (response.ok && !disposed) {
          const data = await response.json()
          if (!disposed) await apply.current(data)
        }
      } catch { /* transient network failure; retry */ }
      if (!disposed) timer = setTimeout(poll, 1200)
    }
    void poll()
    return () => { disposed = true; clearTimeout(timer) }
  }, [authFetch])

  const change = async (language: string) => {
    setBusy(true); setError('')
    try {
      const response = await authFetch('/api/interview/language', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ language }),
      })
      if (!response.ok) throw Error()
      await apply.current(await response.json())
    } catch { setError('切换失败，请重试') }
    finally { setBusy(false) }
  }
  return <div className="flex items-center gap-2 text-[12px]">
    <select aria-label="编程语言" title={selection?.command || '编程语言'} disabled={busy || readOnly || !selection}
      value={selection?.language || ''} onChange={event => { void change(event.target.value) }}
      className="bg-bg-secondary border border-border rounded px-2 py-1 text-text-primary disabled:opacity-50">
      {!selection && <option value="">加载语言…</option>}
      <option value="python">Python</option><option value="typescript">TypeScript</option>
      <option value="go">Go</option><option value="cpp">C++</option><option value="rust">Rust</option>
    </select>
    <button aria-label="运行代码" title={selection?.command || '运行代码'}
      disabled={busy || readOnly || !selection} className="rounded bg-green/15 text-green px-3 py-1 disabled:opacity-50"
      onClick={() => {
        if (!selection || busy) return
        setBusy(true); setError('')
        void onRun(selection).catch(error => setError(error instanceof Error ? error.message : '运行失败，请重试'))
          .finally(() => setBusy(false))
      }}>{busy ? '处理中…' : '▶ Run'}</button>
    {error && <span role="alert" className="text-red">{error}</span>}
  </div>
}
