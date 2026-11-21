#!/usr/bin/env bun
/**
 * Live AutoCAD E2E lane - one command, full stack, no mocks.
 *
 *   MCP client -> Remote MCP Server (this repo) -> embedded Device Gateway (WSS) -> installed CadAI
 *   connector -> named pipe -> AutoCAD plugin -> real AutoCAD document.
 *
 * Steps, in order: doctor preflight -> start mcp-server with the opt-in device identity tier -> mint
 * the device credential (connector identity.json only) -> OAuth authorization_code+PKCE for the MCP
 * client -> restart the CadAI Bridge task so it dials that credential -> wait for health.json to show
 * pluginLoaded/ipcConnected/bridgeOnline -> prepare the harness's scratch drawing -> run
 * scripts/e2e-autocad.ts against the real stack -> scratch teardown, credential restore, server stop.
 *
 * Fail-closed throughout: a missing prerequisite aborts before the machine is touched, and the
 * harness itself refuses to run unless the ACTIVE AutoCAD document is its own scratch drawing.
 *
 * Run from apps/mcp-server so Bun loads this app's .env (JWT_SECRET):
 *   bun run e2e:live
 *
 * Flags:
 *   --only <group|scenario>   forwarded to the harness (entity | layer | drawing | view | operations)
 *   --scratch-name <name>     harness scratch document name (default CADAI-E2E-SCRATCH.dwg)
 *   --block-name <name>       block definition entity.create(blockReference) needs
 *   --report-out <path>       JSON report destination (default apps/mcp-server/e2e-live-report.json)
 *   --refresh                 run windows/scripts/refresh-dev-client.ps1 first (rebuilds + deploys
 *                             the connector and plugin from this working tree; net48 needs AutoCAD
 *                             closed, which that script reports itself)
 *   --launch-autocad          start AutoCAD when none is running (needs an interactive desktop; cold
 *                             start plus bundle load runs 60-120 s and a modal dialog can block it)
 *   --keep-server             leave the mcp-server running after the lane finishes
 *   --doctor-only             stop after the preflight
 */
