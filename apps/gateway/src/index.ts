import { createGatewayApp } from './app.js'
import { loadGatewayConfig } from './config.js'
import { createGatewayOAuth } from './oauth.js'

const config = loadGatewayConfig()
const oauth = createGatewayOAuth(config)
const app = createGatewayApp(config, oauth)

const server = Bun.serve({
  port: config.port,
  fetch: app.fetch
})

console.log(
  JSON.stringify({
    level: 'info',
    component: 'gateway',
    message: 'listening',
    port: server.port,
    issuer: config.publicUrl,
    resource: config.mcpResourceUrl
  })
)

process.on('SIGINT', () => {
  void server.stop().then(() => process.exit(0))
})
process.on('SIGTERM', () => {
  void server.stop().then(() => process.exit(0))
})
