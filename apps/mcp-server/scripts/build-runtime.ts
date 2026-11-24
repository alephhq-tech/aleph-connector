#!/usr/bin/env bun
/**
 * Compiles the local runtime into a single sidecar exe for the desktop app
 * (src-tauri/binaries/aleph-mcp.exe) and stages the guide skill files next to it:
 * the exe reads skills/autocad-drafting and skills/engineering at startup, and
 * runtime.rs points ALEPH_DRAFTING_SKILL_DIR / ALEPH_PCCC_SKILLS_DIR at them.
 */
import { cpSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const repoRoot = join(import.meta.dir, '..', '..', '..')
const outExe = join(repoRoot, 'windows', 'connector-app', 'src-tauri', 'binaries', 'aleph-mcp.exe')
const skillsOut = join(repoRoot, 'windows', 'connector-app', 'src-tauri', 'binaries', 'skills')

const build = Bun.spawnSync({
  cmd: ['bun', 'build', '--compile', 'apps/mcp-server/src/index.ts', '--outfile', outExe],
  cwd: repoRoot,
  stdout: 'inherit',
  stderr: 'inherit'
})
if (build.exitCode !== 0) process.exit(build.exitCode ?? 1)

rmSync(skillsOut, { recursive: true, force: true })
mkdirSync(skillsOut, { recursive: true })
cpSync(join(repoRoot, 'apps', 'mcp-server', 'skills', 'autocad-drafting'), join(skillsOut, 'autocad-drafting'), {
  recursive: true
})
cpSync(join(repoRoot, 'packages', 'engineering', 'skills'), join(skillsOut, 'engineering'), { recursive: true })
console.log(`staged skills: ${skillsOut}`)
