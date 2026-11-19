export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void
  info(message: string, fields?: Record<string, unknown>): void
  warn(message: string, fields?: Record<string, unknown>): void
  error(message: string, fields?: Record<string, unknown>): void
}

export interface Span {
  readonly traceparent?: string
}

const REDACTED_KEYS = /token|authorization|credential|secret|password|geometry|capture|image|payload/i

function sanitize(fields: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!fields) return undefined
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [key, REDACTED_KEYS.test(key) ? '[REDACTED]' : value])
  )
}

export function createLogger(component: string): Logger {
  const emit = (level: string, message: string, fields?: Record<string, unknown>) => {
    console.error(JSON.stringify({ level, component, message, ...sanitize(fields) }))
  }
  return {
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields)
  }
}

export async function initTelemetry(_options?: { serviceName?: string }): Promise<void> {}

export async function withSpan<T>(
  _name: string,
  _attributes: Record<string, string | number | boolean>,
  run: (span: Span) => Promise<T>
): Promise<T> {
  return run({})
}

export function traceparentOf(span: Span): string | undefined {
  return span.traceparent
}
