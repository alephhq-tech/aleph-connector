# MCP Server

Owns Aleph Connector's MCP Streamable HTTP resource server and the stateful WSS device gateway.

OAuth authorization server and account APIs live in [`apps/gateway`](../gateway). This process verifies access tokens minted by the gateway (`ALEPH_GATEWAY_URL` + shared `JWT_SECRET`).
