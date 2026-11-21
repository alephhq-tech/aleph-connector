#!/usr/bin/env bun
/**
 * Prepares the live lane's scratch drawing, then hands off to scripts/e2e-autocad.ts's refusal
 * guard: the harness only runs when the ACTIVE document is exactly its scratch name.
 *
 * Why the round trip through disk: `drawing.save <path>` on a never-saved drawing runs
 * Database.SaveAs, which rebinds Database.Filename but NOT Document.Name - the tab title stays
 * "Drawing1.dwg" - and drawing.list_open reports Document.Name. So a save alone can never satisfy
 * the guard. The path that does: create the drawing, save it under a fresh temp folder, then reopen
 * it with drawing.open - a tab opened from a file carries the full path as its Document.Name, which
 * the guard matches by basename. The tab that was only save-as'd is then closed (its work is already
 * on disk), so the lane leaves exactly one scratch tab.
 *
 * Document ids (not names) address the temporary tab: DocumentContext.IdOf survives SAVEAS while the
 * name does not, so closing by id can't hit the wrong tab.
 *
 *   --close   teardown: close the scratch tab without saving, list what remains, never touch another
 *             operator's drawing.
 *
 * Configuration matches the harness: CADAI_E2E_MCP_URL, CADAI_E2E_TOKEN, CADAI_E2E_SCRATCH_NAME.
 */
import { mkdirSync } from 'node:fs'
import { join, win32 } from 'node:path'
import { tmpdir } from 'node:os'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import type { CallToolResult } from '@modelcontextprotocol/client'

interface OpenDocument {
  name: string
  documentId?: string
  isActive: boolean
}

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult
  const block = result.content[0]
  if (!block || block.type !== 'text') throw new Error(`${name}: no text block`)
  if (result.isError) throw new Error(`${name}: ${block.text}`)
  let payload: unknown
  try {
    payload = JSON.parse(block.text)
  } catch {
    throw new Error(`${name}: server returned non-JSON: ${block.text.slice(0, 200)}`)
  }
  if (typeof payload !== 'object' || payload === null) {
    throw new Error(`${name}: expected a JSON object, got ${typeof payload}`)
  }
  return payload as Record<string, unknown>
}

/** `drawing.list_open` publishes {documents:[{name,documentId,isActive}]}; anything else is empty. */
function documentsOf(listed: Record<string, unknown>): OpenDocument[] {
  const raw = listed.documents
  if (!Array.isArray(raw)) return []
  return raw.filter(
    (d): d is OpenDocument =>
      typeof d === 'object' &&
      d !== null &&
      typeof (d as OpenDocument).name === 'string' &&
      typeof (d as OpenDocument).isActive === 'boolean'
  )
}

function baseName(p: string): string {
  return win32.basename(p).toLowerCase()
}

function findScratch(documents: OpenDocument[], scratchName: string): OpenDocument | undefined {
  return documents.find((d) => baseName(d.name) === baseName(scratchName))
}

async function main(): Promise<void> {
  const mcpUrl = process.env.CADAI_E2E_MCP_URL ?? 'http://127.0.0.1:8080/mcp'
  const token = process.env.CADAI_E2E_TOKEN ?? ''
  const scratchName = process.env.CADAI_E2E_SCRATCH_NAME ?? 'CADAI-E2E-SCRATCH.dwg'
  const closeMode = process.argv.slice(2).includes('--close')
  if (!token.trim()) {
    throw new Error('CADAI_E2E_TOKEN is required (OAuth access_token from scripts/oauth-access-token.ts)')
  }
  let url: URL
  try {
    url = new URL(mcpUrl)
  } catch {
    throw new Error(`CADAI_E2E_MCP_URL is not a valid URL: ${mcpUrl}`)
  }

  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${token}` } }
  })
  const client = new Client({ name: 'aleph-prep-scratch', version: '0.1.0' })
  await client.connect(transport)
  try {
    const documents = documentsOf(await callTool(client, 'drawing', { operation: 'list_open' }))
    const scratch = findScratch(documents, scratchName)

    if (closeMode) {
      if (!scratch) {
        console.log(`no scratch document "${scratchName}" is open - nothing to close`)
        return
      }
      await callTool(client, 'drawing', { operation: 'close', save: false, documentName: scratch.name })
      const after = documentsOf(await callTool(client, 'drawing', { operation: 'list_open' }))
      console.log(
        `closed ${scratch.name}; still open: ${after.map((d) => d.name).join(', ') || '(none)'}`
      )
      return
    }

    if (scratch) {
      if (!scratch.isActive) {
        await callTool(client, 'drawing', { operation: 'activate', documentName: scratch.name })
      }
      console.log(`ready: ${scratch.name} is the active document`)
      return
    }

    const scratchDir = join(tmpdir(), `aleph-e2e-${Date.now()}`)
    mkdirSync(scratchDir, { recursive: true })
    const target = win32.join(scratchDir, scratchName)

    const created = await callTool(client, 'drawing', { operation: 'new' })
    const createdId = created.documentId
    if (typeof createdId !== 'string' || !createdId) {
      throw new Error(`drawing.new returned no documentId: ${JSON.stringify(created)}`)
    }
    await callTool(client, 'drawing', { operation: 'save', path: target, documentName: createdId })

    // The temporary tab now points at `target` (Database.Filename), and drawing.open dedupes on
    // exactly that field - it would return this tab instead of opening a new one, keeping the
    // un-rebinded "Drawing1.dwg" title. So the work has to leave memory (it is on disk) and the tab
    // has to close BEFORE the open, which then creates a tab whose Document.Name is the file path.
    await callTool(client, 'drawing', { operation: 'close', save: false, documentName: createdId })
    const opened = await callTool(client, 'drawing', { operation: 'open', path: target })
    const openedName = opened.name
    if (typeof openedName !== 'string' || baseName(openedName) !== baseName(scratchName)) {
      throw new Error(
        `drawing.open returned "${String(openedName)}", expected a tab named for ${scratchName}`
      )
    }

    const after = documentsOf(await callTool(client, 'drawing', { operation: 'list_open' }))
    const final = findScratch(after, scratchName)
    if (!final) {
      throw new Error(
        `no scratch tab after setup; open tabs: ${after.map((d) => d.name).join(', ') || '(none)'}`
      )
    }
    if (!final.isActive) {
      await callTool(client, 'drawing', { operation: 'activate', documentName: final.name })
    }
    console.log(
      `ready: scratch drawing ${target} open and active ` +
        `(tabs: ${after.map((d) => d.name).join(', ')})`
    )
  } finally {
    await client.close()
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exitCode = 1
})
