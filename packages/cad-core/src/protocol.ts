export type DeviceRef = string & { readonly __brand: 'DeviceRef' }
export type InstanceRef = string & { readonly __brand: 'InstanceRef' }
export type DocumentRef = string & { readonly __brand: 'DocumentRef' }
export type Revision = string & { readonly __brand: 'Revision' }
export type ExecutionId = string & { readonly __brand: 'ExecutionId' }
export type IdempotencyKey = string & { readonly __brand: 'IdempotencyKey' }

export interface CadTarget {
  readonly deviceRef: DeviceRef
  readonly instanceRef: InstanceRef
  readonly documentRef: DocumentRef
}

export interface CadReadContext extends CadTarget {
  readonly revision: Revision
}

export interface CadWriteContext extends CadReadContext {
  readonly idempotencyKey: IdempotencyKey
}

export type ExecutionState =
  | 'accepted'
  | 'validated'
  | 'dispatched'
  | 'running'
  | 'committed'
  | 'verified'
  | 'rejected'
  | 'failed'
  | 'unknown'

export interface ExecutionReceipt {
  readonly executionId: ExecutionId
  readonly state: ExecutionState
  readonly target: CadTarget
  readonly revisionBefore: Revision
  readonly revisionAfter?: Revision
  readonly committed: boolean
  readonly verified: boolean
}