import { copyFileSync, existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

interface Flags {
  only?: string
  scratchName: string
  blockName: string
  reportOut: string
  refresh: boolean
  launchAutocad: boolean
  keepServer: boolean
  doctorOnly: boolean
}

interface Minted {
  deviceId: string
  grantGeneration: number
  expiresAt: string
  identityPath: string
  token: string
}

interface Health {
  running: boolean
  pluginLoaded: boolean
  ipcConnected: boolean
  bridgeOnline: boolean
  bridgeVersion?: string
  recoveryPending?: boolean
  instances?: { pluginVersion?: string }[]
  credentialExpiresAt?: number
  updatedAt?: string
}

const WORKSPACE_ID = 'ws-e2e'
const USER_ID = 'user-e2e'
const HEALTH_TIMEOUT_MS = 180_000

class LaneError extends Error {}

function parseFlags(argv: readonly string[]): Flags {
  const flags: Flags = {
    scratchName: 'CADAI-E2E-SCRATCH.dwg',
    blockName: 'CADAI-E2E-BLOCK',
    reportOut: join(process.cwd(), 'e2e-live-report.json'),
    refresh: false,
    launchAutocad: false,
    keepServer: false,
    doctorOnly: false
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    switch (arg) {
      case '--only':
      case '--scratch-name':
      case '--block-name':
      case '--report-out': {
        const value = argv[i + 1]
        if (value === undefined) throw new Error(`${arg} requires a value`)
        if (arg === '--only') flags.only = value
        if (arg === '--scratch-name') flags.scratchName = value
        if (arg === '--block-name') flags.blockName = value
        if (arg === '--report-out') flags.reportOut = value
        i += 1
        break
      }
      case '--refresh':
        flags.refresh = true
        break
      case '--launch-autocad':
        flags.launchAutocad = true
        break
      case '--keep-server':
        flags.keepServer = true
        break
      case '--doctor-only':
        flags.doctorOnly = true
        break
      default:
        throw new Error(`Unknown flag ${arg} (see the header comment)`)
    }
  }
  return flags
}

function step(label: string): void {
  console.log(`\n=== ${label} ===`)
}

/** Runs a command with stdio inherited; returns the exit code. */
function run(
  cmd: string,
  args: readonly string[],
  opts?: { cwd?: string; env?: NodeJS.ProcessEnv }
): number {
  const result = spawnSync(cmd, [...args], {
    stdio: 'inherit',
    cwd: opts?.cwd,
    env: { ...process.env, ...opts?.env }
  })
  return result.status ?? 1
}

/** Runs a command and returns stdout; throws when it fails. */
function capture(
  cmd: string,
  args: readonly string[],
  opts?: { cwd?: string; env?: NodeJS.ProcessEnv }
): string {
  const result = spawnSync(cmd, [...args], {
    encoding: 'utf8',
    cwd: opts?.cwd,
    env: { ...process.env, ...opts?.env }
  })
  if ((result.status ?? 1) !== 0) {
    throw new LaneError(`${cmd} ${args.join(' ')} failed: ${(result.stderr ?? '').trim()}`)
  }
  return result.stdout ?? ''
}

function connectorIdentityPath(): string {
  const localAppData = process.env.LOCALAPPDATA
  if (!localAppData) {
    throw new LaneError('LOCALAPPDATA is not set - the CadAI connector install is not visible here.')
  }
  return join(localAppData, 'CadAI', 'bridge', 'identity.json')
}

function healthJsonPath(): string {
  const programData = process.env.ProgramData ?? process.env.PROGRAMDATA
  if (!programData) {
    throw new LaneError('ProgramData is not set - the CadAI connector install is not visible here.')
  }
  return join(programData, 'CadAI', 'Bridge', 'health.json')
}

function readHealth(): Health | null {
  try {
    return JSON.parse(readFileSync(healthJsonPath(), 'utf8')) as Health
  } catch {
    return null
  }
}

function acadRunning(): boolean {
  const out = capture('powershell', [
    '-NoProfile',
    '-Command',
    '@(Get-Process acad -ErrorAction SilentlyContinue).Count'
  ])
  return Number(out.trim()) > 0
}

function bridgeProcesses(): number[] {
  const out = capture('powershell', [
    '-NoProfile',
    '-Command',
    "(@(Get-Process 'CadAI.Bridge' -ErrorAction SilentlyContinue) | ForEach-Object { $_.Id }) -join ','"
  ])
  const text = out.trim()
  if (!text) return []
  return text
    .split(',')
    .map((v) => Number(v.trim()))
    .filter((v) => Number.isFinite(v) && v > 0)
}

/**
 * Restarts the connector cleanly. A bare `schtasks /End` followed by `/Run` loses a race: the old
 * process can still hold the machine-wide single-instance mutex for a moment, and the freshly started
 * one logs "another CadAI.Bridge process already holds this machine's AutoCAD connections" and exits
 * - leaving no bridge at all. So wait for the process to actually disappear (killing it if the task
 * stop is not enough), then start it.
 */
async function restartBridgeTask(): Promise<void> {
  run('schtasks', ['/End', '/TN', 'CadAI Bridge'])
  const deadline = Date.now() + 15_000
  while (bridgeProcesses().length > 0) {
    if (Date.now() > deadline) {
      console.log('task stop did not end the connector; stopping it directly')
      run('powershell', ['-NoProfile', '-Command', "Get-Process 'CadAI.Bridge' -ErrorAction SilentlyContinue | Stop-Process -Force"])
      break
    }
    await Bun.sleep(500)
  }
  // The mutex is released when the process dies; a short settle avoids re-acquiring a stale handle.
  await Bun.sleep(1_500)
  run('schtasks', ['/Run', '/TN', 'CadAI Bridge'])
}

function launchAutocad(): void {
  const found = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      "(Get-ChildItem 'C:\\Program Files\\Autodesk' -Directory | Where-Object { $_.Name -like 'AutoCAD*' } | Get-ChildItem -Filter acad.exe | Select-Object -First 1).FullName"
    ],
    { encoding: 'utf8' }
  )
  const exe = (found.stdout ?? '').trim()
  if (!exe) throw new LaneError('--launch-autocad: no acad.exe found under C:\\Program Files\\Autodesk.')
  console.log(`launching ${exe}`)
  spawnSync('powershell', ['-NoProfile', '-Command', `Start-Process '${exe}'`])
}

/** Last lines of the connector's own log - where a refused dial or an exit reason actually shows. */
function bridgeLogTail(lines = 25): string {
  const programData = process.env.ProgramData ?? process.env.PROGRAMDATA
  if (!programData) return '(ProgramData not visible)'
  const logDir = join(programData, 'CadAI', 'Bridge', 'logs')
  if (!existsSync(logDir)) return `(no log dir at ${logDir})`
  const newest = (readdirSync(logDir).filter((f) => f.endsWith('.log')) as string[]).sort()
  if (newest.length === 0) return '(no bridge log files)'
  const content = readFileSync(join(logDir, newest[newest.length - 1]!), 'utf8').split('\n')
  return content.slice(-lines).join('\n')
}

