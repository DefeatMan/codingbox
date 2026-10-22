import { useCallback, useEffect, useRef, useState } from 'react'
import { roomBase, roomPath } from '../roomScope'
import type { ChatMessage } from '../types'

type Status = 'loading' | 'ready' | 'reconnecting' | 'error'
const cache = new Map<string, ChatMessage[]>()

export function useChat(
  _workspaceId: string | null | undefined,
  token: string | null | undefined,
  username: string | null | undefined,
  color: string | null | undefined,
  channel = 'public',
) {
  const key = `${roomBase}:${channel}:${token || ''}`
  const [messages, setMessages] = useState<ChatMessage[]>(() => cache.get(key) || [])
  const [status, setStatus] = useState<Status>('loading')
  const wsRef = useRef<WebSocket | null>(null)
  const ready = useRef(false)

  useEffect(() => {
    setMessages(cache.get(key) || [])
    setStatus('loading')
    ready.current = false
    if (!token) return
    let disposed = false
    let failures = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const publish = (next: ChatMessage[]) => { cache.set(key, next); setMessages(next) }
    const connect = () => {
      if (disposed) return
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
      const host = ['5173', '5174'].includes(location.port) ? location.hostname + ':9090' : location.host
      const url = `${proto}//${host}${roomPath('/api/interview/chat')}?channel=${encodeURIComponent(channel)}&color=${encodeURIComponent(color || '#888888')}`
      const ws = new WebSocket(url, [`auth.${token}`])
      wsRef.current = ws
      ws.onmessage = event => {
        if (disposed || wsRef.current !== ws) return
        try {
          const frame = JSON.parse(event.data)
          if (frame.type === 'history' && Array.isArray(frame.messages)) {
            publish(frame.messages)
            failures = 0
            ready.current = true
            setStatus('ready')
          } else if (frame.type === 'msg' && frame.message) {
            publish([...(cache.get(key) || []), frame.message])
          } else if (frame.type === 'activity' && Array.isArray(frame.messages)) {
            const current = cache.get(key) || []
            // Legacy user IDs use second-precision timestamps and can collide.
            // Only Git events have a stable identity suitable for deduplication.
            const activity = new Map(current.filter(message => message.kind === 'git').map(message => [message.id, message]))
            for (const message of frame.messages as ChatMessage[]) activity.set(message.id, message)
            const combined = [...current.filter(message => message.kind !== 'git'), ...activity.values()]
            publish(combined.sort((a, b) => (Date.parse(a.time || '') || 0) - (Date.parse(b.time || '') || 0)))
          }
        } catch { /* ignore malformed frames without discarding current messages */ }
      }
      ws.onerror = () => { /* close handles reconnect and state */ }
      ws.onclose = () => {
        if (disposed || wsRef.current !== ws) return
        wsRef.current = null
        ready.current = false
        failures++
        setStatus(failures >= 3 ? 'error' : 'reconnecting')
        timer = setTimeout(connect, Math.min(250 * 2 ** (failures - 1), 3000))
      }
    }
    connect()
    return () => {
      disposed = true
      ready.current = false
      clearTimeout(timer)
      const ws = wsRef.current
      wsRef.current = null
      ws?.close()
    }
  }, [key, token, username, color, channel])

  const sendMessage = useCallback((text: string | null | undefined): boolean => {
    const ws = wsRef.current
    if (!ready.current || !ws || ws.readyState !== WebSocket.OPEN || !text?.trim()) return false
    try { ws.send(JSON.stringify({ type: 'msg', text })); return true }
    catch { return false }
  }, [])

  return { messages, sendMessage, status }
}
