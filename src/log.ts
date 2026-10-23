export interface FailureEvent {
  operation: string;
  startedAt: number;
  error: unknown;
  roomId?: string;
  roomIds?: string[];
  outcome?: 'failed' | 'cancelled';
}
export interface LogRecord {
  time: string;
  level: 'error' | 'info';
  operation: string;
  durationMs: number;
  roomId?: string;
  roomIds?: string[];
  outcome: 'failed' | 'cancelled';
  error: { name: string; message: string; code?: string | number; signal?: string; stderr?: string };
}
export type Logger = (event: FailureEvent) => void;

// Child-process errors can contain commands and credentials. Only emit bounded,
// allowlisted fields; never serialize request headers, bodies or entire errors.
export function createLogger(
  secrets: () => string[] = () => [],
  sink: (record: LogRecord) => void = record => console.error(JSON.stringify(record)),
): Logger {
  return event => {
    try {
      const known = secrets().filter(Boolean).sort((a, b) => b.length - a.length);
      const redact = (value: string) => {
        for (const secret of known) value = value.replaceAll(secret, '[REDACTED]');
        return value
          .replace(/\b(authorization|proxy-authorization|cookie|set-cookie)\s*[:=][^\r\n]*/gi, '$1=[REDACTED]')
          .replace(/\b([\w-]*(?:password|token|secret)|api[_-]?key)(["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&]+)/gi, '$1$2[REDACTED]')
          .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
          .slice(0, 4096);
      };
      const error = event.error instanceof Error ? event.error : new Error(String(event.error));
      const extra = error as Error & { code?: unknown; signal?: unknown; stderr?: unknown };
      const outcome = event.outcome ?? 'failed';
      sink({
        time: new Date().toISOString(), level: outcome === 'cancelled' ? 'info' : 'error',
        operation: event.operation, durationMs: Math.max(0, Date.now() - event.startedAt), outcome,
        ...(event.roomId ? { roomId: event.roomId } : {}),
        ...(event.roomIds ? { roomIds: event.roomIds } : {}),
        error: {
          name: redact(error.name), message: redact(error.message),
          ...(typeof extra.code === 'string' ? { code: redact(extra.code) } : typeof extra.code === 'number' ? { code: extra.code } : {}),
          ...(typeof extra.signal === 'string' ? { signal: redact(extra.signal) } : {}),
          ...(typeof extra.stderr === 'string' ? { stderr: redact(extra.stderr) } : {}),
        },
      });
    } catch { /* diagnostics must not interrupt cleanup or replace the original error */ }
  };
}