async function waitForHealth(
  what: string,
  predicate: (health: Health) => boolean,
  timeoutMs: number,
  probe?: () => void
): Promise<Health> {
  const deadline = Date.now() + timeoutMs
  let last: Health | null = null
  while (Date.now() < deadline) {
    probe?.()
    last = readHealth()
    if (last && predicate(last)) return last
    await Bun.sleep(2_000)
  }
  throw new LaneError(
    `timed out after ${timeoutMs / 1000}s waiting for ${what}. last health.json: ${JSON.stringify(last)}\nbridge log tail:\n${bridgeLogTail()}`
  )
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2))
  const appDir = process.cwd()
  const repoRoot = join(appDir, '..', '..')

  if (!process.env.JWT_SECRET?.trim()) {
    throw new LaneError(
      'JWT_SECRET is not in this process env. Run from apps/mcp-server, where Bun loads its .env: cd apps/mcp-server && bun run e2e:live'
    )
  }

  step('1/7 doctor preflight')
  // The lane starts the server with the dev identity tier, so the doctor must see that env too or it
  // reports a false "unset" for a flag this runner always supplies.
  const doctorExit = run(
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(repoRoot, 'windows', 'scripts', 'e2e-live-doctor.ps1')],
    { env: { ...process.env, ALEPH_DEV_IDENTITY: '1' } }
  )
  if (doctorExit !== 0) throw new LaneError('doctor reported missing prerequisites - fix those, then rerun.')
  if (flags.doctorOnly) return

  if (flags.refresh) {
    step('optional: rebuild and deploy the connector and plugin from this working tree')
    const refreshExit = run('powershell', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      join(repoRoot, 'windows', 'scripts', 'refresh-dev-client.ps1')
    ])
    if (refreshExit !== 0) throw new LaneError('refresh-dev-client.ps1 failed.')
  }

  if (!acadRunning()) {
    if (!flags.launchAutocad) {
      throw new LaneError(
        'AutoCAD is not running, so there is no live plugin to drive. Start it yourself (the bundle ' +
          'loads its pinned train at startup, and a modal dialog can hold the main thread), or pass ' +
          '--launch-autocad to let this lane start it.'
      )
    }
    launchAutocad()
  }

  step('2/7 start the mcp-server (OAuth AS + device identity tier)')
  const server = Bun.spawn(['bun', 'run', 'src/index.ts'], {
    cwd: appDir,
    env: { ...process.env, ALEPH_DEV_IDENTITY: '1' },
    stdout: 'pipe',
    stderr: 'pipe'
  })
  const serverLog: string[] = []
  const tail = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      serverLog.push(decoder.decode(value, { stream: true }))
      if (serverLog.length > 400) serverLog.shift()
    }
  }
  void tail(server.stdout as ReadableStream<Uint8Array>)
  void tail(server.stderr as ReadableStream<Uint8Array>)

  const port = Number(process.env.MCP_AUTOCAD_PORT ?? '8080')
  const deadline = Date.now() + 20_000
  let up = false
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) {
        up = true
        break
      }
    } catch {
      // not listening yet
    }
    if (server.exitCode !== null) break
    await Bun.sleep(500)
  }
  if (!up) throw new LaneError(`mcp-server never answered /health. output:\n${serverLog.join('')}`)
  console.log(`mcp-server listening on ${port}`)

  let serverStopped = false
  const stopServer = (): void => {
    if (serverStopped) return
    serverStopped = true
    if (!flags.keepServer) {
      server.kill()
      console.log('mcp-server stopped.')
    } else {
      console.log('--keep-server: mcp-server left running.')
    }
  }

  // The mint step overwrites the connector's credential file. Whatever provisioned it (Aleph Desktop,
  // or an earlier operator run) is backed up and restored in finally, so the lane never strands a
  // working install.
  const identityPath = connectorIdentityPath()
  const identityBackup = join(tmpdir(), `aleph-identity-backup-${Date.now()}.json`)
  let identityWasBackedUp = false

  try {
    step('3/7 mint the device credential (Connector identity.json — not an MCP token)')
    if (existsSync(identityPath)) {
      copyFileSync(identityPath, identityBackup)
      identityWasBackedUp = true
      console.log(`backed up ${identityPath} -> ${identityBackup}`)
    }
    const mintRaw = capture(
      'bun',
      ['run', 'scripts/mint-dev-credential.ts', '--workspace-id', WORKSPACE_ID, '--user-id', USER_ID],
      { cwd: appDir, env: { ...process.env, ALEPH_DEV_IDENTITY: '1' } }
    )
    let minted: Minted
    try {
      minted = JSON.parse(mintRaw) as Minted
    } catch {
      throw new LaneError(`mint-dev-credential.ts printed no JSON: ${mintRaw.slice(0, 200)}`)
    }
    console.log(
      `deviceId=${minted.deviceId} grantGeneration=${minted.grantGeneration} expires=${minted.expiresAt}`
    )

    step('4/7 obtain MCP OAuth access token (authorization_code + PKCE)')
    const oauthRaw = capture(
      'bun',
      [
        'run',
        'scripts/oauth-access-token.ts',
        '--base-url',
        `http://127.0.0.1:${port}`,
        '--workspace-id',
        WORKSPACE_ID,
        '--user-id',
        USER_ID
      ],
      { cwd: appDir, env: { ...process.env, ALEPH_DEV_IDENTITY: '1' } }
    )
    let oauthToken: string
    try {
      oauthToken = (JSON.parse(oauthRaw) as { access_token: string }).access_token
    } catch {
      throw new LaneError(`oauth-access-token.ts printed no JSON: ${oauthRaw.slice(0, 200)}`)
    }
    if (!oauthToken) throw new LaneError('oauth-access-token.ts returned an empty access_token')

    step('5/7 restart the CadAI Bridge task so it dials the fresh credential')
    await restartBridgeTask()

    const settled = await waitForHealth(
      'pluginLoaded && ipcConnected && bridgeOnline',
      (h) => h.pluginLoaded && h.ipcConnected && h.bridgeOnline,
      HEALTH_TIMEOUT_MS,
      () => {
        if (bridgeProcesses().length === 0) {
          throw new LaneError(
            `the connector is not running at all after restart. bridge log tail:\n${bridgeLogTail()}`
          )
        }
      }
    )
    console.log(
      `stack online: bridge=${settled.bridgeVersion ?? '?'} plugin=${settled.instances?.[0]?.pluginVersion ?? '?'} recoveryPending=${settled.recoveryPending ?? false}`
    )

    step('6/7 prepare the scratch drawing')
    const mcpUrl = process.env.CADAI_E2E_MCP_URL ?? `http://127.0.0.1:${port}/mcp`
    const laneEnv = {
      ...process.env,
      CADAI_E2E_MCP_URL: mcpUrl,
      CADAI_E2E_TOKEN: oauthToken,
      CADAI_E2E_SCRATCH_NAME: flags.scratchName
    }
    const prepExit = run('bun', ['run', 'scripts/prep-scratch.ts'], { cwd: appDir, env: laneEnv })
    if (prepExit !== 0) throw new LaneError('prep-scratch.ts failed - the harness would refuse to run anyway.')

    step('7/7 run the harness against the real stack')
    const harnessArgs = [
      'run',
      'scripts/e2e-autocad.ts',
      '--mcp-url',
      mcpUrl,
      '--token',
      oauthToken,
      '--scratch-name',
      flags.scratchName,
      '--block-name',
      flags.blockName,
      '--report-out',
      flags.reportOut
    ]
    if (flags.only) harnessArgs.push('--only', flags.only)
    const harnessExit = run('bun', harnessArgs, { cwd: appDir })

    run('bun', ['run', 'scripts/prep-scratch.ts', '--close'], { cwd: appDir, env: laneEnv })
    stopServer()

    if (!existsSync(flags.reportOut)) {
      throw new LaneError(`harness wrote no report at ${flags.reportOut} (exit ${harnessExit}).`)
    }
    const report = JSON.parse(readFileSync(flags.reportOut, 'utf8')) as {
      summary?: { total: number; passed: number; failed: number; skipped: number }
    }
    const summary = report.summary
    console.log(
      `\nreport: ${flags.reportOut} - ${summary?.passed ?? 0}/${summary?.total ?? 0} passed, ` +
        `${summary?.failed ?? 0} failed, ${summary?.skipped ?? 0} skipped`
    )
    process.exitCode = harnessExit !== 0 ? 1 : 0
  } finally {
    stopServer()
    if (identityWasBackedUp) {
      copyFileSync(identityBackup, identityPath)
      rmSync(identityBackup, { force: true })
      console.log(`restored ${identityPath}`)
    }
  }
}

main().catch((err: unknown) => {
  console.error(`\nLIVE LANE FAILED: ${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
})
