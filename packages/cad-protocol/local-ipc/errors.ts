/** JSON-RPC error codes beyond the -32600..-32700 reserved range. See docs/PROTOCOL.md. */
export const BridgeErrorCode = {
  BridgeBusy: -32001,
  NoActiveDocument: -32002,
  EntityNotFound: -32003,
  LayerNotFound: -32004,
  TransactionFailed: -32005,
  InvalidGeometry: -32006,
  BlockNotFound: -32007,
  UndoNotTop: -32008,
  UndoStackDiverged: -32009,
  BatchNotFound: -32010,
  DocumentNotFound: -32011,
  LayerProtected: -32012,
  LayerInUse: -32013,
  LayerNameConflict: -32014,
  CaptureFailed: -32015,
  UndoUnsupported: -32016,
  StyleNotFound: -32017,
  StyleNameConflict: -32018,
  AuditUnsupported: -32019,
  CaptureTooLarge: -32020,
  InvalidOperation: -32021,
  ViewFailed: -32022,
  /** aleph-platform#5: `drawing.save`'s `path` failed the plugin's `SavePathValidator`. */
  PathNotAllowed: -32023,
  /** `drawing.save`'s `path` exists and isn't the document's own current file, with no
   * `overwrite: true`. */
  FileExists: -32024,
  /** The plugin's single primary pipe connection belongs to another client, and a secondary
   * connection is never promoted — unlike BridgeBusy, the caller must close and re-dial rather
   * than retry in place. Raised by `plugin/RpcHandlers/BusyHandlers.cs`; the Bridge's
   * `PluginPipeClient` reconnects on this code alone. */
  PipeOccupied: -32025,
  /** An entity targeted for editing cannot be rebuilt by entity.create/entity.update. */
  EditNotRestorable: -32026,
  /** Failed to persist edit session file locally before transaction commit. */
  EditStorageFailed: -32027,
  /** Edit session ID not found or expired. */
  EditNotFound: -32028,
  /** Operation targeted a document different from the session's captured document. */
  EditDocumentMismatch: -32029,
  /** Document revision advanced or source entity changed since pre-image capture. */
  EditStalePreImage: -32030,
  /** An operation targeted an entity outside candidate set or candidate modified externally. */
  EditConflict: -32031,
  /** edit.accept requires human approval via Desktop approval token (Slice 04/06). */
  EditRequiresHumanApproval: -32032,
  /** An edit session has already been accepted and cannot be accepted again. */
  EditAlreadyApplied: -32033,
  /** A mutation would modify a shared block definition; requires explicit sharedScope: true. */
  SharedDefinitionScopeRequired: -32034,
  /** Block uniquify cannot safely clone the requested block definition or reference. */
  BlockUniquifyUnsupported: -32035,
  /** Dependency conflict prevents selective revert: entity modified since target change set was recorded. */
  RevertConflict: -32036,
  /** One idempotency key presented with a different payload: the key already stands for one
   * operation, and answering it with a stored result would report work that was never done
   * (issue #388 §C, bullet 2: "reusing it with changed parameters fails"). */
  IdempotencyKeyConflict: -32037,
  /** An erasure targeted an entity CadAI did not create; user geometry is protected. */
  ProtectedEntity: -32038,
  /** `operations.apply`'s optional `expectedRevision` did not match the document's current
   * revision at the start of execution (#413 phase A: native revision precondition, checked
   * atomically before any transaction starts — zero side effects, re-read and retry). */
  RevisionConflict: -32039,
  /** A capture request specified an invalid, non-finite, degenerate, or unresolvable scope. */
  InvalidScope: -32040
} as const

export type BridgeErrorCode = (typeof BridgeErrorCode)[keyof typeof BridgeErrorCode]

const NAME_BY_CODE: Record<number, string> = Object.fromEntries(
  Object.entries(BridgeErrorCode).map(([name, code]) => [code, name])
)

export function describeBridgeErrorCode(code: number): string {
  return NAME_BY_CODE[code] ?? `UnknownBridgeError(${code})`
}

export class BridgeRpcError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown
  ) {
    super(message)
    this.name = 'BridgeRpcError'
  }
}
