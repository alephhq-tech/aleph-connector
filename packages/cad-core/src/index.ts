import type {
  CadReadContext,
  CadWriteContext,
  ExecutionId,
  ExecutionReceipt
} from './protocol.js'

export * from './protocol.js'

export interface CadReadRequest {
  readonly capability: string
  readonly input: unknown
}

export interface CadWriteRequest extends CadReadRequest {
  readonly executionId: ExecutionId
}

export interface CadResult<T = unknown> {
  readonly data: T
  readonly receipt?: ExecutionReceipt
}

/**
 * The CAD core depends on execution semantics, never WSS, named pipes, or AutoCAD APIs.
 * Every adapter must preserve target identity, revision preconditions, and receipts.
 */
export interface CadExecutor {
  read<T>(request: CadReadRequest, context: CadReadContext): Promise<CadResult<T>>
  write<T>(request: CadWriteRequest, context: CadWriteContext): Promise<CadResult<T>>
  reconcile(executionId: ExecutionId): Promise<ExecutionReceipt>
}
