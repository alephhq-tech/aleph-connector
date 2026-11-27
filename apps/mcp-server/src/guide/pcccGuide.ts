import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { McpServer } from '@modelcontextprotocol/server'

const URI_ROOT = 'autocad://guide/pccc/'

const PCCC_SKILL_NAMES = [
  'aleph-pccc-master',
  'pccc-fire-alarm-design',
  'pccc-sprinkler-design',
  'pccc-pipe-routing',
  'pccc-hydraulic-calculation',
  'pccc-hydrant-cabinet',
  'pccc-emergency-exit',
  'pccc-portable-extinguishers',
  'pccc-bachkhoa-cad-standards'
] as const

export interface PcccGuideFile {
  /** Relative path under URI_ROOT, e.g. "pccc-fire-alarm-design/SKILL.md". */
  path: string
  skill: string
  title: string
  text: string
}

export interface PcccGuide {
  files: PcccGuideFile[]
  /** One-line hint for MCP instructions. */
  instructionsLine: string
  /** Topic slugs accepted by the guide tool (skill name or short alias). */
  topics: { slug: string; file: PcccGuideFile }[]
}

function engineeringSkillsDir(): string {
  // ALEPH_PCCC_SKILLS_DIR points at the skill copy shipped next to a compiled sidecar exe.
  const override = process.env.ALEPH_PCCC_SKILLS_DIR?.trim()
  if (override) return override
  // apps/mcp-server/src/guide → repo packages/engineering/skills
  const here = dirname(fileURLToPath(import.meta.url))
  return join(here, '..', '..', '..', '..', 'packages', 'engineering', 'skills')
}

function firstHeading(markdown: string, fallback: string): string {
  return /^# (.+)$/m.exec(markdown)?.[1]?.trim() ?? fallback
}

export function loadPcccGuide(): PcccGuide {
  const root = engineeringSkillsDir()
  const files: PcccGuideFile[] = []

  for (const skill of PCCC_SKILL_NAMES) {
    const skillDir = join(root, skill)
    if (!existsSync(skillDir)) {
      throw new Error(`Missing PCCC skill directory: ${skillDir}`)
    }
    const skillMd = join(skillDir, 'SKILL.md')
    if (!existsSync(skillMd)) {
      throw new Error(`Missing ${skill}/SKILL.md`)
    }
    const text = readFileSync(skillMd, 'utf8').replace(/\r\n/g, '\n')
    files.push({
      path: `${skill}/SKILL.md`,
      skill,
      title: firstHeading(text, skill),
      text
    })

    const refsDir = join(skillDir, 'references')
    if (existsSync(refsDir)) {
      for (const name of readdirSync(refsDir)
        .filter((n) => n.endsWith('.md'))
        .sort()) {
        const refText = readFileSync(join(refsDir, name), 'utf8').replace(/\r\n/g, '\n')
        files.push({
          path: `${skill}/references/${name}`,
          skill,
          title: firstHeading(refText, name),
          text: refText
        })
      }
    }
  }

  const topics = files
    .filter((f) => f.path.endsWith('/SKILL.md'))
    .flatMap((file) => {
      const short = file.skill.replace(/^pccc-/, '')
      return [
        { slug: file.skill, file },
        { slug: short, file },
        ...(file.skill === 'aleph-pccc-master'
          ? [
              { slug: 'pccc', file },
              { slug: 'aleph-pccc', file },
              { slug: 'master', file }
            ]
          : []),
        ...(file.skill === 'pccc-fire-alarm-design'
          ? [
              { slug: 'fire-alarm', file },
              { slug: 'bao-chay', file }
            ]
          : []),
        ...(file.skill === 'pccc-sprinkler-design'
          ? [
              { slug: 'sprinkler', file },
              { slug: 'chua-chay', file }
            ]
          : []),
        ...(file.skill === 'pccc-hydrant-cabinet'
          ? [
              { slug: 'hydrant', file },
              { slug: 'vach-tuong', file }
            ]
          : []),
        ...(file.skill === 'pccc-emergency-exit'
          ? [
              { slug: 'exit', file },
              { slug: 'cssc', file },
              { slug: 'chieu-sang-su-co', file }
            ]
          : []),
        ...(file.skill === 'pccc-portable-extinguishers'
          ? [
              { slug: 'extinguisher', file },
              { slug: 'binh-chua-chay', file }
            ]
          : []),
        ...(file.skill === 'pccc-bachkhoa-cad-standards'
          ? [
              { slug: 'bach-khoa', file },
              { slug: 'cad-standards', file }
            ]
          : [])
      ]
    })

  return {
    files,
    instructionsLine:
      'For Vietnamese fire-protection (PCCC) design: read autocad://guide/pccc/aleph-pccc-master/SKILL.md (guide topic `pccc` / `aleph-pccc`) and call `pccc_fire_alarm_overlay` or `pccc_overlay` — strictly follow TCVN 7568-14:2025, TCVN 7336:2021, and CTY PCCC BÁCH KHOA standards with zero text collisions and professional legends.',
    topics
  }
}

export function registerPcccGuide(server: McpServer, guide: PcccGuide): void {
  for (const file of guide.files) {
    const uri = `${URI_ROOT}${file.path}`
    server.registerResource(
      `pccc-guide:${file.path}`,
      uri,
      {
        title: file.title,
        description:
          file.path.endsWith('SKILL.md')
            ? `PCCC engineering skill: ${file.skill}`
            : `PCCC reference (${file.skill}): ${file.title}`,
        mimeType: 'text/markdown'
      },
      async (resourceUri) => ({
        contents: [{ uri: resourceUri.href, mimeType: 'text/markdown', text: file.text }]
      })
    )
  }
}

/** Resolve a guide-tool topic to PCCC markdown, or null if not a PCCC topic. */
export function resolvePcccTopic(guide: PcccGuide, topic: string): string | null {
  const norm = topic.replace(/^pccc\//, '').replace(/\/SKILL\.md$/, '')
  const hit = guide.topics.find(
    (t) => t.slug === topic || t.slug === norm || t.file.path === topic || t.file.skill === topic
  )
  return hit ? hit.file.text : null
}

export function pcccTopicSlugs(guide: PcccGuide): string[] {
  return [...new Set(guide.topics.map((t) => t.slug))].sort()
}
