/**
 * Sync skill trees into packages/agent-pack/skills/ (idempotent overwrite).
 * Sources stay canonical under apps/mcp-server and packages/engineering.
 */
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = join(packRoot, '..', '..')
const skillsOut = join(packRoot, 'skills')

const copies: { from: string; to: string }[] = [
  {
    from: join(repoRoot, 'apps/mcp-server/skills/autocad-drafting'),
    to: join(skillsOut, 'autocad-drafting')
  },
  {
    from: join(repoRoot, 'packages/engineering/skills/pccc-fire-alarm-design'),
    to: join(skillsOut, 'pccc-fire-alarm-design')
  },
  {
    from: join(repoRoot, 'packages/engineering/skills/pccc-sprinkler-design'),
    to: join(skillsOut, 'pccc-sprinkler-design')
  },
  {
    from: join(repoRoot, 'packages/engineering/skills/pccc-pipe-routing'),
    to: join(skillsOut, 'pccc-pipe-routing')
  },
  {
    from: join(repoRoot, 'packages/engineering/skills/pccc-hydraulic-calculation'),
    to: join(skillsOut, 'pccc-hydraulic-calculation')
  },
  {
    from: join(repoRoot, 'packages/engineering/skills/aleph-pccc-master'),
    to: join(skillsOut, 'aleph-pccc-master')
  },
  {
    from: join(repoRoot, 'packages/engineering/skills/pccc-bachkhoa-cad-standards'),
    to: join(skillsOut, 'pccc-bachkhoa-cad-standards')
  },
  {
    from: join(repoRoot, 'packages/engineering/skills/pccc-hydrant-cabinet'),
    to: join(skillsOut, 'pccc-hydrant-cabinet')
  },
  {
    from: join(repoRoot, 'packages/engineering/skills/pccc-emergency-exit'),
    to: join(skillsOut, 'pccc-emergency-exit')
  },
  {
    from: join(repoRoot, 'packages/engineering/skills/pccc-portable-extinguishers'),
    to: join(skillsOut, 'pccc-portable-extinguishers')
  }
]

mkdirSync(skillsOut, { recursive: true })

for (const { from, to } of copies) {
  if (!existsSync(from)) {
    throw new Error(`Missing skill source: ${from}`)
  }
  rmSync(to, { recursive: true, force: true })
  cpSync(from, to, { recursive: true })
  console.log(`synced ${to}`)
}

writeFileSync(
  join(skillsOut, '.sync-stamp'),
  `${new Date().toISOString()}\n`,
  'utf8'
)
console.log('agent-pack skills sync complete')
