/** Library entrypoint — no side effects, safe to import from server for in-process embedding. */
export {
  DeviceGatewayService,
  type DeviceUpgradeOutcome,
  type DeviceWebSocketHandlers,
  type UpgradeDecision
} from './DeviceGatewayService.js'
export { loadGatewayConfig, type GatewayConfig } from './config.js'
export {
  AutoCadBridgeTokenAuthenticator,
  type DeviceAuthenticator
} from './auth/DeviceAuthenticator.js'
export {
  DeviceRegistry,
  type DeviceConnection,
  type DeviceSocketData
} from './registry/DeviceRegistry.js'
export { RequestCorrelator } from './registry/RequestCorrelator.js'
