import type { CapabilityResultMessage } from '@arcdio/cad-protocol'

/**
 * Tracks in-flight `capability.execute` calls by requestId so out-of-order `capability.result`
 * frames resolve the right caller. See AUTOCAD_MCP_PROJECT.md section 9, "Request / Response
 * Correlation".
 */
export class RequestCorrelator {
  private readonly pending = new Map<
    string,
    {
      resolve: (msg: CapabilityResultMessage) => void
      reject: (err: Error) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()

  await(requestId: string, timeoutMs: number): Promise<CapabilityResultMessage> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(
          new Error(
            `Timed out waiting ${timeoutMs}ms for capability.result (requestId=${requestId})`
          )
        )
      }, timeoutMs)
      this.pending.set(requestId, { resolve, reject, timer })
    })
  }

  resolve(message: CapabilityResultMessage): boolean {
    const entry = this.pending.get(message.requestId)
    if (!entry) return false
    clearTimeout(entry.timer)
    this.pending.delete(message.requestId)
    entry.resolve(message)
    return true
  }

  /**
   * Called when the owning device connection drops — fails every request it still owed an answer
   * to.
   */
  rejectAll(requestIds: Iterable<string>, reason: Error): void {
    for (const requestId of requestIds) {
      const entry = this.pending.get(requestId)
      if (!entry) continue
      clearTimeout(entry.timer)
      this.pending.delete(requestId)
      entry.reject(reason)
    }
  }
}
