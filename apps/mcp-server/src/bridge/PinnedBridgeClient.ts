import { RpcMethod } from '@arcdio/cad-protocol'
import type { RpcMethodMap, RpcMethodName } from '@arcdio/cad-protocol'
import type { OpenDocumentInfo } from '@arcdio/cad-types'
import type { BridgeClient, BridgeRequestOptions } from './BridgeClient.js'

/** The document one MCP session has pinned, and the AutoCAD process that document lives in. */
interface PinnedDocument {
  documentId: string
  name: string
  /** Absent when the pin was taken on a single-instance device, where there was nothing to bind. */
  instanceId?: string
}

/** A tab row from the plugin, marked when it is the pinned one. */
export type PinnedOpenDocument = OpenDocumentInfo & { pinned?: true }

/** The tab one MCP session has pinned (drawing → use); lives as long as the session. */
export class DocumentPin {
  target: PinnedDocument | undefined
  /** Set when a `list_open` from the pinned instance proved the pinned tab is gone — a closed tab, or
   * a plugin reload (`CADAIRELOAD`), which hands every document a new `documentId`. The target is kept
   * on purpose: a proven-dead id must fail loudly, never fall back to whatever tab is active now. */
  provenGone = false

  /** `list_open`/`context` rows, with the pinned tab marked. Sets `provenGone` when rows from the
   * pinned instance no longer contain it, which is how a pin survives a plugin reload without
   * silently retargeting the new session's active tab (aleph-platform#331). */
  mark(documents: OpenDocumentInfo[], listedInstance?: string): PinnedOpenDocument[] {
    const target = this.target
    if (target && (!listedInstance || listedInstance === target.instanceId)) {
      if (!documents.some((d) => d.documentId === target.documentId)) this.provenGone = true
    }
    return documents.map((d) => (d.documentId === target?.documentId ? { ...d, pinned: true } : d))
  }

  /** The only writer: taking or releasing a pin clears any earlier proof that it died. */
  set(target: PinnedDocument | undefined): void {
    this.target = target
    this.provenGone = false
  }
}

/** A pinned tab the plugin no longer has; kept as a distinct type so `describeToolError` can name it. */
export class PinnedDocumentGoneError extends Error {
  constructor(readonly pinned: PinnedDocument) {
    super(
      `The pinned tab "${pinned.name}" (${pinned.documentId}) is no longer open in ${
        pinned.instanceId ?? 'this AutoCAD instance'
      }; the plugin was reloaded or the tab was closed.`
    )
  }
}

/** The call targets a different AutoCAD process than the session's pin came from. */
export class PinnedInstanceMismatchError extends Error {
  constructor(
    readonly pinned: PinnedDocument,
    readonly requestedInstance: string
  ) {
    super(
      `This session pinned "${pinned.name}" in AutoCAD instance ${pinned.instanceId}, ` +
        `not ${requestedInstance}.`
    )
  }
}

/** Methods whose params have no `documentName`. */
const UNTARGETED: readonly RpcMethodName[] = [RpcMethod.SystemStatus, RpcMethod.DrawingListOpen]

/**
 * Sends a call to the pinned tab when it names no document itself, so work stays in the drawing the
 * user asked for even after they click another tab (#68). The pin is a `documentId`, so if that tab
 * has closed the plugin answers DocumentNotFound — never a silent fallback to the active tab. An
 * explicit `documentName` on a call always wins.
 *
 * A pin also binds the session to the AutoCAD PROCESS that document came from (#331): `documentId`s
 * are handed out per plugin and are unique only inside one `acad.exe`, so an unscoped call used to be
 * resolved by the gateway and could be answered by a different process's identically named tab. An
 * unscoped call now inherits the pinned instance; letting the pin supply the document while naming a
 * second instance is refused with a named reason instead of failing as a confusing DocumentNotFound.
 * Naming another instance AND a document stays allowed — that is the caller deliberately working in
 * the other window, which is also how it inspects a reloaded plugin's new document ids.
 */
export class PinnedBridgeClient implements BridgeClient {
  constructor(
    private readonly inner: BridgeClient,
    readonly pin: DocumentPin
  ) {}

  request<M extends RpcMethodName>(
    method: M,
    params: RpcMethodMap[M]['params'],
    options?: BridgeRequestOptions
  ): Promise<RpcMethodMap[M]['result']> {
    const target = this.pin.target
    if (!target) return this.inner.request(method, params, options)
    const named =
      typeof params === 'object' && params !== null && 'documentName' in params
        ? params.documentName
        : undefined
    // Only a call that would let the pin choose the document can land in the wrong window.
    if (
      target.instanceId !== undefined &&
      options?.instanceId !== undefined &&
      options.instanceId !== target.instanceId &&
      !named &&
      !UNTARGETED.includes(method)
    ) {
      return Promise.reject(new PinnedInstanceMismatchError(target, options.instanceId))
    }
    // An unscoped call inherits the pin's process; `list_open`/`system.status` included, so the
    // agent's next decision is read from the same window it is working in.
    const scoped: BridgeRequestOptions | undefined =
      target.instanceId && !options?.instanceId
        ? { ...options, instanceId: target.instanceId }
        : options
    if (named || UNTARGETED.includes(method)) {
      return this.inner.request(method, params, scoped)
    }
    if (this.pin.provenGone) {
      return Promise.reject(new PinnedDocumentGoneError(target))
    }
    return this.inner.request(method, { ...params, documentName: target.documentId }, scoped)
  }

  close(): Promise<void> {
    return this.inner.close()
  }
}
