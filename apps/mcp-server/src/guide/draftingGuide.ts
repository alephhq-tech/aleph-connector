import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { McpServer } from '@modelcontextprotocol/server'
import * as z from 'zod/v4'
import { portableInputSchema } from '../tools/portableSchema.js'
import {
  loadPcccGuide,
  pcccTopicSlugs,
  registerPcccGuide,
  resolvePcccTopic,
  type PcccGuide
} from './pcccGuide.js'

// The skill ships as plain files so it can also be installed into other agents unchanged; this
// module serves those same files over MCP rather than keeping a second copy of the text.
// ALEPH_DRAFTING_SKILL_DIR points at the copy shipped next to a compiled sidecar exe; the
// import.meta.url default covers `bun run src/index.ts` in a checkout.
const SKILL_DIR = process.env.ALEPH_DRAFTING_SKILL_DIR?.trim()
  ? // Trailing separator required: `new URL('references/', base)` drops the last segment without one.
    pathToFileURL(process.env.ALEPH_DRAFTING_SKILL_DIR.trim().replace(/[\\/]+$/, '') + '/')
  : new URL('../../skills/autocad-drafting/', import.meta.url)

const URI_ROOT = 'autocad://guide/drafting/'
const PROMPT_NAME = 'autocad-drafting-guide'
const TOOL_NAME = 'guide'

interface GuideFile {
  /** Path relative to the skill directory, e.g. "references/recipes.md". */
  path: string
  title: string
  text: string
}

interface DraftingGuide {
  files: GuideFile[]
  /** SKILL.md without its YAML frontmatter. */
  body: string
  /** Short pointer for the MCP `instructions` field; the rules themselves live in SKILL.md. */
  instructions: string
  pccc: PcccGuide
}

export function loadDraftingGuide(): DraftingGuide {
  const referencePaths = readdirSync(new URL('references/', SKILL_DIR))
    .filter((name) => name.endsWith('.md'))
    .sort()
    .map((name) => `references/${name}`)
  const evalDir = new URL('evals/', SKILL_DIR)
  const evalPaths = existsSync(evalDir)
    ? readdirSync(evalDir)
        .filter((name) => name.endsWith('.md'))
        .sort()
        .map((name) => `evals/${name}`)
    : []
  const files = ['SKILL.md', ...referencePaths, ...evalPaths].map((path) => {
    // (and the resource text served over MCP) must not depend on the checkout's
    // line-ending config (Windows git checkouts commonly convert to CRLF).
    const text = readFileSync(new URL(path, SKILL_DIR), 'utf8').replace(/\r\n/g, '\n')
    return { path, title: firstHeading(text, path), text }
  })

  const skill = files[0]
  if (!skill) throw new Error('skills/autocad-drafting/SKILL.md is missing')
  const body = skill.text.replace(/^---\n[\s\S]*?\n---\n+/, '')

  const pccc = loadPcccGuide()
  const instructions = [
    "This server drives a live AutoCAD on the user's own machine.",
    `Before drawing, call the \`${TOOL_NAME}\` tool (or read the "${PROMPT_NAME}" prompt / the ${URI_ROOT}SKILL.md resource; references under ${URI_ROOT}references/). That skill is the single source of the drafting workflow and rules; do not restate them here.`,
    pccc.instructionsLine
  ].join('\n')

  return { files, body, instructions, pccc }
}

export interface DraftingGuideWithPccc extends DraftingGuide {
  pccc: PcccGuide
}

export function registerDraftingGuide(server: McpServer, guide: DraftingGuideWithPccc): void {
  for (const file of guide.files) {
    const uri = `${URI_ROOT}${file.path}`
    server.registerResource(
      `autocad-drafting:${file.path}`,
      uri,
      {
        title: file.title,
        description:
          file.path === 'SKILL.md'
            ? 'How to plan and produce a drawing with these tools — read before drawing.'
            : `Drafting guide reference: ${file.title}.`,
        mimeType: 'text/markdown'
      },
      async (resourceUri) => ({
        contents: [{ uri: resourceUri.href, mimeType: 'text/markdown', text: file.text }]
      })
    )
  }

  registerPcccGuide(server, guide.pccc)
  registerGuideTool(server, guide)

  const references = guide.files
    .filter((file) => file.path !== 'SKILL.md')
    .map((file) => `- ${file.title}: ${URI_ROOT}${file.path}`)
    .join('\n')

  server.registerPrompt(
    PROMPT_NAME,
    {
      title: 'AutoCAD drafting guide',
      description:
        'Loads the drafting workflow and rules (units, scale, radians, layers, batching, recovery) for this AutoCAD session.'
    },
    () => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: `Follow this guide whenever you use the AutoCAD tools in this conversation.\n\n${guide.body}\nReference resources:\n${references}\n`
          }
        }
      ]
    })
  )
}

/**
 * The same guide as a tool (#71): many MCP clients only surface tools and never show prompts or
 * resources to the model, so this is the one path to the skill that works everywhere.
 */
function registerGuideTool(server: McpServer, guide: DraftingGuideWithPccc): void {
  const topics = guide.files
    .filter((file) => file.path !== 'SKILL.md')
    .map((file) => ({
      slug: file.path.replace(/^(references|evals)\//, '').replace(/\.md$/, ''),
      file
    }))
  const [firstTopic] = topics.map((topic) => topic.slug)
  if (!firstTopic) throw new Error('skills/autocad-drafting/ has no .md files')
  const pcccSlugs = pcccTopicSlugs(guide.pccc)
  const allTopicHint = [...topics.map((t) => t.slug), ...pcccSlugs].join(' | ')

  server.registerTool(
    TOOL_NAME,
    {
      title: 'AutoCAD drafting guide',
      description:
        'Read before drawing: how to plan and draw with these tools (units and scale, layers, ' +
        'radians, batching, verification, recovery). No topic returns the workflow and rules; ' +
        `topic returns one reference or PCCC skill: ${allTopicHint}.`,
      inputSchema: portableInputSchema(z.object({ topic: z.string().optional() })),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
    },
    async ({ topic }) => {
      if (topic) {
        const pcccText = resolvePcccTopic(guide.pccc, topic)
        if (pcccText) {
          return { content: [{ type: 'text' as const, text: pcccText }] }
        }
        const norm = topic.replace(/^(references|evals)\//, '').replace(/\.md$/, '')
        const resolvedFile = topics.find(
          (entry) => entry.slug === topic || entry.slug === norm || entry.file.path === topic
        )?.file
        if (resolvedFile) {
          return { content: [{ type: 'text' as const, text: resolvedFile.text }] }
        }
      }
      const text =
        `${guide.body}\nReference topics (call ${TOOL_NAME} with topic): ${topics.map((entry) => entry.slug).join(', ')}\n` +
        `PCCC topics: ${pcccSlugs.join(', ')}\n`
      return { content: [{ type: 'text' as const, text }] }
    }
  )
}

function firstHeading(markdown: string, fallback: string): string {
  return /^# (.+)$/m.exec(markdown)?.[1]?.trim() ?? fallback
}
