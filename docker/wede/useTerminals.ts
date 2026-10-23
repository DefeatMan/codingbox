// The workspace server owns terminal identities and metadata across browsers.
import { useState, useCallback, useEffect, useRef } from 'react'
import { workspaceUrl } from '../api'
import type { AuthFetch, TerminalSession, TerminalHandle } from '../types'

export interface UseTerminalsSync { sendTerminals?: unknown; onTerminals?: unknown }

export function useTerminals(authFetch: AuthFetch | null | undefined, workspaceId: string | null | undefined, _sync: UseTerminalsSync = {}) {
  const [manualTerminals, setTerminals] = useState<TerminalSession[]>([])
  const [runTerminal, setRunTerminal] = useState<TerminalSession | null>(null)
  const runState = useRef<TerminalSession | null>(null)
  const runRevision = useRef(-1)
  const runInstance = useRef('')
  const [activeId, setActiveId] = useState(1)
  const termRefs = useRef<Record<number, TerminalHandle>>({})
  const initialCommands = useRef(new Map<number, string>())
  const revision = useRef(-1)
  const instance = useRef('')
  const retiredInstances = useRef(new Set<string>())
  const endpoint = workspaceId ? workspaceUrl(workspaceId, '/terminal/sessions') : ''
  const scope = useRef({ endpoint })
  if (scope.current.endpoint !== endpoint) scope.current = { endpoint }
  const apply = useCallback((data: { instance?: string; revision: number; terminals: TerminalSession[] }, created?: { id: number; initial?: string }) => {
    const nextInstance = data.instance || ''
    if (!Array.isArray(data.terminals) || retiredInstances.current.has(nextInstance)) return false
    if (nextInstance === instance.current && data.revision < revision.current) return false
    if (nextInstance !== instance.current) {
      retiredInstances.current.add(instance.current)
      instance.current = nextInstance
      initialCommands.current.clear()
    } else if (data.revision === revision.current && !created?.initial) return true
    if (created?.initial) initialCommands.current.set(created.id, created.initial)
    revision.current = data.revision
    setTerminals(data.terminals.map(t => ({ ...t, initial: initialCommands.current.get(t.id) })))
    setActiveId(current => (current === 0 && runState.current) || data.terminals.some(t => t.id === current) ? current : (data.terminals[0]?.id ?? 1))
    return true
  }, [])

  useEffect(() => {
    if (!authFetch || !endpoint) return
    let disposed = false
    let timer: ReturnType<typeof setTimeout>
    revision.current = -1
    instance.current = ''
    retiredInstances.current.clear()
    initialCommands.current.clear()
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

  const applyRun = useCallback((data: { instance: string; revision: number; terminal: TerminalSession | null }) => {
    if (data.instance === runInstance.current && data.revision <= runRevision.current) return
    runInstance.current = data.instance
    runRevision.current = data.revision
    runState.current = data.terminal
    setRunTerminal(data.terminal)
    if (data.terminal) setActiveId(0)
    else setActiveId(current => current === 0 ? 1 : current)
  }, [])

  useEffect(() => {
    if (!authFetch) return
    let disposed = false
    let timer: ReturnType<typeof setTimeout>
    runRevision.current = -1
    const poll = async () => {
      try {
        const response = await authFetch('/api/interview/terminal/sessions')
        if (response.ok && !disposed) {
          const data = await response.json()
          if (!disposed) applyRun(data)
        }
      } catch { /* retry while the room reconnects */ }
      if (!disposed) timer = setTimeout(poll, 500)
    }
    void poll()
    return () => { disposed = true; clearTimeout(timer) }
  }, [authFetch, applyRun])

  const mutate = useCallback(async (operation: Record<string, unknown>, initial?: string) => {
    if (!authFetch || !endpoint) return
    const requestScope = scope.current
    try {
      const response = await authFetch(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(operation),
      })
      if (!response.ok || scope.current !== requestScope) return
      const data = await response.json()
      if (scope.current !== requestScope) return
      if (!apply(data, operation.op === 'add' ? { id: data.createdId, initial } : undefined)) return
      if (operation.op === 'add') {
        setActiveId(data.createdId)
      }
    } catch { /* retain the last confirmed server state */ }
  }, [authFetch, endpoint, apply])

  const addTerminal = useCallback((name?: string, initial?: string) => { void mutate({ op: 'add', name }, initial) }, [mutate])
  const closeTerminal = useCallback((id: number) => {
    if (id !== 0) { void mutate({ op: 'close', id }); return }
    if (!authFetch) return
    void authFetch('/api/interview/terminal/sessions', { method: 'DELETE' }).then(async response => {
      if (response.ok) applyRun(await response.json())
    }).catch(() => { /* retain last server state */ })
  }, [mutate, authFetch, applyRun])
  const renameTerminal = useCallback((id: number, name: string | null | undefined) => {
    if (id !== 0 && name?.trim()) void mutate({ op: 'rename', id, name: name.trim() })
  }, [mutate])
  const clearInitial = useCallback((id: number) => {
    initialCommands.current.delete(id)
    setTerminals(prev => prev.map(t => t.id === id ? { ...t, initial: undefined } : t))
  }, [])
  const autoNameTerminal = useCallback((_id: number, _title: string | null | undefined) => {}, [])
  const terminals = runTerminal ? [...manualTerminals, runTerminal] : manualTerminals
  const runGeneration = runTerminal?.runSession || ''
  return { terminals, runGeneration, activeId, setActiveId, addTerminal, closeTerminal, clearInitial, renameTerminal, autoNameTerminal, termRefs }
}
