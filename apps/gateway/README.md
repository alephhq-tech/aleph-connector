# Gateway

Account auth, OAuth 2.1 authorization server, and device grants for Aleph Connector.

- Host (prod): `https://gateway.alephhq.tech`
- MCP resource audience: `https://mcp.alephhq.tech/mcp` (set `MCP_RESOURCE_URL`)

This service does **not** execute CAD tools. The Windows **Aleph Connector** app is the account UI; `/oauth/login` deep-links to `aleph-connector://oauth/consent`.

```bash
cp .env.example .env
bun run db:migrate
bun run dev
```
