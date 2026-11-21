import type { Server, ServerWebSocket } from 'bun'
import {
  DEVICE_PROTOCOL_VERSION,
  DeviceMessageValidationError,
  encodeDeviceMessage,
  parseDeviceMessage,
  type AutoCadInstance,
  type CapabilityExecuteMessage,
  type CapabilityResultMessage,
  type Capabilities,
  type DeviceMessage,
  type ProtocolVersion
} from '@aleph-connector/cad-protocol'
import {
  DeviceGatewayError,
  GatewayErrorCode,
  type DeviceContext,
  type DeviceExecutionRequest,
  type DeviceExecutionResult,
  type DeviceGateway,
  type DeviceSummary
} from '@aleph-connector/device-contracts'
import { createLogger, withSpan, traceparentOf, type Logger } from '@aleph-connector/observability'
import { validateDeviceGrant } from '@aleph-connector/identity'
import type { DeviceAuthenticator } from './auth/DeviceAuthenticator.js'
import type { GatewayConfig } from './config.js'
import {
  DeviceRegistry,
  type DeviceConnection,
  type DeviceSocketData
} from './registry/DeviceRegistry.js'
import { RequestCorrelator } from './registry/RequestCorrelator.js'

const log: Logger = createLogger('device-gateway')

/**
 * Result of a pre-upgrade auth check — either the deviceId to attach to the socket, or the HTTP
 * response to return instead.
 */
export type UpgradeDecision = { ok: true; deviceId: string } | { ok: false; response: Response }

/**
 * Outcome of {@link DeviceGatewayService.handleUpgradeRequest}: `matched: false` means the request
 * was not for the device path; `matched: true` means this service owns it. `response` is undefined
 * only after a successful Bun WebSocket upgrade. Authentication is asynchronous because production
 * Bridge credentials are signed account tokens.
 * bun-types' `fetch` signature doesn't model that undefined case — see the one cast at the call
 * site in src/index.ts.
 */
export type DeviceUpgradeOutcome =
  { matched: false } | { matched: true; response: Response | undefined }

/** The `{ open, message, close }` object Bun's `websocket` server option expects. */
export interface DeviceWebSocketHandlers {
  open: (ws: ServerWebSocket<DeviceSocketData>) => void
  message: (ws: ServerWebSocket<DeviceSocketData>, raw: string | Buffer) => void
  close: (ws: ServerWebSocket<DeviceSocketData>) => void
}

/**
 * Implements the Device Gateway (AUTOCAD_MCP_PROJECT.md section 7): accepts the Bridge's WSS
 * connection, negotiates protocol version, tracks capability snapshots, and correlates
 * `capability.execute`/`capability.result` frames. Also implements {@link DeviceGateway}, the
 * Internal Command API server calls — see @aleph-connector/device-contracts.
 */
export class DeviceGatewayService implements DeviceGateway {
  private readonly registry = new DeviceRegistry()
  private readonly correlator = new RequestCorrelator()
  private readonly pendingHelloTimers = new Map<
    ServerWebSocket<DeviceSocketData>,
    ReturnType<typeof setTimeout>
  >()
  private sweepTimer: ReturnType<typeof setInterval> | undefined

  constructor(
    private readonly config: GatewayConfig,
    private readonly authenticator: DeviceAuthenticator
  ) {}

  /** Call once from the process's Bun.serve `fetch`: authenticates and upgrades a `/device` request. */
  async handleUpgradeRequest(
    request: Request,
    server: Server<DeviceSocketData>
  ): Promise<DeviceUpgradeOutcome> {
    const url = new URL(request.url)
    if (url.pathname !== this.config.devicePath) return { matched: false }

    const decision = await this.authenticateUpgrade(url)
    if (decision.ok === false) return { matched: true, response: decision.response }

    const upgraded = server.upgrade(request, { data: { deviceId: decision.deviceId } })
    return {
      matched: true,
      response: upgraded ? undefined : new Response('WebSocket upgrade failed', { status: 400 })
    }
  }

  private async authenticateUpgrade(url: URL): Promise<UpgradeDecision> {
    const deviceId = url.searchParams.get('deviceId')
    const token = url.searchParams.get('token')
    if (!deviceId || !token) {
      return {
        ok: false,
        response: new Response('Missing deviceId/token query parameters', { status: 401 })
      }
    }
    const authenticated = await this.authenticator.authenticate(deviceId, token)
    if (!authenticated) {
      return { ok: false, response: new Response('Invalid device credentials', { status: 401 }) }
    }
    return { ok: true, deviceId: authenticated }
  }

