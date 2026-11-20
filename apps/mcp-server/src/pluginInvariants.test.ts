import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { BridgeErrorCode } from '@arcdio/cad-protocol'
/**
 * No RPC handler may switch the user's tab as a side effect (#68): `drawing.activate` (#30) is
 * meant to be the only way. A grep-level guard, since the plugin can't run outside AutoCAD.
 *
 * The plugin itself (C#, runs inside AutoCAD) lives in `windows/autocad-plugin` alongside this
 * server — this reads its `.cs` source as plain text for a static regex guard, not a code/build
 * dependency: nothing here imports or executes plugin code.
 */
describe('autocad-plugin never activates a document', () => {
  const root = new URL('../../../windows/autocad-plugin/', import.meta.url)
  const sources = ['RpcHandlers', 'Util'].flatMap((dir) =>
    readdirSync(new URL(`${dir}/`, root))
      .filter((name) => name.endsWith('.cs'))
      .map((name) => ({
        path: `${dir}/${name}`,
        text: readFileSync(new URL(`${dir}/${name}`, root), 'utf8')
      }))
  )

  test('scans the handler and util sources', () => {
    expect(sources.length).toBeGreaterThan(5)
  })

  // The invariant is "never switches the user's active tab" (#68). SendStringToExecute is only a
  // hazard in that sense when it activates a document (the 2nd positional `activate` flag is true);
  // queueing a top-level native command (e.g. "_.UNDO 1") with activate=false activates nothing and
  // is the only way to run such a command once the codebase's measured constraint holds — a nested
  // Editor.Command of UNDO/REDO inside ExecuteInCommandContextAsync is a silent no-op (CMDACTIVE==1
  // there; live lane). So flag only the activating form, not every SendStringToExecute call.
  for (const [label, pattern] of [
    ['activating SendStringToExecute', /SendStringToExecute\s*\([^;]*?,\s*true\b/],
    ['assigning MdiActiveDocument', /MdiActiveDocument\s*=(?!=)/],
    ['Document.Activate()', /\.Activate\s*\(\s*\)/]
  ] as const) {
    test(`no ${label} (except drawing.activate in DrawingHandlers.cs)`, () => {
      const offenders = sources
        .filter((source) => {
          if (
            label === 'assigning MdiActiveDocument' &&
            source.path === 'RpcHandlers/DrawingHandlers.cs'
          ) {
            // drawing.activate (#30) is the sole intended place to assign MdiActiveDocument;
            // ensure it only occurs inside the activate method.
            const withoutActivate = source.text.replace(
              /\[JsonRpcMethod\("drawing\.activate"[\s\S]*?\n\s*\}\);/,
              ''
            )
            return pattern.test(withoutActivate)
          }
          return pattern.test(source.text)
        })
        .map((s) => s.path)
      expect(offenders).toEqual([])
    })
  }
})

describe('autocad error codes cross-language parity', () => {
  const pluginRoot = new URL('../../../windows/autocad-plugin/', import.meta.url)
  const pluginErrorsText = readFileSync(new URL('PluginErrors.cs', pluginRoot), 'utf8')
  const protocolMdText = readFileSync(new URL('docs/PROTOCOL.md', pluginRoot), 'utf8')

  // Extract all public const int ErrorName = -32xxx from C# PluginErrors.cs
  const csharpCodes = new Map<string, number>()
  const matches = pluginErrorsText.matchAll(/public\s+const\s+int\s+(\w+)\s*=\s*(-?\d+);/g)
  for (const m of matches) {
    csharpCodes.set(m[1]!, Number(m[2]))
  }

  test('PluginErrors.cs defines error codes', () => {
    expect(csharpCodes.size).toBeGreaterThanOrEqual(30)
  })

  test('every C# error code matches BridgeErrorCode in wire-protocol', () => {
    for (const [name, code] of csharpCodes) {
      const wireCode = (BridgeErrorCode as Record<string, number | undefined>)[name]
      expect(wireCode).toBeDefined()
      expect(wireCode).toBe(code)
    }
  })

  test('every C# error code is documented in docs/PROTOCOL.md', () => {
    for (const [name, code] of csharpCodes) {
      // Expose if code or name is missing from the table
      expect(protocolMdText).toContain(String(code))
      expect(protocolMdText).toContain(name)
    }
  })
})
