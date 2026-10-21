// The workspace server owns terminal identities and metadata across browsers.
import { useState, useCallback, useEffect, useRef } from 'react'
import { workspaceUrl } from '../api'
import type { AuthFetch, TerminalSession, TerminalHandle } from '../types'

export interface UseTerminalsSync { sendTerminals?: unknown; onTerminals?: unknown }

export function useTerminals(authFetch: AuthFetch | null | undefined, workspaceId: string | null | undefined, _sync: UseTerminalsSync = {}) {
  const [terminals, setTerminals] = useState<TerminalSession[]>([])
  const [activeId, setActiveId] = useState(1)
  const termRefs = useRef<Record<number, TerminalHandle>>({})
  const initialCommands = useRef(new Map<number, string>())
  const revision = useRef(-1)
  const endpoint = workspaceId ? workspaceUrl(workspaceId, '/terminal/sessions') : ''
  const apply = useCallback((data: { revision: number; terminals: TerminalSession[] }) => {
    if (!Array.isArray(data.terminals) || data.revision <= revision.current) return
    revision.current = data.revision
    setTerminals(data.terminals.map(t => ({ ...t, initial: initialCommands.current.get(t.id) })))
    setActiveId(current => data.terminals.some(t => t.id === current) ? current : (data.terminals[0]?.id ?? 1))
  }, [])

  useEffect(() => {
    if (!authFetch || !endpoint) return
    let disposed = false
    let timer: ReturnType<typeof setTimeout>
    revision.current = -1
    const poll = async () => {
      try {
        const response = await authFetch(endpoint)
        if (response.ok && !disposed) {
          const data = await response.json()
          if (!disposed) apply(data)
        }
      } catch { /* next poll retries */ }
      if (!disposed) timer = setTimeout(poll, 500)
    }
    void poll()
    return () => { disposed = true; clearTimeout(timer) }
  }, [authFetch, endpoint, apply])

  const mutate = useCallback(async (operation: Record<string, unknown>, initial?: string) => {
    if (!authFetch || !endpoint) return
    try {
      const response = await authFetch(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(operation),
      })
      if (!response.ok) return
      const data = await response.json()
      if (operation.op === 'add') {
        if (initial) initialCommands.current.set(data.createdId, initial)
        setActiveId(data.createdId)
      }
      apply(data)
    } catch { /* retain the last confirmed server state */ }
  }, [authFetch, endpoint, apply])

  const addTerminal = useCallback((name?: string, initial?: string) => { void mutate({ op: 'add', name }, initial) }, [mutate])
  const closeTerminal = useCallback((id: number) => { void mutate({ op: 'close', id }) }, [mutate])
  const renameTerminal = useCallback((id: number, name: string | null | undefined) => {
    if (name?.trim()) void mutate({ op: 'rename', id, name: name.trim() })
  }, [mutate])
  const clearInitial = useCallback((id: number) => {
    initialCommands.current.delete(id)
    setTerminals(prev => prev.map(t => t.id === id ? { ...t, initial: undefined } : t))
  }, [])
  const autoNameTerminal = useCallback((_id: number, _title: string | null | undefined) => {}, [])
  return { terminals, activeId, setActiveId, addTerminal, closeTerminal, clearInitial, renameTerminal, autoNameTerminal, termRefs }
}