  /**
   * Bun `websocket` handler object — pass straight into `Bun.serve({ websocket:
   * gateway.websocketHandlers() })`.
   */
  websocketHandlers(): DeviceWebSocketHandlers {
    return {
      open: (ws) => this.onOpen(ws),
      message: (ws, raw) => this.onMessage(ws, raw),
      close: (ws) => this.onClose(ws)
    }
  }

  /**
   * Starts the periodic liveness sweep. Call once at process startup; never runs implicitly so
   * tests stay deterministic.
   */
  startHeartbeatSweep(): void {
    this.sweepTimer = setInterval(
      () => this.sweepStaleConnections(),
      this.config.heartbeatIntervalMs
    )
  }

  stopHeartbeatSweep(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer)
  }

  private onOpen(ws: ServerWebSocket<DeviceSocketData>): void {
    const timer = setTimeout(() => {
      this.pendingHelloTimers.delete(ws)
      log.warn('closing connection: no hello within timeout', { deviceId: ws.data.deviceId })
      ws.close(4000, 'hello timeout')
    }, this.config.helloTimeoutMs)
    this.pendingHelloTimers.set(ws, timer)
  }

  private onMessage(ws: ServerWebSocket<DeviceSocketData>, raw: string | Buffer): void {
    let message: DeviceMessage
    try {
      message = parseDeviceMessage(typeof raw === 'string' ? raw : raw.toString('utf8'))
    } catch (err) {
      const detail = err instanceof DeviceMessageValidationError ? err.issues : String(err)
      log.warn('dropping malformed device frame', { deviceId: ws.data.deviceId, detail })
      return
    }

    switch (message.type) {
      case 'hello':
        this.onHello(
          ws,
          message.deviceId,
          message.bridgeVersion,
          message.protocol,
          message.capabilities
        )
        return
      case 'capability.update': {
        const connection = this.liveConnection(ws)
        if (!connection) return
        upsertInstance(
          connection.capabilities.autocad?.instances ??
            (connection.capabilities.autocad = { instances: [] }).instances,
          message.instance
        )
        return
      }
      case 'capability.result': {
        const connection = this.liveConnection(ws)
        if (connection) connection.lastSeenAt = Date.now()
        // A frame from a socket that no longer owns the device record must not resolve a
        // request the current connection owes — same identity rule as lastSeenAt.
        if (connection) this.correlator.resolve(message)
        return
      }
      case 'heartbeat': {
        const connection = this.liveConnection(ws)
        if (!connection) return
        connection.lastSeenAt = Date.now()
        if (message.role === 'ping') {
          ws.send(
            encodeDeviceMessage({
              type: 'heartbeat',
              role: 'pong',
              timestamp: new Date().toISOString()
            })
          )
        }
        return
      }
      case 'hello.ack':
      case 'capability.execute':
        log.warn('ignoring gateway-originated message type received from bridge', {
          type: message.type
        })
    }
  }

  private onHello(
    ws: ServerWebSocket<DeviceSocketData>,
    deviceId: string,
    bridgeVersion: string,
    protocol: ProtocolVersion,
    capabilities: Capabilities
  ): void {
    const pendingTimer = this.pendingHelloTimers.get(ws)
    if (pendingTimer) {
      clearTimeout(pendingTimer)
      this.pendingHelloTimers.delete(ws)
    }
    if (deviceId !== ws.data.deviceId) {
      ws.close(4001, 'deviceId mismatch')
      return
    }
    const negotiated = Math.min(protocol.max, DEVICE_PROTOCOL_VERSION.max)
    const compatible = negotiated >= Math.max(protocol.min, DEVICE_PROTOCOL_VERSION.min)
    if (!compatible) {
      ws.send(
        encodeDeviceMessage({
          type: 'hello.ack',
          status: 'update_required',
          minimumBridgeVersion: '0.1.0'
        })
      )
      ws.close(4002, 'protocol incompatible')
      return
    }

    const previous = this.registry.upsert({
      deviceId,
      ws,
      bridgeVersion,
      protocol: negotiated,
      capabilities,
      lastSeenAt: Date.now(),
      pendingRequestIds: new Set()
    })
    // A reconnect with the same deviceId replaces the old socket (e.g. the Bridge dialled a new
    // connection after a network drop before the gateway noticed the dead one). Fail everything
    // the replaced session still owed and close its socket, so it can never answer for the new
    // session or linger half-registered.
    if (previous && previous.ws !== ws) {
      this.correlator.rejectAll(
        previous.pendingRequestIds,
        new Error(
          `Device "${deviceId}" reconnected on a new session; in-flight requests were dropped.`
        )
      )
      this.pendingHelloTimers.delete(previous.ws)
      previous.ws.close(4004, 'replaced by a newer session')
    }

    ws.send(
      encodeDeviceMessage({
        type: 'hello.ack',
        status: 'compatible',
        protocol: negotiated,
        sessionId: crypto.randomUUID()
      })
    )
    log.info('device connected', { deviceId, bridgeVersion, protocol: negotiated })
  }

  private onClose(ws: ServerWebSocket<DeviceSocketData>): void {
    const pendingTimer = this.pendingHelloTimers.get(ws)
    if (pendingTimer) {
      clearTimeout(pendingTimer)
      this.pendingHelloTimers.delete(ws)
    }
    // Identity-checked: the socket closing must only ever remove ITS OWN record. A stale
    // socket's close event arriving after a reconnect would otherwise evict the live session
    // and report the device offline while its Bridge is still connected.
    const connection = this.registry.remove(ws.data.deviceId, ws)
    if (!connection) return
    this.correlator.rejectAll(
      connection.pendingRequestIds,
      new Error(`Device "${connection.deviceId}" disconnected mid-request.`)
    )
    log.info('device disconnected', { deviceId: connection.deviceId })
  }

  /** The registry record for `ws`'s device, but only if `ws` itself owns it — every
   * inbound-frame path uses this instead of a bare deviceId lookup. */
  private liveConnection(ws: ServerWebSocket<DeviceSocketData>): DeviceConnection | undefined {
    const connection = this.registry.get(ws.data.deviceId)
    return connection && connection.ws === ws ? connection : undefined
  }

  private sweepStaleConnections(): void {
    for (const connection of this.registry.sweepStale(this.config.heartbeatTimeoutMs)) {
      log.warn('closing stale connection', { deviceId: connection.deviceId })
      this.correlator.rejectAll(
        connection.pendingRequestIds,
        new Error(`Device "${connection.deviceId}" timed out.`)
      )
      connection.ws.close(4003, 'heartbeat timeout')
    }
  }

  // ---- DeviceGateway (Internal Command API) ------------------------------

  async execute(request: DeviceExecutionRequest): Promise<DeviceExecutionResult> {
    // Issue #349 requirement 3: re-validate the live grant at the actual dispatch point, not
    // only at the MCP HTTP auth gate (`DeviceIdentityVerifier.verifyAccessToken`) — a grant
    // revoked between that check and this call is still caught here. Fails closed.
    if (request.callerWorkspaceId && request.callerUserId) {
      const stillAuthorized = await validateDeviceGrant(
        request.deviceId,
        request.callerWorkspaceId,
        request.callerUserId
      )
      if (!stillAuthorized) {
        throw new DeviceGatewayError(
          GatewayErrorCode.DeviceNotFound,
          `Device "${request.deviceId}" grant is no longer active for this caller.`
        )
      }
    }

    const connection = this.registry.get(request.deviceId)
    if (!connection) {
      throw new DeviceGatewayError(
        GatewayErrorCode.DeviceNotFound,
        `Device "${request.deviceId}" is not connected to this gateway.`
      )
    }

    const instanceId = request.instanceId ?? this.resolveSoleInstance(connection)
    const requestId = crypto.randomUUID()
    const timeoutMs = request.timeoutMs ?? this.config.defaultExecuteTimeoutMs

    return withSpan(
      'device_gateway.execute',
      {
        'capability.operation': request.operation.type,
        'device.id': request.deviceId,
        'request.id': requestId
      },
      async (span) => {
        const execMessage: CapabilityExecuteMessage = {
          type: 'capability.execute',
          requestId,
          target: { capability: 'autocad', instanceId },
          operation: request.operation,
          timeoutMs,
          traceparent: traceparentOf(span)
        }

        connection.pendingRequestIds.add(requestId)
        const pending = this.correlator.await(requestId, timeoutMs)
        connection.ws.send(encodeDeviceMessage(execMessage))

        // Forwards client-initiated cancellation (#9): the MCP SDK aborts `request.signal` on
        // `notifications/cancelled` for the tool call that issued this request. `{ once: true }` plus
        // the `removeEventListener` in `finally` below means this fires at most once per call, and
        // never after the call has already settled.
        const onAbort = () => this.sendCancel(connection, requestId)
        if (request.signal) {
          if (request.signal.aborted) onAbort()
          else request.signal.addEventListener('abort', onAbort, { once: true })
        }

        let result: CapabilityResultMessage
        try {
          result = await pending
        } catch (err) {
          // The gateway's own correlator timeout fired — tell the Bridge so it stops waiting on the
          // named pipe too (#9): without this, the plugin has no signal that nobody is listening for
          // the result anymore, and work already queued (but not yet run — e.g. a modal dialog is
          // blocking Application.Idle) still executes in full once AutoCAD next goes idle, and a
          // client retry then duplicates it.
          this.sendCancel(connection, requestId)
          throw new DeviceGatewayError(GatewayErrorCode.RequestTimeout, (err as Error).message)
        } finally {
          request.signal?.removeEventListener('abort', onAbort)
          connection.pendingRequestIds.delete(requestId)
        }

        return result.status === 'success'
          ? { status: 'success', result: result.result }
          : { status: 'error', error: result.error }
      }
    )
  }

  /**
   * Sends `capability.cancel` for `requestId` to `connection`'s Bridge — best-effort, never throws.
   * The call this cancels is already settling via its own path (timeout rejection or the abort
   * listener above); a send failure here just means the Bridge finds out it can stop waiting a
   * little later, via its own timeout, instead of not at all.
   */
  private sendCancel(connection: DeviceConnection, requestId: string): void {
    try {
      connection.ws.send(encodeDeviceMessage({ type: 'capability.cancel', requestId }))
    } catch (err) {
      log.warn('failed to send capability.cancel', { requestId, error: String(err) })
    }
  }

  async getContext(deviceId: string, instanceId?: string): Promise<DeviceContext> {
    const connection = this.registry.get(deviceId)
    if (!connection) return null
    const instances = connection.capabilities.autocad?.instances ?? []
    if (instanceId) return instances.find((i) => i.instanceId === instanceId) ?? null
    // Offline instances are kept around on purpose (CapabilityRegistry.MarkOffline's own doc
    // comment: "keeps the last-known instance record") so a stale entry from an AutoCAD that
    // already closed can sit ahead of a currently-running one in array order (insertion order,
    // not recency) — reporting instances[0] unconditionally showed a dead instance as "the"
    // AutoCAD even while a real one was online, which is exactly the one thing this tool exists
    // to answer correctly. Prefer a live (online-or-busy) instance; fall back to the last-known
    // one (still useful for "AutoCAD just closed" debugging) only when nothing is live.
    return instances.find((i) => isLive(i.status)) ?? instances[0] ?? null
  }

  async listDevices(): Promise<DeviceSummary[]> {
    return this.registry.list().map((connection) => ({
      deviceId: connection.deviceId,
      online: true,
      bridgeVersion: connection.bridgeVersion,
      capabilities: connection.capabilities
    }))
  }

  private resolveSoleInstance(connection: DeviceConnection): string {
    // `busy` routes: the plugin answers one request at a time on AutoCAD's main thread, so a call
    // while a command runs queues and still executes — refusing it as "no online AutoCAD instance"
    // told the model the user's live AutoCAD didn't exist (the "AutoCAD busy looks like a broken
    // connection" report).
    const instances = (connection.capabilities.autocad?.instances ?? []).filter((i) =>
      isLive(i.status)
    )
    if (instances.length === 0) {
      throw new DeviceGatewayError(
        GatewayErrorCode.InstanceNotFound,
        `Device "${connection.deviceId}" has no online AutoCAD instance.`
      )
    }
    if (instances.length > 1) {
      const ids = instances.map((i) => i.instanceId).join(', ')
      throw new DeviceGatewayError(
        GatewayErrorCode.InstanceAmbiguous,
        `Device "${connection.deviceId}" has ${instances.length} online AutoCAD instances (${ids}); specify instanceId.`
      )
    }
    const [only] = instances
    if (!only) {
      throw new DeviceGatewayError(
        GatewayErrorCode.InstanceNotFound,
        `Device "${connection.deviceId}" has no online AutoCAD instance.`
      )
    }
    return only.instanceId
  }
}

function upsertInstance(instances: AutoCadInstance[], next: AutoCadInstance): void {
  const index = instances.findIndex((i) => i.instanceId === next.instanceId)
  if (index === -1) instances.push(next)
  else instances[index] = next
}

/** An AutoCAD the Bridge can still route to: answering, or busy answering something else. */
function isLive(status: AutoCadInstance['status']): boolean {
  return status === 'online' || status === 'busy'
}
