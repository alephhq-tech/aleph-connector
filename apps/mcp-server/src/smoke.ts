/**
 * Offline, no-AutoCAD smoke test: wires the real MCP server to the in-memory mock bridge, drives it
 * over an in-process MCP `Client`/`Server` transport pair, and exercises every registered tool. Run
 * with `bun run smoke`.
 *
 * This proves the MCP <-> tool <-> bridge-contract wiring end to end. It cannot exercise the WSS
 * Device Gateway transport or the real Bridge/AutoCAD plugin — that requires a Windows host with
 * AutoCAD installed and a running Bridge (see plugin/README.md and bridge/README.md), and is what
 * device-gateway's own smoke test covers for the WSS leg.
 */
import assert from 'node:assert/strict'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import type { CallToolResult } from '@modelcontextprotocol/client'
import { MockBridgeClient } from './bridge/MockBridgeClient.js'
import { MockDeviceGateway } from './bridge/MockDeviceGateway.js'
import { createServer } from './server.js'
import { literalValues } from './tools/shared.js'
import {
  createEntityParams,
  entityOperation,
  entityTransformParams
} from '@aleph-connector/cad-tools'

/** Every tool in this server replies with a single text block (see textResult.ts). */
function textOf(result: CallToolResult): string {
  const block = result.content[0]
  assert.ok(block, 'tool result had no content blocks')
  if (block.type !== 'text') {
    throw new Error(`expected a text block, got "${block.type}"`)
  }
  return block.text
}

async function main(): Promise<void> {
  const deviceId = 'device_pc_01'
  const bridge = new MockBridgeClient()
  const deviceGateway = new MockDeviceGateway(deviceId, {
    instanceId: 'acad_18244',
    processId: 18244,
    status: 'online',
    autocadVersion: '2024-mock',
    pluginVersion: '0.1.0-mock',
    protocol: 1,
    activeDocument: 'Drawing1.dwg'
  })
  const server = createServer(bridge, deviceGateway, deviceId)

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'smoke-harness', version: '0.0.0' })
  await server.connect(serverTransport)
  await client.connect(clientTransport)

  const tools = await client.listTools()
  const names = tools.tools.map((t) => t.name).sort()
  assert.deepStrictEqual(names, [
    'block',
    'cad',
    'construct',
    'context',
    'drawing',
    'edit',
    'entity',
    'guide',
    'layer',
    'operations',
    'pccc_fire_alarm_overlay',
    'pccc_overlay',
    'style',
    'system',
    'view'
  ])
  console.log('tools/list ->', names.join(', '))

  // Every advertised schema must stay in the subset Claude/OpenAI/Gemini tool APIs all accept
  // (see tools/portableSchema.ts): a flat root object, no root unions, no oneOf/const anywhere.
  for (const tool of tools.tools) {
    const schema = tool.inputSchema as Record<string, unknown>
    assert.equal(schema.type, 'object', `${tool.name}: root type must be object`)
    assert.ok(schema.properties, `${tool.name}: root must list properties`)
    for (const keyword of ['oneOf', 'anyOf', 'allOf', '$schema']) {
      assert.ok(!(keyword in schema), `${tool.name}: root must not use ${keyword}`)
    }
    const json = JSON.stringify(schema)
    assert.doesNotMatch(json, /"oneOf"|"const"/, `${tool.name}: use anyOf/enum, not oneOf/const`)
  }
  const entitySchema = tools.tools.find((t) => t.name === 'entity')?.inputSchema as {
    properties: Record<string, { enum?: string[] }>
    required: string[]
  }
  assert.deepStrictEqual(entitySchema.required, ['operation'])
  assert.deepStrictEqual(entitySchema.properties.operation?.enum, [
    'create',
    'list',
    'get',
    'area_measure',
    'erase',
    'copy_to',
    'transform',
    'update'
  ])
  console.log('tools/list schemas -> portable (flat root, anyOf/enum only)')

  // Descriptions are generated from the schemas (#11): every operation/kind/op must be named.
  const descriptionOf = (name: string) =>
    tools.tools.find((t) => t.name === name)?.description ?? ''
  const mustMention: Record<string, readonly string[]> = {
    entity: [
      ...literalValues(createEntityParams.options, 'kind'),
      ...literalValues(entityTransformParams.options, 'op'),
      'create',
      'list',
      'get',
      'area_measure',
      'erase',
      'copy_to',
      'transform',
      'update'
    ],
    operations: [
      ...literalValues(entityOperation.options, 'op'),
      'apply',
      'undo',
      'redo',
      'history',
      'id',
      'defaults.layer'
    ],
    edit: ['begin', 'apply', 'preview', 'status', 'discard', 'accept'],
    layer: ['list', 'create', 'set_current', 'set_properties'],
    block: ['inspect', 'set_explodable', 'list'],
    view: ['zoom_extents', 'capture', 'live', 'get_live', 'zoom'],
    drawing: [
      'info',
      'summary',
      'list_open',
      'open',
      'new',
      'close',
      'activate',
      'save',
      'setup',
      'check',
      'cleanup'
    ],
    construct: ['walls', 'grid', 'room', 'dimensions'],
    style: [
      'linetypes.list',
      'linetypes.load',
      'textStyles.list',
      'textStyles.create',
      'textStyles.setCurrent',
      'dimStyles.list',
      'dimStyles.create',
      'dimStyles.setCurrent'
    ]
  }
  for (const [name, words] of Object.entries(mustMention)) {
    for (const word of words) {
      assert.ok(descriptionOf(name).includes(word), `${name} description must mention "${word}"`)
    }
  }
  for (const tool of tools.tools) {
    assert.ok(tool.title, `${tool.name}: title`)
    assert.equal(tool.annotations?.openWorldHint, false, `${tool.name}: openWorldHint`)
    assert.equal(typeof tool.annotations?.readOnlyHint, 'boolean', `${tool.name}: readOnlyHint`)
  }
  console.log('tools/list descriptions -> every kind/operation named, titles + annotations set')

  const createWithoutEntity = await client.callTool({
    name: 'entity',
    arguments: { operation: 'create' }
  })
  assert.equal(createWithoutEntity.isError, true, 'per-operation validation must still run')
  console.log(
    'entity.create(no entity) -> isError:true,',
    textOf(createWithoutEntity as CallToolResult)
  )

  const instructions = client.getInstructions() ?? ''
  // Instructions must point to the skill, not embed its rules (single source = SKILL.md).
  assert.match(instructions, /autocad-drafting-guide/)
  assert.match(instructions, /single source of the drafting workflow/)
  assert.doesNotMatch(instructions, /Angles are radians/, 'instructions must not restate SKILL.md rules')
  console.log('initialize.instructions ->', `${instructions.length} chars`)

  const prompts = await client.listPrompts()
  assert.deepStrictEqual(
    prompts.prompts.map((p) => p.name),
    ['autocad-drafting-guide']
  )
  const guidePrompt = await client.getPrompt({ name: 'autocad-drafting-guide' })
  const guideMessage = guidePrompt.messages[0]?.content
  assert.ok(guideMessage?.type === 'text', 'guide prompt should return a text message')
  assert.match(guideMessage.text, /## Workflow/)
  assert.doesNotMatch(guideMessage.text, /^---/, 'prompt must not include the SKILL.md frontmatter')
  console.log('prompts/get(autocad-drafting-guide) ->', `${guideMessage.text.length} chars`)

  const resources = await client.listResources()
  const uris = resources.resources.map((r) => r.uri).sort()
  const draftingUris = [
    'autocad://guide/drafting/SKILL.md',
    'autocad://guide/drafting/evals/cases.md',
    'autocad://guide/drafting/references/annotations.md',
    'autocad://guide/drafting/references/architecture.md',
    'autocad://guide/drafting/references/commands.md',
    'autocad://guide/drafting/references/errors.md',
    'autocad://guide/drafting/references/examples.md',
    'autocad://guide/drafting/references/layers.md',
    'autocad://guide/drafting/references/natural-language.md',
    'autocad://guide/drafting/references/pccc.md',
    'autocad://guide/drafting/references/qa-rubric.md',
    'autocad://guide/drafting/references/recipes.md',
    'autocad://guide/drafting/references/source-limitations.md',
    'autocad://guide/drafting/references/sources.md',
    'autocad://guide/drafting/references/tool-playbook.md',
    'autocad://guide/drafting/references/units-and-scale.md'
  ]
  for (const uri of draftingUris) {
    assert.ok(uris.includes(uri), `missing drafting resource ${uri}`)
  }
  for (const skill of [
    'pccc-fire-alarm-design',
    'pccc-sprinkler-design',
    'pccc-pipe-routing',
    'pccc-hydraulic-calculation'
  ]) {
    const uri = `autocad://guide/pccc/${skill}/SKILL.md`
    assert.ok(uris.includes(uri), `missing PCCC resource ${uri}`)
  }
  assert.match(instructions, /pccc_fire_alarm_overlay/)
  const skillResource = await client.readResource({ uri: 'autocad://guide/drafting/SKILL.md' })
  const skillContent = skillResource.contents[0]
  assert.ok(skillContent && 'text' in skillContent, 'SKILL.md resource should be text')
  assert.match(skillContent.text, /^---\nname: autocad-drafting\n/)
  console.log('resources/list ->', uris.length, 'drafting guide files')

  const context = await client.callTool({ name: 'context', arguments: {} })
  assert.equal(context.isError, undefined)
  const contextTabs = (
    JSON.parse(textOf(context as CallToolResult)) as {
      documents: { name: string; isActive: boolean }[]
    }
  ).documents
  assert.deepStrictEqual(contextTabs.map((d) => d.name).sort(), ['Drawing1.dwg', 'Drawing2.dwg'])
  assert.equal(contextTabs.find((d) => d.isActive)?.name, 'Drawing1.dwg', 'context lists every tab')
  console.log('context ->', textOf(context))

  const status = await client.callTool({ name: 'system', arguments: { operation: 'status' } })
  assert.equal(status.isError, undefined)
  console.log('system.status ->', textOf(status))

  const layerCreated = await client.callTool({
    name: 'layer',
    arguments: { operation: 'create', name: 'P&ID-EQUIPMENT', color: { aci: 3 } }
  })
  assert.equal(layerCreated.isError, undefined)
  console.log('layer.create ->', textOf(layerCreated))

  const ensureFirst = await client.callTool({
    name: 'layer',
    arguments: {
      operation: 'ensure',
      layers: [
        { name: 'A-WALL', color: { aci: 1 }, lineweight: 50 },
        { name: 'A-DOOR', color: { aci: 2 }, linetype: 'Continuous' }
      ]
    }
  })
  assert.equal(ensureFirst.isError, undefined)
  const ensureFirstLayers = JSON.parse(textOf(ensureFirst)).layers as Array<{ action: string }>
  assert.deepEqual(
    ensureFirstLayers.map((l) => l.action),
    ['created', 'created']
  )

  const ensureRepeat = await client.callTool({
    name: 'layer',
    arguments: {
      operation: 'ensure',
      layers: [
        { name: 'A-WALL', color: { aci: 1 }, lineweight: 50 },
        { name: 'A-DOOR', color: { aci: 2 }, linetype: 'Continuous' }
      ]
    }
  })
  assert.equal(ensureRepeat.isError, undefined)
  const ensureRepeatLayers = JSON.parse(textOf(ensureRepeat)).layers as Array<{ action: string }>
  assert.deepEqual(
    ensureRepeatLayers.map((l) => l.action),
    ['unchanged', 'unchanged']
  )

  const ensureOneChange = await client.callTool({
    name: 'layer',
    arguments: {
      operation: 'ensure',
      layers: [
        { name: 'A-WALL', color: { aci: 5 } },
        { name: 'A-DOOR', color: { aci: 2 }, linetype: 'Continuous' }
      ]
    }
  })
  assert.equal(ensureOneChange.isError, undefined)
  const ensureOneChangeLayers = JSON.parse(textOf(ensureOneChange)).layers as Array<{
    action: string
  }>
  assert.deepEqual(
    ensureOneChangeLayers.map((l) => l.action),
    ['updated', 'unchanged']
  )
  console.log('layer.ensure -> create/unchanged/updated idempotency confirmed')

  const ensureInvalid = await client.callTool({
    name: 'layer',
    arguments: { operation: 'ensure', layers: [{ name: '' }] }
  })
  assert.equal(ensureInvalid.isError, true)
  console.log('layer.ensure(invalid entry) -> isError:true,', textOf(ensureInvalid))

  const renameConflict = await client.callTool({
    name: 'layer',
    arguments: { operation: 'rename', from: 'A-DOOR', to: 'A-WALL' }
  })
  assert.equal(renameConflict.isError, true)
  console.log('layer.rename(name taken) -> isError:true,', textOf(renameConflict))

  const deleteProtected = await client.callTool({
    name: 'layer',
    arguments: { operation: 'delete', name: '0' }
  })
  assert.equal(deleteProtected.isError, true)
  console.log('layer.delete(protected) -> isError:true,', textOf(deleteProtected))

  const onOff = await client.callTool({
    name: 'layer',
    arguments: { operation: 'set_properties', name: 'A-WALL', on: false }
  })
  assert.equal(onOff.isError, undefined)
  const onOffLayers = await client.callTool({
    name: 'layer',
    arguments: { operation: 'list', fields: ['name', 'on', 'frozen'] }
  })
  const wallLayer = (
    JSON.parse(textOf(onOffLayers)).layers as Array<{ name: string; on: boolean; frozen: boolean }>
  ).find((l) => l.name === 'A-WALL')
  assert.equal(wallLayer?.on, false)
  assert.equal(wallLayer?.frozen, false)
  console.log('layer.setProperties(on:false) -> hidden without freezing, round-trips through list')
  // #34: linetype must be loaded before a layer can use it — prove the failure, then the fix.
  const dashedBeforeLoad = await client.callTool({
    name: 'layer',
    arguments: { operation: 'set_properties', name: 'A-WALL', linetype: 'DASHED' }
  })
  assert.equal(dashedBeforeLoad.isError, true)
  console.log(
    'layer.set_properties(linetype:DASHED before load) -> isError:true,',
    textOf(dashedBeforeLoad)
  )

  const linetypesLoad = await client.callTool({
    name: 'style',
    arguments: { operation: 'linetypes.load', names: ['DASHED', 'CENTER'] }
  })
  assert.equal(linetypesLoad.isError, undefined)
  const linetypesLoaded = JSON.parse(textOf(linetypesLoad)) as {
    loaded: string[]
    alreadyLoaded: string[]
  }
  assert.deepStrictEqual(linetypesLoaded.loaded.sort(), ['CENTER', 'DASHED'])
  console.log('style.linetypes.load ->', textOf(linetypesLoad))

  const linetypesLoadAgain = await client.callTool({
    name: 'style',
    arguments: { operation: 'linetypes.load', names: ['DASHED'] }
  })
  assert.equal(linetypesLoadAgain.isError, undefined)
  const linetypesLoadAgainParsed = JSON.parse(textOf(linetypesLoadAgain)) as {
    loaded: string[]
    alreadyLoaded: string[]
  }
  assert.deepStrictEqual(linetypesLoadAgainParsed, { loaded: [], alreadyLoaded: ['DASHED'] })
  console.log('style.linetypes.load(already loaded) -> no-op,', textOf(linetypesLoadAgain))

  const linetypesList = await client.callTool({
    name: 'style',
    arguments: { operation: 'linetypes.list' }
  })
  assert.equal(linetypesList.isError, undefined)
  const linetypeNames = (
    JSON.parse(textOf(linetypesList)).linetypes as Array<{ name: string }>
  ).map((l) => l.name)
  assert.ok(linetypeNames.includes('Continuous'), 'Continuous is always loaded')
  assert.ok(linetypeNames.includes('DASHED'))
  console.log('style.linetypes.list ->', textOf(linetypesList))

  const dashedAfterLoad = await client.callTool({
    name: 'layer',
    arguments: { operation: 'set_properties', name: 'A-WALL', linetype: 'DASHED' }
  })
  assert.equal(dashedAfterLoad.isError, undefined)
  console.log(
    'layer.set_properties(linetype:DASHED after load) -> isError:undefined,',
    textOf(dashedAfterLoad)
  )

  const textStylesList = await client.callTool({
    name: 'style',
    arguments: { operation: 'textStyles.list' }
  })
  assert.equal(textStylesList.isError, undefined)
  const seededTextStyles = JSON.parse(textOf(textStylesList)).textStyles as Array<{
    name: string
    isCurrent: boolean
  }>
  assert.deepStrictEqual(seededTextStyles, [
    {
      name: 'Standard',
      font: 'txt.shx',
      height: 0,
      widthFactor: 1,
      obliqueAngle: 0,
      isCurrent: true,
      isTrueType: false,
      bold: false,
      italic: false,
      charSet: 0,
      pitchAndFamily: 0
    }
  ])
  console.log('style.textStyles.list(seeded) ->', textOf(textStylesList))

  const textStyleCreated = await client.callTool({
    name: 'style',
    arguments: { operation: 'textStyles.create', name: 'TITLE', font: 'Arial.ttf', height: 5 }
  })
  assert.equal(textStyleCreated.isError, undefined)
  console.log('style.textStyles.create ->', textOf(textStyleCreated))

  const textStyleConflict = await client.callTool({
    name: 'style',
    arguments: { operation: 'textStyles.create', name: 'TITLE', font: 'Arial.ttf' }
  })
  assert.equal(textStyleConflict.isError, true)
  console.log('style.textStyles.create(name taken) -> isError:true,', textOf(textStyleConflict))

  const textStyleUpdated = await client.callTool({
    name: 'style',
    arguments: {
      operation: 'textStyles.create',
      name: 'TITLE',
      font: 'Arial.ttf',
      height: 7.5,
      update: true
    }
  })
  assert.equal(textStyleUpdated.isError, undefined)
  console.log('style.textStyles.create(update:true) ->', textOf(textStyleUpdated))

  const textStyleSetCurrent = await client.callTool({
    name: 'style',
    arguments: { operation: 'textStyles.setCurrent', name: 'TITLE' }
  })
  assert.equal(textStyleSetCurrent.isError, undefined)

  const textStyleSetCurrentMissing = await client.callTool({
    name: 'style',
    arguments: { operation: 'textStyles.setCurrent', name: 'NOPE' }
  })
  assert.equal(textStyleSetCurrentMissing.isError, true)
  console.log(
    'style.textStyles.setCurrent(unknown) -> isError:true,',
    textOf(textStyleSetCurrentMissing)
  )

  const dimStylesList = await client.callTool({
    name: 'style',
    arguments: { operation: 'dimStyles.list' }
  })
  assert.equal(dimStylesList.isError, undefined)
  const seededDimStyles = JSON.parse(textOf(dimStylesList)).dimStyles as Array<{
    name: string
    isCurrent: boolean
  }>
  assert.deepStrictEqual(
    seededDimStyles.map((d) => ({ name: d.name, isCurrent: d.isCurrent })),
    [{ name: 'Standard', isCurrent: true }]
  )
  console.log('style.dimStyles.list(seeded) ->', textOf(dimStylesList))

  const dimStyleCreated = await client.callTool({
    name: 'style',
    arguments: {
      operation: 'dimStyles.create',
      name: 'PLOT-1-100',
      textHeight: 250,
      arrowSize: 250,
      scale: 100,
      unitsFormat: 'architectural'
    }
  })
  assert.equal(dimStyleCreated.isError, undefined)
  console.log('style.dimStyles.create ->', textOf(dimStyleCreated))

  const dimStyleBasedOnMissing = await client.callTool({
    name: 'style',
    arguments: { operation: 'dimStyles.create', name: 'BAD-BASE', basedOn: 'NOPE' }
  })
  assert.equal(dimStyleBasedOnMissing.isError, true)
  console.log(
    'style.dimStyles.create(basedOn missing) -> isError:true,',
    textOf(dimStyleBasedOnMissing)
  )

  // #34 (E2E #6): the plugin never overrides dimension style per-entity — entities created after
  // dimStyles.setCurrent pick up the ambient Database.Dimstyle automatically. Prove the mock tracks
  // which style is current the same way, then confirm an unknown name is rejected.
  const dimStyleSetCurrent = await client.callTool({
    name: 'style',
    arguments: { operation: 'dimStyles.setCurrent', name: 'PLOT-1-100' }
  })
  assert.equal(dimStyleSetCurrent.isError, undefined)
  const dimStylesAfterSetCurrent = JSON.parse(
    textOf(await client.callTool({ name: 'style', arguments: { operation: 'dimStyles.list' } }))
  ).dimStyles as Array<{ name: string; isCurrent: boolean }>
  assert.deepStrictEqual(
    dimStylesAfterSetCurrent.find((d) => d.isCurrent)?.name,
    'PLOT-1-100',
    "dimStyles.setCurrent moves the ambient current style, which entity.create's dimension kinds read implicitly"
  )
  console.log('style.dimStyles.setCurrent -> ambient current style tracked,', 'PLOT-1-100')

  const dimStyleSetCurrentMissing = await client.callTool({
    name: 'style',
    arguments: { operation: 'dimStyles.setCurrent', name: 'NOPE' }
  })
  assert.equal(dimStyleSetCurrentMissing.isError, true)
  console.log(
    'style.dimStyles.setCurrent(unknown) -> isError:true,',
    textOf(dimStyleSetCurrentMissing)
  )

  const invalidStyleName = await client.callTool({
    name: 'style',
    arguments: { operation: 'textStyles.create', name: 'BAD<NAME>', font: 'Arial.ttf' }
  })
  assert.equal(invalidStyleName.isError, true)
  console.log('style.textStyles.create(illegal name) -> isError:true,', textOf(invalidStyleName))

  const drawingInfo = await client.callTool({ name: 'drawing', arguments: { operation: 'info' } })
  assert.equal(drawingInfo.isError, undefined)
  console.log('drawing.info ->', textOf(drawingInfo))

  // drawing.setup: applies units/scale in one transaction, returns every applied value read back;
  // the `scale` convenience derives ltScale/dimScale, and an explicit ltScale wins over `scale`.
  const setupApplied = await client.callTool({
    name: 'drawing',
    arguments: {
      operation: 'setup',
      insUnits: 'mm',
      linearUnits: 'architectural',
      linearPrecision: 2,
      angularUnits: 'radians',
      scale: 100,
      ltScale: 75,
      lwDisplay: true
    }
  })
  assert.equal(setupApplied.isError, undefined)
  const setupResult = JSON.parse(textOf(setupApplied)) as {
    insUnits: string
    linearUnits: string
    linearPrecision: number
    angularUnits: string
    ltScale: number
    celtScale: number
    dimScale: number
    lwDisplay: boolean
  }
  assert.equal(setupResult.insUnits, 'mm')
  assert.equal(setupResult.linearUnits, 'architectural')
  assert.equal(setupResult.linearPrecision, 2)
  assert.equal(setupResult.angularUnits, 'radians')
  assert.equal(setupResult.ltScale, 75, 'explicit ltScale wins over scale * 0.5')
  assert.equal(setupResult.dimScale, 100, 'dimScale comes from the scale convenience')
  assert.equal(setupResult.lwDisplay, true)
  console.log('drawing.setup ->', textOf(setupApplied))

  const setupUnknownKey = await client.callTool({
    name: 'drawing',
    arguments: { operation: 'setup', notARealField: 1 }
  })
  assert.equal(
    setupUnknownKey.isError,
    true,
    'an unknown drawing.setup key is rejected before the plugin'
  )
  console.log('drawing.setup(unknown key) -> isError:true,', textOf(setupUnknownKey))

  const setupOutOfRange = await client.callTool({
    name: 'drawing',
    arguments: { operation: 'setup', linearPrecision: 9 }
  })
  assert.equal(
    setupOutOfRange.isError,
    true,
    'linearPrecision above 8 is rejected before the plugin'
  )
  console.log('drawing.setup(linearPrecision:9) -> isError:true,', textOf(setupOutOfRange))

  const openDocs = await client.callTool({
    name: 'drawing',
    arguments: { operation: 'list_open' }
  })
  assert.equal(openDocs.isError, undefined)
  console.log('drawing.list_open ->', textOf(openDocs))

  const listParsed = JSON.parse(textOf(openDocs)) as { documents: { name: string }[] }
  assert.deepStrictEqual(listParsed.documents.map((d) => d.name).sort(), [
    'Drawing1.dwg',
    'Drawing2.dwg'
  ])

  const targetedCreate = await client.callTool({
    name: 'entity',
    arguments: {
      operation: 'create',
      entity: { kind: 'circle', center: { x: 0, y: 0, z: 0 }, radius: 10 },
      documentName: 'Drawing2.dwg'
    }
  })
  assert.equal(targetedCreate.isError, undefined)
  console.log('entity.create(documentName=Drawing2.dwg) ->', textOf(targetedCreate))

  const drawing2List = await client.callTool({
    name: 'entity',
    arguments: { operation: 'list', documentName: 'Drawing2.dwg' }
  })
  const drawing2Entities = JSON.parse(textOf(drawing2List)) as { total: number }
  assert.equal(drawing2Entities.total, 1)

  const drawing1List = await client.callTool({
    name: 'entity',
    arguments: { operation: 'list' }
  })
  const drawing1Entities = JSON.parse(textOf(drawing1List)) as { total: number }
  assert.equal(
    drawing1Entities.total,
    0,
    "entity created in Drawing2.dwg must not leak into the active document's own list"
  )
  console.log('documentName isolation confirmed: Drawing2.dwg has 1 entity, active document has 0')

  // drawing.check / drawing.cleanup: active document is confirmed empty right above, so a check
  // here is a clean baseline; then seed two duplicate lines and a zero-length one, scoped to just
  // their own handles so later entities created elsewhere in this script can't affect the assertions.
  const cleanCheck = await client.callTool({ name: 'drawing', arguments: { operation: 'check' } })
  assert.equal(cleanCheck.isError, undefined)
  assert.deepStrictEqual(JSON.parse(textOf(cleanCheck)), { findings: [] })

  const dupA = await client.callTool({
    name: 'entity',
    arguments: { operation: 'create', entity: { kind: 'line', start: [0, 0], end: [10, 0] } }
  })
  const dupB = await client.callTool({
    name: 'entity',
    arguments: { operation: 'create', entity: { kind: 'line', start: [0, 0], end: [10, 0] } }
  })
  const zeroLen = await client.callTool({
    name: 'entity',
    arguments: { operation: 'create', entity: { kind: 'line', start: [50, 50], end: [50, 50] } }
  })
  const dupAParsed = JSON.parse(textOf(dupA)) as { entity: { handle: string } }
  const dupBParsed = JSON.parse(textOf(dupB)) as { entity: { handle: string } }
  const zeroLenParsed = JSON.parse(textOf(zeroLen)) as { entity: { handle: string } }
  const dupAHandle = dupAParsed.entity.handle
  const dupBHandle = dupBParsed.entity.handle
  const zeroHandle = zeroLenParsed.entity.handle

  const dirtyCheck = await client.callTool({
    name: 'drawing',
    arguments: {
      operation: 'check',
      checks: ['duplicates', 'zeroLength'],
      scope: { handles: [dupAHandle, dupBHandle, zeroHandle] }
    }
  })
  const dirtyParsed = JSON.parse(textOf(dirtyCheck)) as {
    findings: { check: string; handles: string[] }[]
  }
  const dirtyFindings = dirtyParsed.findings
  assert.ok(dirtyFindings.some((f) => f.check === 'duplicates' && f.handles.includes(dupBHandle)))
  assert.ok(dirtyFindings.some((f) => f.check === 'zeroLength' && f.handles.includes(zeroHandle)))
  console.log('drawing.check(duplicates+zeroLength) ->', textOf(dirtyCheck))

  const cleanupDry = await client.callTool({
    name: 'drawing',
    arguments: { operation: 'cleanup', fixes: ['duplicates', 'zeroLength'], dryRun: true }
  })
  const dryApplied = JSON.parse(textOf(cleanupDry)) as {
    dryRun: boolean
    applied: { count: number }[]
  }
  assert.equal(dryApplied.dryRun, true)
  console.log('drawing.cleanup(dryRun:true) ->', textOf(cleanupDry))

  const cleanupReal = await client.callTool({
    name: 'drawing',
    arguments: { operation: 'cleanup', fixes: ['duplicates', 'zeroLength'], dryRun: false }
  })
  assert.equal(cleanupReal.isError, undefined)
  console.log('drawing.cleanup(dryRun:false) ->', textOf(cleanupReal))

  // The "duplicates" fix keeps one copy of each group (dupAHandle survives) — erase it too so the
  // active document is empty again for the "empty drawing can't be captured" check further below.
  const eraseSurvivor = await client.callTool({
    name: 'entity',
    arguments: { operation: 'erase', handles: [dupAHandle] }
  })
  assert.equal(eraseSurvivor.isError, undefined)

  const auditRejected = await client.callTool({
    name: 'drawing',
    arguments: { operation: 'cleanup', fixes: ['audit'] }
  })
  assert.equal(auditRejected.isError, true, 'audit has no implementation and must fail the call')
  console.log('drawing.cleanup(audit) -> isError:true,', textOf(auditRejected))

  const unknownDoc = await client.callTool({
    name: 'entity',
    arguments: {
      operation: 'create',
      entity: { kind: 'circle', center: { x: 0, y: 0, z: 0 }, radius: 10 },
      documentName: 'NoSuchDrawing.dwg'
    }
  })
  assert.equal(unknownDoc.isError, true)
  assert.deepStrictEqual(
    (unknownDoc.structuredContent as { error: { code: number; name: string } }).error.name,
    'DocumentNotFound'
  )
  console.log('entity.create(documentName=unknown) -> isError:true,', textOf(unknownDoc))

  // A tab title without ".dwg" / in another case still finds the tab (autocad-mcp#68).
  const shortNameList = await client.callTool({
    name: 'entity',
    arguments: { operation: 'list', documentName: 'drawing2' }
  })
  assert.equal(shortNameList.isError, undefined)
  assert.equal((JSON.parse(textOf(shortNameList)) as { total: number }).total, 1)
  console.log('entity.list(documentName=drawing2) -> resolved to Drawing2.dwg')

  // view.capture: the reference tab can be looked at without activating it, and the result is a
  // text block (metadata, no base64) plus one PNG image block.
  const capture = (await client.callTool({
    name: 'view',
    arguments: { operation: 'capture', documentName: 'Drawing2.dwg', width: 640, height: 480 }
  })) as CallToolResult
  assert.equal(capture.isError, undefined)
  assert.deepStrictEqual(
    capture.content.map((b) => b.type),
    ['text', 'image']
  )
  const captureImage = capture.content[1]
  assert.ok(captureImage?.type === 'image' && captureImage.mimeType === 'image/png')
  const captureMeta = JSON.parse(textOf(capture)) as Record<string, unknown>
  assert.equal(captureMeta.documentName, 'Drawing2.dwg')
  assert.equal(captureMeta.width, 640)
  assert.ok(!('data' in captureMeta), 'base64 must live only in the image block')
  console.log('view.capture(Drawing2.dwg) ->', textOf(capture))

  const emptyCapture = await client.callTool({
    name: 'view',
    arguments: { operation: 'capture' }
  })
  assert.equal(emptyCapture.isError, true, "an empty drawing can't be captured")
  assert.equal(
    (emptyCapture.structuredContent as { error: { name: string } }).error.name,
    'CaptureFailed'
  )

  // view.live / view.getLive (autocad-mcp#67): setLive returns the effective settings after
  // defaults applied; getLive reads them back.
  const liveSet = await client.callTool({
    name: 'view',
    arguments: { operation: 'live', follow: 'fit', margin: 0.1, documentName: 'Drawing2.dwg' }
  })
  assert.equal(liveSet.isError, undefined)
  const liveSetSettings = JSON.parse(textOf(liveSet)) as { follow: string; margin: number }
  assert.equal(liveSetSettings.follow, 'fit')
  assert.equal(liveSetSettings.margin, 0.1)
  const liveGot = await client.callTool({
    name: 'view',
    arguments: { operation: 'get_live', documentName: 'Drawing2.dwg' }
  })
  assert.deepStrictEqual(JSON.parse(textOf(liveGot)), liveSetSettings)
  console.log('view.live/get_live(Drawing2.dwg) ->', textOf(liveGot))

  // A per-call `view` override on a mutating call does not persist into the document's live
  // settings — it's threaded through and stored distinctly from the document default.
  await client.callTool({
    name: 'entity',
    arguments: {
      operation: 'create',
      entity: { kind: 'circle', center: [0, 0], radius: 1 },
      view: { follow: 'off' },
      documentName: 'Drawing2.dwg'
    }
  })
  const liveAfterOverride = await client.callTool({
    name: 'view',
    arguments: { operation: 'get_live', documentName: 'Drawing2.dwg' }
  })
  assert.deepStrictEqual(
    JSON.parse(textOf(liveAfterOverride)),
    liveSetSettings,
    "a per-call view override must not mutate the document's stored live setting"
  )
  console.log("entity.create(view: {follow:'off'} override) -> document live setting unchanged")

  // view.zoom (autocad-mcp#67/#27/#63): explicit "look here", independent of live-follow.
  const zoomed = await client.callTool({
    name: 'view',
    arguments: {
      operation: 'zoom',
      center: { x: 10, y: 10, z: 0 },
      viewHeight: 50,
      documentName: 'Drawing2.dwg'
    }
  })
  assert.equal(zoomed.isError, undefined)
  assert.deepStrictEqual(JSON.parse(textOf(zoomed)), {
    center: { x: 10, y: 10, z: 0 },
    height: 50
  })
  console.log('view.zoom(center+viewHeight) ->', textOf(zoomed))

  // capture option after drawing: batch result + picture framed on what was drawn.
  const batchWithCapture = (await client.callTool({
    name: 'operations',
    arguments: {
      operation: 'apply',
      operations: [{ op: 'create', entity: { kind: 'circle', center: [5, 5], radius: 2 } }],
      capture: 'changed',
      documentName: 'Drawing2.dwg'
    }
  })) as CallToolResult
  assert.equal(batchWithCapture.isError, undefined)
  assert.deepStrictEqual(
    batchWithCapture.content.map((b) => b.type),
    ['text', 'image']
  )
  const batchMeta = JSON.parse(textOf(batchWithCapture)) as {
    status: string
    capture: { fittedTo: string }
  }
  assert.equal(batchMeta.status, 'committed')
  assert.equal(batchMeta.capture.fittedTo, 'entities')
  console.log('operations.apply(capture=changed) ->', textOf(batchWithCapture))

  const noCapture = (await client.callTool({
    name: 'operations',
    arguments: {
      operation: 'apply',
      operations: [{ op: 'create', entity: { kind: 'circle', center: [9, 9], radius: 1 } }],
      documentName: 'Drawing2.dwg'
    }
  })) as CallToolResult
  assert.deepStrictEqual(
    noCapture.content.map((b) => b.type),
    ['text'],
    'without `capture` the result stays text-only'
  )

  // copy_to: reuse Drawing2's circle in Drawing1 (source = Drawing2), offset, on a layer the target lacks.
  const layerInDrawing2 = await client.callTool({
    name: 'layer',
    arguments: { operation: 'create', name: 'S-DETAIL', documentName: 'Drawing2.dwg' }
  })
  assert.equal(layerInDrawing2.isError, undefined)
  const detail = await client.callTool({
    name: 'entity',
    arguments: {
      operation: 'create',
      entity: { kind: 'circle', center: [0, 0], radius: 3, layer: 'S-DETAIL' },
      documentName: 'Drawing2.dwg'
    }
  })
  const detailHandle = (
    JSON.parse(textOf(detail as CallToolResult)) as { entity: { handle: string } }
  ).entity.handle
  const copiedOver = await client.callTool({
    name: 'entity',
    arguments: {
      operation: 'copy_to',
      handles: [detailHandle],
      documentName: 'Drawing2.dwg',
      targetDocumentName: 'drawing1',
      delta: [100, 0]
    }
  })
  assert.equal(copiedOver.isError, undefined)
  const copiedResult = JSON.parse(textOf(copiedOver as CallToolResult)) as {
    copied: { layer: string }[]
    targetDocumentName: string
  }
  assert.equal(copiedResult.targetDocumentName, 'Drawing1.dwg')
  assert.equal(copiedResult.copied[0]?.layer, 'S-DETAIL')
  const layersInDrawing1 = JSON.parse(
    textOf(
      (await client.callTool({
        name: 'layer',
        arguments: { operation: 'list' }
      })) as CallToolResult
    )
  ) as { layers: { name: string }[] }
  assert.ok(
    layersInDrawing1.layers.some((l) => l.name === 'S-DETAIL'),
    'clone creates the missing layer'
  )
  const copyToSelf = await client.callTool({
    name: 'entity',
    arguments: {
      operation: 'copy_to',
      handles: [detailHandle],
      documentName: 'Drawing2.dwg',
      targetDocumentName: 'Drawing2.dwg'
    }
  })
  assert.equal(copyToSelf.isError, true, 'copying a tab into itself is rejected')
  console.log('entity.copy_to(Drawing2 -> Drawing1) ->', textOf(copiedOver as CallToolResult))

  // drawing.use pins a tab by its stable id: calls without documentName land there, an explicit
  // documentName still wins, releasing the pin restores the active tab, an unknown id fails.
  const tabs = JSON.parse(
    textOf(
      (await client.callTool({
        name: 'drawing',
        arguments: { operation: 'list_open' }
      })) as CallToolResult
    )
  ) as {
    documents: { documentId: string; name: string }[]
  }
  const drawing2Id = tabs.documents.find((d) => d.name === 'Drawing2.dwg')?.documentId
  assert.ok(drawing2Id?.startsWith('doc_'), 'list_open reports a documentId')
  const pinned = await client.callTool({
    name: 'drawing',
    arguments: { operation: 'use', documentName: 'drawing2' }
  })
  assert.deepStrictEqual(JSON.parse(textOf(pinned as CallToolResult)), {
    pinned: { documentId: drawing2Id, name: 'Drawing2.dwg' }
  })
  const pinnedList = JSON.parse(
    textOf(
      (await client.callTool({
        name: 'entity',
        arguments: { operation: 'list' }
      })) as CallToolResult
    )
  ) as { total: number }
  assert.ok(pinnedList.total > 0, 'a call without documentName lands in the pinned tab')
  const explicitList = JSON.parse(
    textOf(
      (await client.callTool({
        name: 'entity',
        arguments: { operation: 'list', documentName: 'Drawing1.dwg' }
      })) as CallToolResult
    )
  ) as { total: number }
  assert.notEqual(
    explicitList.total,
    pinnedList.total,
    'an explicit documentName wins over the pin'
  )
  const byId = JSON.parse(
    textOf(
      (await client.callTool({
        name: 'entity',
        arguments: { operation: 'list', documentName: drawing2Id }
      })) as CallToolResult
    )
  ) as { total: number }
  assert.equal(byId.total, pinnedList.total, 'documentId is accepted as documentName')
  const badPin = await client.callTool({
    name: 'drawing',
    arguments: { operation: 'use', documentName: 'doc_closed' }
  })
  assert.equal(badPin.isError, true, 'an unknown id fails instead of falling back')
  const released = await client.callTool({ name: 'drawing', arguments: { operation: 'use' } })
  assert.deepStrictEqual(JSON.parse(textOf(released as CallToolResult)), { pinned: null })
  const afterRelease = JSON.parse(
    textOf(
      (await client.callTool({
        name: 'entity',
        arguments: { operation: 'list' }
      })) as CallToolResult
    )
  ) as { total: number }
  assert.equal(afterRelease.total, explicitList.total, 'released pin → the active tab again')
  console.log('drawing.use -> pin by id, explicit documentName wins, release, unknown id fails')

  // A batch on a background tab is atomic but not undoable: it says so, and undo refuses it.
  const bgBatch = JSON.parse(textOf(batchWithCapture)) as {
    batchId: string
    undo: { supported: boolean; mode: string }
  }
  assert.deepStrictEqual(bgBatch.undo.supported, false)
  assert.equal(bgBatch.undo.mode, 'unsupported-background')
  const bgUndo = await client.callTool({
    name: 'operations',
    arguments: { operation: 'undo', batchId: bgBatch.batchId, documentName: 'Drawing2.dwg' }
  })
  assert.equal(bgUndo.isError, true)
  assert.equal(
    (bgUndo.structuredContent as { error: { name: string } }).error.name,
    'UndoUnsupported'
  )
  console.log('operations.undo(background tab) -> UndoUnsupported')

  const rect = await client.callTool({
    name: 'entity',
    arguments: {
      operation: 'create',
      entity: {
        kind: 'rectangle',
        layer: 'P&ID-EQUIPMENT',
        corner1: { x: 0, y: 0, z: 0 },
        corner2: { x: 4000, y: 6000, z: 0 }
      }
    }
  })
  assert.equal(rect.isError, undefined)
  const rectText = textOf(rect)
  console.log('entity.create(rectangle) ->', rectText)
  const created = JSON.parse(rectText) as { entity: { handle: string } }

  const text = await client.callTool({
    name: 'entity',
    arguments: {
      operation: 'create',
      entity: { kind: 'text.singleLine', insertion: { x: 0, y: -200, z: 0 }, text: 'PUMP-101' }
    }
  })
  assert.equal(text.isError, undefined)
  console.log('entity.create(text.singleLine) ->', textOf(text))

  const block = await client.callTool({
    name: 'entity',
    arguments: {
      operation: 'create',
      entity: {
        kind: 'blockReference',
        blockName: 'VALVE',
        position: { x: 2000, y: 3000, z: 0 },
        attributes: { TAG: 'V-101' }
      }
    }
  })
  assert.equal(block.isError, undefined)
  console.log('entity.create(blockReference) ->', textOf(block))

  const dimension = await client.callTool({
    name: 'entity',
    arguments: {
      operation: 'create',
      entity: {
        kind: 'dimension.linear',
        extLine1: { x: 0, y: 0, z: 0 },
        extLine2: { x: 4000, y: 0, z: 0 },
        dimLinePoint: { x: 2000, y: -500, z: 0 }
      }
    }
  })
  assert.equal(dimension.isError, undefined)
  console.log('entity.create(dimension.linear) ->', textOf(dimension))

  const alignedDimension = await client.callTool({
    name: 'entity',
    arguments: {
      operation: 'create',
      entity: {
        kind: 'dimension.aligned',
        extLine1: { x: 0, y: 0, z: 0 },
        extLine2: { x: 2828, y: 2828, z: 0 },
        dimLinePoint: { x: 1500, y: -300, z: 0 }
      }
    }
  })
  assert.equal(alignedDimension.isError, undefined)
  console.log('entity.create(dimension.aligned) ->', textOf(alignedDimension))

  const ordinateDimension = await client.callTool({
    name: 'entity',
    arguments: {
      operation: 'create',
      entity: {
        kind: 'dimension.ordinate',
        origin: { x: 0, y: 0, z: 0 },
        featurePoint: { x: 500, y: 200, z: 0 },
        leaderEndPoint: { x: 500, y: 600, z: 0 },
        axis: 'x'
      }
    }
  })
  assert.equal(ordinateDimension.isError, undefined)
  console.log('entity.create(dimension.ordinate) ->', textOf(ordinateDimension))

  // dimension.chain (#59): entity.create kind expanded server-side into N dimension.linear
  // steps, sent as one operations.apply batch — the plugin needs no new code for this kind.
  const chainContinue = JSON.parse(
    textOf(
      await client.callTool({
        name: 'entity',
        arguments: {
          operation: 'create',
          entity: {
            kind: 'dimension.chain',
            points: [
              { x: 0, y: 0 },
              { x: 900, y: 0 },
              { x: 1500, y: 0 },
              { x: 2100, y: 0 },
              { x: 3000, y: 0 }
            ],
            mode: 'continue',
            direction: 'horizontal',
            offset: 500
          }
        }
      })
    )
  ) as { entityRefs: unknown[]; status: string }
  assert.equal(chainContinue.status, 'committed')
  assert.equal(chainContinue.entityRefs.length, 4)

  const chainBaseline = JSON.parse(
    textOf(
      await client.callTool({
        name: 'entity',
        arguments: {
          operation: 'create',
          entity: {
            kind: 'dimension.chain',
            points: [
              { x: 0, y: 0 },
              { x: 900, y: 0 },
              { x: 1500, y: 0 },
              { x: 2100, y: 0 },
              { x: 3000, y: 0 }
            ],
            mode: 'baseline',
            direction: 'vertical',
            offset: 500,
            spacing: 400
          }
        }
      })
    )
  ) as { entityRefs: unknown[]; status: string }
  assert.equal(chainBaseline.status, 'committed')
  assert.equal(chainBaseline.entityRefs.length, 4)
  console.log('entity.create(dimension.chain) -> continue 4 dims, baseline 4 dims, one batch each')

  const chainTooFewPoints = await client.callTool({
    name: 'entity',
    arguments: {
      operation: 'create',
      entity: {
        kind: 'dimension.chain',
        points: [{ x: 0, y: 0 }],
        mode: 'continue',
        direction: 'horizontal',
        offset: 500
      }
    }
  })
  assert.equal(chainTooFewPoints.isError, true, 'dimension.chain needs >= 2 points')

  const chainDuplicatePoints = await client.callTool({
    name: 'entity',
    arguments: {
      operation: 'create',
      entity: {
        kind: 'dimension.chain',
        points: [
          { x: 0, y: 0 },
          { x: 0, y: 0 },
          { x: 100, y: 0 }
        ],
        mode: 'continue',
        direction: 'horizontal',
        offset: 500
      }
    }
  })
  assert.equal(chainDuplicatePoints.isError, true, 'duplicate consecutive points are rejected')
  console.log(
    'entity.create(dimension.chain) -> too-few-points and duplicate-points both isError:true'
  )

  const hatch = await client.callTool({
    name: 'entity',
    arguments: {
      operation: 'create',
      entity: { kind: 'hatch', boundaryHandles: [created.entity.handle] }
    }
  })
  assert.equal(hatch.isError, undefined)
  // #58 regression: boundaryHandles behaves exactly as before — one loop, no `loops` recorded.
  const hatchParsed = JSON.parse(textOf(hatch as CallToolResult)) as {
    entity: { boundaryHandles?: string[]; loops?: unknown }
  }
  assert.deepEqual(hatchParsed.entity.boundaryHandles, [created.entity.handle])
  assert.equal(hatchParsed.entity.loops, undefined)
  console.log('entity.create(hatch, boundaryHandles) ->', textOf(hatch))

  const entityTotal = async () =>
    (
      JSON.parse(
        textOf(
          (await client.callTool({
            name: 'entity',
            arguments: { operation: 'list', limit: 1000 }
          })) as CallToolResult
        )
      ) as { total: number }
    ).total

  const totalBeforeRectHatch = await entityTotal()
  const rectHatch = await client.callTool({
    name: 'entity',
    arguments: {
      operation: 'create',
      entity: {
        kind: 'hatch',
        loops: [
          {
            points: [
              { x: 0, y: 0 },
              { x: 1000, y: 0 },
              { x: 1000, y: 1000 },
              { x: 0, y: 1000 }
            ]
          }
        ]
      }
    }
  })
  assert.equal(rectHatch.isError, undefined)
  const rectHatchParsed = JSON.parse(textOf(rectHatch as CallToolResult)) as {
    entity: { loops?: Array<{ loopType: string; source: string }> }
  }
  assert.deepEqual(rectHatchParsed.entity.loops, [{ loopType: 'Outermost', source: 'points' }])
  assert.equal(
    await entityTotal(),
    totalBeforeRectHatch + 1,
    'loops: [points] hatches a rectangle in one call — only the hatch is created, no boundary entity'
  )
  console.log(
    'entity.create(hatch, loops: [points 4-corners]) -> rectangle, no boundary entity,',
    textOf(rectHatch)
  )

  const islandHatch = await client.callTool({
    name: 'entity',
    arguments: {
      operation: 'create',
      entity: {
        kind: 'hatch',
        loops: [
          {
            points: [
              { x: 0, y: 0 },
              { x: 2000, y: 0 },
              { x: 2000, y: 2000 },
              { x: 0, y: 2000 }
            ]
          },
          { circle: { center: { x: 1000, y: 1000 }, radius: 300 } }
        ]
      }
    }
  })
  assert.equal(islandHatch.isError, undefined)
  const islandHatchParsed = JSON.parse(textOf(islandHatch as CallToolResult)) as {
    entity: { handle: string; loops?: Array<{ loopType: string; source: string }> }
  }
  // Outer rectangle + inner circle island: loop types assigned Outermost/Default and recorded
  // distinctly (a real-AutoCAD harness could check Hatch.Area against this same payload).
  assert.deepEqual(islandHatchParsed.entity.loops, [
    { loopType: 'Outermost', source: 'points' },
    { loopType: 'Default', source: 'circle' }
  ])
  console.log(
    'entity.create(hatch, outer rectangle + inner circle island) -> Outermost + Default recorded,',
    textOf(islandHatch)
  )

  // entity.area_measure: the island hatch above (2000x2000 mm outer minus a 300 mm-radius circle
  // island) is the honest end-to-end check — a real net-of-holes area, converted to m² because this
  // drawing declared insUnits mm at drawing.setup. The mock's number is its own shoelace/πr²
  // stand-in, not AutoCAD's Hatch.Area; the wiring (scope, status, conversion, refusal) is what this
  // proves. See docs/IMPLEMENTATION_STATUS.md for the real-AutoCAD repro steps.
  const measured = await client.callTool({
    name: 'entity',
    arguments: {
      operation: 'area_measure',
      handles: [islandHatchParsed.entity.handle],
      outputUnit: 'm2'
    }
  })
  assert.equal(measured.isError, undefined)
  const measuredParsed = JSON.parse(textOf(measured as CallToolResult)) as {
    insUnits: string
    convertedToM2: boolean
    regions: Array<{
      handle: string
      status: string
      method?: string
      areaDrawingUnits2?: number
      areaM2?: number
      loopCount?: number
      holeLoopCount?: number
    }>
  }
  assert.equal(measuredParsed.insUnits, 'mm')
  assert.equal(measuredParsed.convertedToM2, true)
  const islandRegion = measuredParsed.regions.find(
    (r) => r.handle === islandHatchParsed.entity.handle
  )!
  assert.equal(islandRegion.status, 'measured')
  assert.equal(islandRegion.method, 'hatch-area')
  assert.equal(islandRegion.loopCount, 2)
  assert.equal(islandRegion.holeLoopCount, 1)
  // 2000*2000 - π*300² = 4,000,000 - 282,743.3 ≈ 3,717,256.6 mm² ≈ 3.717 m².
  assert.ok(
    Math.abs(islandRegion.areaDrawingUnits2! - 3_717_256.637) < 1,
    'net-of-hole area in mm²'
  )
  assert.ok(Math.abs(islandRegion.areaM2! - 3.717257) < 1e-4, 'same area converted to m²')
  console.log('entity.area_measure(hatch island, outputUnit m2) ->', textOf(measured))

  const measureNoScope = await client.callTool({
    name: 'entity',
    arguments: { operation: 'area_measure' }
  })
  assert.equal(measureNoScope.isError, true, 'area_measure with no scope is rejected')
  console.log('entity.area_measure(no scope) -> isError:true')

  const hatchBothLoopFields = await client.callTool({
    name: 'entity',
    arguments: {
      operation: 'create',
      entity: {
        kind: 'hatch',
        boundaryHandles: [created.entity.handle],
        loops: [{ circle: { center: { x: 0, y: 0 }, radius: 100 } }]
      }
    }
  })
  assert.equal(hatchBothLoopFields.isError, true, 'boundaryHandles and loops together is rejected')
  console.log(
    'entity.create(hatch, boundaryHandles + loops together) -> isError:true,',
    textOf(hatchBothLoopFields as CallToolResult)
  )

  const moved = await client.callTool({
    name: 'entity',
    arguments: {
      operation: 'transform',
      transform: { op: 'move', handles: [created.entity.handle], delta: { x: 100, y: 0, z: 0 } }
    }
  })
  assert.equal(moved.isError, undefined)
  console.log('entity.transform(move) ->', textOf(moved))

  const missing = await client.callTool({
    name: 'entity',
    arguments: { operation: 'get', handle: 'FFFFFF' }
  })
  assert.equal(missing.isError, true)
  console.log('entity.get(missing) -> isError:true,', textOf(missing))

  const rejected = await client.callTool({
    name: 'entity',
    arguments: {
      operation: 'create',
      entity: { kind: 'circle', center: { x: 0, y: 0 }, radius: -5 }
    }
  })
  assert.equal(rejected.isError, true)
  console.log('entity.create(invalid radius) -> isError:true,', textOf(rejected))

  // entity.update (#26): in-place edit keeping the handle stable — common properties plus a
  // kind-specific geometry patch in one call, then read back to confirm it landed.
  const updateCircleCreated = await client.callTool({
    name: 'entity',
    arguments: {
      operation: 'create',
      entity: { kind: 'circle', center: { x: 0, y: 0, z: 0 }, radius: 5 }
    }
  })
  const updateCircleHandle = (
    JSON.parse(textOf(updateCircleCreated)) as { entity: { handle: string } }
  ).entity.handle

  const updated = await client.callTool({
    name: 'entity',
    arguments: {
      operation: 'update',
      handle: updateCircleHandle,
      layer: 'A-WALL',
      linetype: 'DASHED',
      geometry: { kind: 'circle', radius: 10 }
    }
  })
  assert.equal(updated.isError, undefined)
  const updatedEntity = JSON.parse(textOf(updated)) as {
    entity: { handle: string; layer: string }
  }
  assert.equal(
    updatedEntity.entity.handle,
    updateCircleHandle,
    'entity.update keeps the handle stable'
  )
  assert.equal(updatedEntity.entity.layer, 'A-WALL')
  console.log(
    'entity.update(circle: radius 5 -> 10, layer -> A-WALL, linetype -> DASHED) ->',
    textOf(updated)
  )

  const updateReadBack = await client.callTool({
    name: 'entity',
    arguments: { operation: 'get', handle: updateCircleHandle }
  })
  const readBack = JSON.parse(textOf(updateReadBack)) as {
    entity: { layer: string; bounds?: { min: { x: number }; max: { x: number } } }
  }
  assert.equal(readBack.entity.layer, 'A-WALL')
  assert.equal(readBack.entity.bounds?.min.x, -10, 'radius change took effect (bounds widened)')
  assert.equal(readBack.entity.bounds?.max.x, 10)
  console.log(
    'entity.get(after update) -> radius change confirmed via bounds,',
    textOf(updateReadBack)
  )

  const updateKindMismatch = await client.callTool({
    name: 'entity',
    arguments: {
      operation: 'update',
      handle: updateCircleHandle,
      geometry: { kind: 'line', start: { x: 0, y: 0, z: 0 }, end: { x: 1, y: 1, z: 0 } }
    }
  })
  assert.equal(
    updateKindMismatch.isError,
    true,
    "geometry.kind mismatched with the handle's actual kind is rejected"
  )
  console.log(
    'entity.update(geometry.kind mismatched with actual kind) -> isError:true,',
    textOf(updateKindMismatch)
  )

  const batchA = await client.callTool({
    name: 'operations',
    arguments: {
      operation: 'apply',
      operations: [
        { op: 'create', entity: { kind: 'circle', center: { x: -1000, y: 0, z: 0 }, radius: 50 } },
        {
          op: 'create',
          entity: { kind: 'circle', center: { x: -1000, y: 200, z: 0 }, radius: 50 }
        }
      ]
    }
  })
  assert.equal(batchA.isError, undefined)
  const batchAText = textOf(batchA)
  console.log('operations.apply(batchA) ->', batchAText)
  const parsedBatchA = JSON.parse(batchAText) as { batchId: string; status: string }
  assert.equal(parsedBatchA.status, 'committed')

  const batchB = await client.callTool({
    name: 'operations',
    arguments: {
      operation: 'apply',
      operations: [
        {
          op: 'create',
          entity: { kind: 'circle', center: { x: -1000, y: 400, z: 0 }, radius: 50 }
        }
      ]
    }
  })
  assert.equal(batchB.isError, undefined)
  const parsedBatchB = JSON.parse(textOf(batchB)) as { batchId: string; status: string }
  console.log('operations.apply(batchB) ->', textOf(batchB))

  const undoNotTop = await client.callTool({
    name: 'operations',
    arguments: { operation: 'undo', batchId: parsedBatchA.batchId }
  })
  assert.equal(undoNotTop.isError, true)
  console.log('operations.undo(batchA, not top) -> isError:true,', textOf(undoNotTop))

  const undone = await client.callTool({
    name: 'operations',
    arguments: { operation: 'undo', batchId: parsedBatchB.batchId }
  })
  assert.equal(undone.isError, undefined)
  console.log('operations.undo(batchB) ->', textOf(undone))

  const redone = await client.callTool({
    name: 'operations',
    arguments: { operation: 'redo', batchId: parsedBatchB.batchId }
  })
  assert.equal(redone.isError, undefined)
  console.log('operations.redo(batchB) ->', textOf(redone))

  const history = await client.callTool({
    name: 'operations',
    arguments: { operation: 'history', limit: 10 }
  })
  assert.equal(history.isError, undefined)
  console.log('operations.history ->', textOf(history))

  // Forgiving inputs (#71): aliases, [x,y] points, ensureLayer, degrees.
  const forgiving = await client.callTool({
    name: 'entity',
    arguments: {
      operation: 'create',
      entity: { kind: 'rect', layer: 'A-NEW', corner1: [0, 0], corner2: [4000, 3000] },
      ensureLayer: true
    }
  })
  const forgivingResult = JSON.parse(textOf(forgiving)) as {
    entity: { kind: string }
    createdLayers: string[]
  }
  assert.equal(forgivingResult.entity.kind, 'rectangle', 'alias kind is sent canonical')
  assert.deepStrictEqual(forgivingResult.createdLayers, ['A-NEW'])
  const missingLayer = await client.callTool({
    name: 'entity',
    arguments: {
      operation: 'create',
      entity: { kind: 'line', layer: 'NOPE', start: [0, 0], end: [1, 1] }
    }
  })
  assert.equal(
    (missingLayer.structuredContent as { error: { name: string } }).error.name,
    'LayerNotFound'
  )
  const aborted = JSON.parse(
    textOf(
      await client.callTool({
        name: 'operations',
        arguments: {
          operation: 'apply',
          operations: [
            { op: 'create', entity: { kind: 'line', start: [0, 0], end: [1, 0] } },
            { op: 'create', entity: { kind: 'line', layer: 'NOPE', start: [0, 0], end: [0, 1] } }
          ]
        }
      })
    )
  ) as { status: string; error: { failedStep: number; causeCode: number; hint: string } }
  assert.equal(aborted.status, 'aborted')
  assert.equal(aborted.error.failedStep, 1)
  assert.equal(aborted.error.causeCode, -32004)
  assert.match(aborted.error.hint, /Create the layer first/)
  console.log(
    'forgiving inputs -> rect alias, [x,y] points, ensureLayer, failedStep/causeCode/hint'
  )

  // construct (#21): intents expanded server-side into one batch.
  const dryRun = JSON.parse(
    textOf(
      await client.callTool({
        name: 'construct',
        arguments: {
          operation: 'walls',
          centerline: [
            [0, 0],
            [4000, 0],
            [4000, 3000]
          ],
          thickness: 200,
          dryRun: true
        }
      })
    )
  ) as { dryRun: boolean; stepCount: number }
  assert.deepStrictEqual([dryRun.dryRun, dryRun.stepCount], [true, 1])
  const gridResult = JSON.parse(
    textOf(
      await client.callTool({
        name: 'construct',
        arguments: {
          operation: 'grid',
          origin: [0, 0],
          x: { count: 4, spacing: 6000 },
          y: { spacings: [5000, 5000] },
          extension: 1500,
          bubbleRadius: 400,
          layer: 'S-GRID',
          ensureLayer: true,
          // 21 steps: over the bulk-review bar, so the call has to look at what it drew.
          capture: 'changed'
        }
      })
    )
  ) as {
    status: string
    batchId: string
    elements: Record<string, string>
    createdLayers: string[]
  }
  assert.equal(gridResult.status, 'committed')
  assert.deepStrictEqual(gridResult.createdLayers, ['S-GRID'])
  assert.equal(Object.keys(gridResult.elements).length, (4 + 3) * 3)
  assert.ok(gridResult.elements['grid.axis.C'], 'elements map names each generated entity')
  const gridUndo = await client.callTool({
    name: 'operations',
    arguments: { operation: 'undo', batchId: gridResult.batchId }
  })
  assert.equal(gridUndo.isError, undefined, 'a construct call is one undoable batch')
  console.log('construct -> walls dryRun, grid in one batch (21 entities, elements map), one undo')

  // Presets (#57) and dimension chains (#59) solve server-side into plain primitives.
  const polygon = JSON.parse(
    textOf(
      await client.callTool({
        name: 'entity',
        arguments: {
          operation: 'create',
          entity: { kind: 'polygon', center: [0, 0], sides: 6, radius: 50 }
        }
      })
    )
  ) as { entity: { kind: string } }
  assert.equal(polygon.entity.kind, 'polyline')
  const filletRect = JSON.parse(
    textOf(
      await client.callTool({
        name: 'entity',
        arguments: {
          operation: 'create',
          entity: {
            kind: 'rectangle',
            corner1: [0, 0],
            corner2: [100, 50],
            rotation: Math.PI / 6,
            fillet: 10
          }
        }
      })
    )
  ) as { entity: { kind: string } }
  assert.equal(filletRect.entity.kind, 'polyline')
  const filletAndChamfer = await client.callTool({
    name: 'entity',
    arguments: {
      operation: 'create',
      entity: {
        kind: 'rectangle',
        corner1: [0, 0],
        corner2: [10, 10],
        fillet: 2,
        chamfer: { d1: 1, d2: 1 }
      }
    }
  })
  assert.equal(filletAndChamfer.isError, true, 'fillet and chamfer are mutually exclusive')
  const donut = JSON.parse(
    textOf(
      await client.callTool({
        name: 'entity',
        arguments: {
          operation: 'create',
          entity: { kind: 'donut', center: [0, 0], innerDiameter: 20, outerDiameter: 40 }
        }
      })
    )
  ) as { entity: { kind: string } }
  assert.equal(donut.entity.kind, 'polyline')
  const badDonut = await client.callTool({
    name: 'entity',
    arguments: {
      operation: 'create',
      entity: { kind: 'donut', center: [0, 0], innerDiameter: 40, outerDiameter: 20 }
    }
  })
  assert.equal(badDonut.isError, true, 'outerDiameter must exceed innerDiameter')
  const polygonEdge = JSON.parse(
    textOf(
      await client.callTool({
        name: 'entity',
        arguments: {
          operation: 'create',
          entity: { kind: 'polygon.edge', edgeStart: [10, 0], edgeEnd: [5, 8.660254], sides: 6 }
        }
      })
    )
  ) as { entity: { kind: string } }
  assert.equal(polygonEdge.entity.kind, 'polyline')
  console.log(
    'shape presets -> fillet+chamfer mutual exclusion, donut, polygon.edge all wire to polyline'
  )

  const collinear = await client.callTool({
    name: 'entity',
    arguments: {
      operation: 'create',
      entity: { kind: 'arc.threePoint', start: [0, 0], mid: [1, 1], end: [2, 2] }
    }
  })
  assert.equal(
    (collinear.structuredContent as { error: { name: string } }).error.name,
    'InvalidGeometry'
  )
  const chain = JSON.parse(
    textOf(
      await client.callTool({
        name: 'construct',
        arguments: {
          operation: 'dimensions',
          points: [
            [0, 0],
            [900, 0],
            [2400, 0],
            [4000, 0]
          ],
          mode: 'continue',
          direction: 'horizontal',
          offset: -800
        }
      })
    )
  ) as { status: string; elements: Record<string, string> }
  assert.equal(chain.status, 'committed')
  assert.equal(Object.keys(chain.elements).length, 3)
  console.log(
    'presets + dimension chain -> polygon as polyline, collinear arc InvalidGeometry, 3 dims in one batch'
  )

  // Arrays (#20): one step, plugin-side clones; over-cap arrays rejected before AutoCAD.
  const column = JSON.parse(
    textOf(
      await client.callTool({
        name: 'entity',
        arguments: { operation: 'create', entity: { kind: 'circle', center: [0, 0], radius: 200 } }
      })
    )
  ) as { entity: { handle: string } }
  const gridArray = JSON.parse(
    textOf(
      await client.callTool({
        name: 'operations',
        arguments: {
          operation: 'apply',
          operations: [
            {
              op: 'transform',
              transform: {
                op: 'arrayRect',
                handles: [column.entity.handle],
                rows: 10,
                columns: 10,
                rowSpacing: 6000,
                columnSpacing: 6000
              }
            }
          ],
          result: 'handles'
        }
      })
    )
  ) as { status: string; entityRefs: { count: number } }
  assert.equal(gridArray.status, 'committed')
  assert.equal(gridArray.entityRefs.count, 99, '10×10 array = 99 new copies in one step')
  const tooBig = await client.callTool({
    name: 'entity',
    arguments: {
      operation: 'transform',
      transform: {
        op: 'arrayRect',
        handles: [column.entity.handle],
        rows: 100,
        columns: 100,
        rowSpacing: 1,
        columnSpacing: 1
      }
    }
  })
  assert.equal(
    (tooBig.structuredContent as { error: { name: string } }).error.name,
    'InvalidGeometry'
  )
  console.log('arrays -> 10×10 arrayRect = 99 copies in one batch step, 100×100 rejected')

  // Path array (#20): equal arc-length spacing along a handle's curve or explicit points.
  const railPolyline = JSON.parse(
    textOf(
      await client.callTool({
        name: 'entity',
        arguments: {
          operation: 'create',
          entity: {
            kind: 'polyline',
            points: [
              [0, 0],
              [10000, 0],
              [10000, 10000]
            ]
          }
        }
      })
    )
  ) as { entity: { handle: string } }
  const bolt = JSON.parse(
    textOf(
      await client.callTool({
        name: 'entity',
        arguments: {
          operation: 'create',
          entity: { kind: 'circle', center: [-500, -500], radius: 50 }
        }
      })
    )
  ) as { entity: { handle: string } }
  const pathByCount = JSON.parse(
    textOf(
      await client.callTool({
        name: 'entity',
        arguments: {
          operation: 'transform',
          transform: {
            op: 'arrayPath',
            handles: [bolt.entity.handle],
            path: { handle: railPolyline.entity.handle },
            count: 5
          },
          result: 'handles'
        }
      })
    )
  ) as { affected: { count: number } }
  assert.equal(pathByCount.affected.count, 4, 'count 5 along the 3-point rail = 4 new copies')
  const pathBySpacing = JSON.parse(
    textOf(
      await client.callTool({
        name: 'entity',
        arguments: {
          operation: 'transform',
          transform: {
            op: 'arrayPath',
            handles: [bolt.entity.handle],
            path: {
              points: [
                [0, 0],
                [1200, 0]
              ]
            },
            spacing: 300
          },
          result: 'handles'
        }
      })
    )
  ) as { affected: { count: number } }
  assert.equal(pathBySpacing.affected.count, 4, 'spacing 300 over length 1200 = 4 new copies')
  const pathTooBig = await client.callTool({
    name: 'entity',
    arguments: {
      operation: 'transform',
      transform: {
        op: 'arrayPath',
        handles: [bolt.entity.handle],
        path: { handle: railPolyline.entity.handle },
        spacing: 0.001
      }
    }
  })
  assert.equal(
    (pathTooBig.structuredContent as { error: { name: string } }).error.name,
    'InvalidGeometry'
  )
  console.log(
    'arrays -> arrayPath count/spacing along a handle/points path place the expected copies, tiny spacing over-cap rejected'
  )

  const guideTool = await client.callTool({ name: 'guide', arguments: {} })
  assert.match(textOf(guideTool), /## Rules/)
  const guideTopic = await client.callTool({ name: 'guide', arguments: { topic: 'errors' } })
  assert.match(textOf(guideTopic), /# Errors and recovery/)
  console.log('guide tool -> workflow + topic references')

  // Result-size controls (#72): big batches default to a handle list, summary stays tiny.
  const circles = (count: number, y: number) =>
    Array.from({ length: count }, (_, i) => ({
      op: 'create',
      entity: { kind: 'circle', center: { x: i * 100, y, z: 0 }, radius: 10 }
    }))
  const bigBatch = await client.callTool({
    name: 'operations',
    arguments: {
      operation: 'apply',
      operations: circles(30, 5000),
      // report §5.4: a 20+ entity batch must be looked at, or explicitly declared unviewable.
      capture: 'changed'
    }
  })
  const bigRefs = (
    JSON.parse(textOf(bigBatch)) as { entityRefs: { count: number; handles: string[] } }
  ).entityRefs
  assert.equal(bigRefs.count, 30)
  assert.equal(bigRefs.handles.length, 30, 'above 20 refs the default is a handle list')
  const summaryBatch = await client.callTool({
    name: 'operations',
    arguments: {
      operation: 'apply',
      operations: circles(300, 6000),
      result: 'summary',
      visualReview: 'unavailable'
    }
  })
  const summaryText = textOf(summaryBatch)
  assert.ok(
    summaryText.length < 1024,
    `300-step summary should be < 1 KB, was ${summaryText.length}`
  )
  console.log('operations.apply(300 steps, summary) ->', summaryText)

  // operations.apply progressive: true (autocad-mcp#67) — the mock can't simulate frame timing
  // or intermediate repaints (that's real-AutoCAD-only, see LiveView.cs/OperationsHandlers.cs),
  // but it must still accept the field and run the batch atomically like any other apply.
  const progressiveBatch = await client.callTool({
    name: 'operations',
    arguments: {
      operation: 'apply',
      operations: circles(300, 8000),
      progressive: true,
      paceMs: 5,
      view: { follow: 'fit' },
      visualReview: 'unavailable',
      result: 'summary'
    }
  })
  assert.equal(progressiveBatch.isError, undefined)
  assert.match(textOf(progressiveBatch), /"status":"committed"/)
  console.log('operations.apply(300 steps, progressive:true) ->', textOf(progressiveBatch))

  // operations.apply id/@ref (#19): a closed outline (id "outline", compact [x,y] points) is
  // hatched and copied via "@outline" — step 2 needs outline's real handle, which only exists
  // once step 1 has actually run, so this one tool call becomes two operations.apply requests to
  // the bridge; status/entityRefs still cover the whole chain as one result.
  const refChain = await client.callTool({
    name: 'operations',
    arguments: {
      operation: 'apply',
      operations: [
        {
          op: 'create',
          id: 'outline',
          entity: {
            kind: 'polyline',
            points: [
              [0, 0],
              [10, 0],
              [10, 10],
              [0, 10]
            ],
            closed: true
          }
        },
        {
          op: 'create',
          entity: { kind: 'hatch', boundaryHandles: ['@outline'], pattern: 'ANSI31' }
        },
        { op: 'transform', transform: { op: 'copy', handles: ['@outline'], delta: [20, 0] } }
      ],
      documentName: 'Drawing2.dwg'
    }
  })
  const refChainBody = JSON.parse(textOf(refChain)) as { status: string; entityRefs: unknown[] }
  assert.equal(refChainBody.status, 'committed')
  assert.equal(refChainBody.entityRefs.length, 3) // outline + hatch + copy
  console.log('operations.apply(id/@ref chain: outline -> hatch -> copy) ->', textOf(refChain))

  // operations.apply defaults.layer (#19): every create step that omits layer picks it up; a
  // step's own explicit layer still wins.
  const defaultsBatch = await client.callTool({
    name: 'operations',
    arguments: {
      operation: 'apply',
      operations: [
        { op: 'create', entity: { kind: 'circle', center: [0, -50], radius: 1 } },
        {
          op: 'create',
          entity: { kind: 'circle', center: [5, -50], radius: 1, layer: 'OVERRIDE' }
        }
      ],
      defaults: { layer: 'SHELVING' },
      ensureLayer: true,
      documentName: 'Drawing2.dwg'
    }
  })
  const defaultsBody = JSON.parse(textOf(defaultsBatch)) as {
    entityRefs: { layer: string }[]
    createdLayers?: string[]
  }
  assert.equal(defaultsBody.entityRefs[0]!.layer, 'SHELVING')
  assert.equal(defaultsBody.entityRefs[1]!.layer, 'OVERRIDE')
  assert.ok(defaultsBody.createdLayers?.includes('SHELVING'))
  console.log('operations.apply(defaults.layer) ->', textOf(defaultsBatch))

  const projected = await client.callTool({
    name: 'entity',
    arguments: { operation: 'list', limit: 2, fields: ['handle', 'layer'] }
  })
  const projectedEntities = (JSON.parse(textOf(projected)) as { entities: object[] }).entities
  assert.deepStrictEqual(Object.keys(projectedEntities[0] ?? {}).sort(), ['handle', 'layer'])
  const badField = await client.callTool({
    name: 'entity',
    arguments: { operation: 'list', fields: ['colour'] }
  })
  assert.equal(badField.isError, true, 'unknown projection fields are rejected')

  // entity.list includeBounds/limit cap (#10): includeBounds omitted/true keeps computing and
  // returning bounds as before; includeBounds: false drops bounds from every returned entity
  // without changing which entities, in what order, or the total count — proven here via
  // MockBridgeClient's real filter+count+page pipeline, not a timing measurement (no real
  // AutoCAD in this environment; see docs/IMPLEMENTATION_STATUS.md). A limit above the
  // server-side cap is rejected outright rather than silently clamped.
  const boundedList = await client.callTool({
    name: 'entity',
    arguments: { operation: 'list', limit: 3 }
  })
  const boundedParsed = JSON.parse(textOf(boundedList)) as {
    entities: { handle: string; bounds?: unknown }[]
    total: number
  }
  assert.ok(
    boundedParsed.entities.some((e) => e.bounds !== undefined),
    'includeBounds defaults to true: at least one entity keeps its bounds'
  )
  const noBoundsList = await client.callTool({
    name: 'entity',
    arguments: { operation: 'list', limit: 3, includeBounds: false }
  })
  const noBoundsParsed = JSON.parse(textOf(noBoundsList)) as {
    entities: { handle: string; bounds?: unknown }[]
    total: number
  }
  assert.ok(
    noBoundsParsed.entities.every((e) => e.bounds === undefined),
    'includeBounds: false must omit bounds from every entity'
  )
  assert.deepStrictEqual(
    noBoundsParsed.entities.map((e) => e.handle),
    boundedParsed.entities.map((e) => e.handle),
    'includeBounds must not change which entities or ordering are returned'
  )
  assert.equal(
    noBoundsParsed.total,
    boundedParsed.total,
    'includeBounds must not change the total count'
  )
  console.log('entity.list(includeBounds:false) ->', textOf(noBoundsList))

  const overCap = await client.callTool({
    name: 'entity',
    arguments: { operation: 'list', limit: 100000 }
  })
  assert.equal(
    overCap.isError,
    true,
    'entity.list limit above the server-side cap must be rejected'
  )
  console.log('entity.list(limit over cap) -> rejected as expected')

  // idempotencyKey (#9): a retry with the same key returns the original result instead of
  // duplicating the entity — the fix for "a timed-out mutation still commits, so a client retry
  // duplicates entities".
  const idemFirst = await client.callTool({
    name: 'entity',
    arguments: {
      operation: 'create',
      entity: { kind: 'circle', center: [5000, 5000], radius: 25 },
      idempotencyKey: 'smoke-retry-1'
    }
  })
  const idemRetry = await client.callTool({
    name: 'entity',
    arguments: {
      operation: 'create',
      entity: { kind: 'circle', center: [5000, 5000], radius: 25 },
      idempotencyKey: 'smoke-retry-1'
    }
  })
  const idemFirstParsed = JSON.parse(textOf(idemFirst)) as { entity: { handle: string } }
  const idemRetryParsed = JSON.parse(textOf(idemRetry)) as { entity: { handle: string } }
  assert.equal(
    idemRetryParsed.entity.handle,
    idemFirstParsed.entity.handle,
    'a repeated idempotencyKey must return the original entity, not create a second one'
  )
  console.log(
    'entity.create(idempotencyKey retry) -> same handle',
    idemFirstParsed.entity.handle,
    'both times'
  )

  const layerNames = await client.callTool({
    name: 'layer',
    arguments: { operation: 'list', fields: ['name'] }
  })
  console.log('layer.list(fields=[name]) ->', textOf(layerNames))

  // Annotative text/dimensions/hatch + annotation scale (#74): drawing.setup's annotationScale
  // sets CANNOSCALE, drawing.info reports it, an annotative mtext's paperHeight (mm on paper)
  // computes the model-space height from it, and entity.create defaults annotative to true from
  // here on for this document's mtext/text.singleLine/dimension.*/hatch kinds. Run last — it
  // mutates the active document's annotation scale and entity count, which earlier "clean
  // baseline"/exact-count assertions above depend on staying untouched.
  const setupAnnotationScale = await client.callTool({
    name: 'drawing',
    arguments: { operation: 'setup', annotationScale: '1:100' }
  })
  assert.equal(setupAnnotationScale.isError, undefined)
  const annotationScaleResult = JSON.parse(textOf(setupAnnotationScale)) as {
    annotationScale: string
  }
  assert.equal(annotationScaleResult.annotationScale, '1:100')
  console.log('drawing.setup(annotationScale:1:100) ->', textOf(setupAnnotationScale))

  const infoAfterAnnotationScale = await client.callTool({
    name: 'drawing',
    arguments: { operation: 'info' }
  })
  const infoParsed = JSON.parse(textOf(infoAfterAnnotationScale)) as { annotationScale: string }
  assert.equal(infoParsed.annotationScale, '1:100', 'drawing.info reports the current CANNOSCALE')
  console.log('drawing.info(after annotationScale) ->', textOf(infoAfterAnnotationScale))

  const annotativeMText = await client.callTool({
    name: 'entity',
    arguments: {
      operation: 'create',
      entity: {
        kind: 'mtext',
        insertion: { x: 0, y: 0, z: 0 },
        text: 'NOTE',
        paperHeight: 2.5,
        annotative: true
      }
    }
  })
  assert.equal(annotativeMText.isError, undefined)
  const annotativeMTextParsed = JSON.parse(textOf(annotativeMText)) as {
    entity: { annotative?: boolean; paperHeight?: number; height?: number }
  }
  assert.equal(
    annotativeMTextParsed.entity.height,
    250,
    'paperHeight 2.5mm at 1:100 computes to 250 drawing units'
  )
  assert.equal(annotativeMTextParsed.entity.annotative, true)
  console.log('entity.create(mtext, paperHeight:2.5, annotative:true) ->', textOf(annotativeMText))

  const defaultAnnotativeDim = await client.callTool({
    name: 'entity',
    arguments: {
      operation: 'create',
      entity: {
        kind: 'dimension.aligned',
        extLine1: { x: 0, y: 0, z: 0 },
        extLine2: { x: 1000, y: 0, z: 0 },
        dimLinePoint: { x: 0, y: 200, z: 0 }
      }
    }
  })
  const defaultAnnotativeDimParsed = JSON.parse(textOf(defaultAnnotativeDim)) as {
    entity: { annotative?: boolean }
  }
  assert.equal(
    defaultAnnotativeDimParsed.entity.annotative,
    true,
    'dimension.aligned defaults to annotative:true once annotationScale has been set, with no annotative field passed'
  )
  console.log(
    'entity.create(dimension.aligned, no annotative given) -> defaults annotative:true,',
    textOf(defaultAnnotativeDim)
  )

  // entity.get/entity.list detail:"full" (#25): one of each creatable kind, read back with
  // detail:"full" and checked against what was actually passed to entity.create — proving the
  // geometry/properties round-trip, not just that *a* response came back. detail omitted/"summary"
  // is asserted first, against an entity already created above, to pin backwards compatibility
  // (today's EntitySummary shape, byte-for-byte) before touching the new code path at all.
  const regressionSeed = await client.callTool({
    name: 'entity',
    arguments: {
      operation: 'create',
      entity: { kind: 'circle', center: { x: 0, y: 0, z: 0 }, radius: 1 }
    }
  })
  const regressionHandle = (JSON.parse(textOf(regressionSeed)) as { entity: { handle: string } })
    .entity.handle
  const summaryRegression = await client.callTool({
    name: 'entity',
    arguments: { operation: 'get', handle: regressionHandle }
  })
  assert.equal(summaryRegression.isError, undefined)
  const summaryRegressionParsed = JSON.parse(textOf(summaryRegression)) as {
    entity: Record<string, unknown>
  }
  assert.deepStrictEqual(
    Object.keys(summaryRegressionParsed.entity).sort(),
    ['bounds', 'handle', 'kind', 'layer'],
    "entity.get with detail omitted must return exactly today's EntitySummary shape"
  )
  console.log(
    'entity.get(detail omitted) -> unchanged EntitySummary shape,',
    textOf(summaryRegression)
  )

  async function createAndGetFull(entity: Record<string, unknown>): Promise<{
    kind: string
    geometry: Record<string, unknown>
    properties: Record<string, unknown>
  }> {
    const created = await client.callTool({
      name: 'entity',
      arguments: { operation: 'create', entity }
    })
    assert.equal(created.isError, undefined, `entity.create(${String(entity.kind)}) must succeed`)
    const createdHandle = (JSON.parse(textOf(created)) as { entity: { handle: string } }).entity
      .handle
    const got = await client.callTool({
      name: 'entity',
      arguments: { operation: 'get', handle: createdHandle, detail: 'full' }
    })
    assert.equal(
      got.isError,
      undefined,
      `entity.get(detail:"full") on a ${String(entity.kind)} must succeed`
    )
    return (
      JSON.parse(textOf(got)) as {
        entity: {
          kind: string
          geometry: Record<string, unknown>
          properties: Record<string, unknown>
        }
      }
    ).entity
  }

  const lineDetail = await createAndGetFull({
    kind: 'line',
    start: { x: 0, y: 0, z: 0 },
    end: { x: 100, y: 0, z: 0 }
  })
  assert.equal(lineDetail.kind, 'line')
  assert.deepStrictEqual(lineDetail.geometry.start, { x: 0, y: 0, z: 0 })
  assert.deepStrictEqual(lineDetail.geometry.end, { x: 100, y: 0, z: 0 })
  assert.equal(lineDetail.geometry.length, 100)
  assert.deepStrictEqual(lineDetail.properties.color, { aci: 256 })

  const circleDetail = await createAndGetFull({
    kind: 'circle',
    center: { x: 5, y: 5, z: 0 },
    radius: 25
  })
  assert.equal(circleDetail.kind, 'circle')
  assert.deepStrictEqual(circleDetail.geometry.center, { x: 5, y: 5, z: 0 })
  assert.equal(circleDetail.geometry.radius, 25)

  const arcDetail = await createAndGetFull({
    kind: 'arc',
    center: { x: 0, y: 0, z: 0 },
    radius: 10,
    startAngle: 0,
    endAngle: Math.PI / 2
  })
  assert.equal(arcDetail.kind, 'arc')
  assert.equal(arcDetail.geometry.radius, 10)
  assert.equal(arcDetail.geometry.startAngle, 0)
  assert.equal(arcDetail.geometry.endAngle, Math.PI / 2)

  const polylineDetail = await createAndGetFull({
    kind: 'polyline',
    points: [
      { x: 0, y: 0, z: 0 },
      { x: 10, y: 0, z: 0 },
      { x: 10, y: 10, z: 0 },
      { x: 0, y: 10, z: 0 }
    ],
    closed: true
  })
  assert.equal(polylineDetail.kind, 'polyline')
  assert.equal((polylineDetail.geometry.vertices as unknown[]).length, 4)
  assert.equal(polylineDetail.geometry.closed, true)
  assert.equal(polylineDetail.geometry.area, 100)

  const rectangleDetail = await createAndGetFull({
    kind: 'rectangle',
    corner1: { x: 0, y: 0, z: 0 },
    corner2: { x: 40, y: 30, z: 0 }
  })
  assert.equal(
    rectangleDetail.kind,
    'polyline',
    'a created rectangle reads back as kind "polyline" (documented AutoCAD behavior)'
  )
  assert.equal(rectangleDetail.geometry.area, 1200)

  const mtextDetail = await createAndGetFull({
    kind: 'mtext',
    insertion: { x: 1, y: 2, z: 0 },
    text: 'NOTE A',
    height: 5
  })
  assert.equal(mtextDetail.kind, 'mtext')
  assert.equal(mtextDetail.geometry.text, 'NOTE A')
  assert.equal(mtextDetail.geometry.height, 5)

  const singleLineTextDetail = await createAndGetFull({
    kind: 'text.singleLine',
    insertion: { x: 0, y: -600, z: 0 },
    text: 'PUMP-205',
    height: 3.5,
    rotation: 0,
    annotative: false
  })
  assert.equal(singleLineTextDetail.kind, 'text.singleLine')
  assert.equal(singleLineTextDetail.geometry.text, 'PUMP-205')
  assert.equal(singleLineTextDetail.geometry.height, 3.5)
  assert.equal(singleLineTextDetail.geometry.style, 'Standard')

  const blockRefDetail = await createAndGetFull({
    kind: 'blockReference',
    blockName: 'PUMP',
    position: { x: 9000, y: 9000, z: 0 },
    attributes: { TAG: 'P-205' }
  })
  assert.equal(blockRefDetail.kind, 'blockReference')
  assert.equal(blockRefDetail.geometry.blockName, 'PUMP')
  assert.deepStrictEqual(blockRefDetail.geometry.position, { x: 9000, y: 9000, z: 0 })

  const linearDimDetail = await createAndGetFull({
    kind: 'dimension.linear',
    extLine1: { x: 0, y: 0, z: 0 },
    extLine2: { x: 60, y: 0, z: 0 },
    dimLinePoint: { x: 0, y: -10, z: 0 }
  })
  assert.equal(linearDimDetail.kind, 'dimension.linear')
  assert.equal(
    linearDimDetail.geometry.measurement,
    60,
    "dimension.linear's measurement is the actual computed distance, not an echo of the input points"
  )

  const alignedDimDetail = await createAndGetFull({
    kind: 'dimension.aligned',
    extLine1: { x: 0, y: 0, z: 0 },
    extLine2: { x: 30, y: 40, z: 0 },
    dimLinePoint: { x: -10, y: 0, z: 0 }
  })
  assert.equal(alignedDimDetail.kind, 'dimension.aligned')
  assert.equal(alignedDimDetail.geometry.measurement, 50)

  const ordinateDimDetail = await createAndGetFull({
    kind: 'dimension.ordinate',
    origin: { x: 0, y: 0, z: 0 },
    featurePoint: { x: 500, y: 200, z: 0 },
    leaderEndPoint: { x: 500, y: 600, z: 0 },
    axis: 'x'
  })
  assert.equal(ordinateDimDetail.kind, 'dimension.ordinate')
  assert.equal(ordinateDimDetail.geometry.measurement, 500)

  const hatchBoundary = await client.callTool({
    name: 'entity',
    arguments: {
      operation: 'create',
      entity: {
        kind: 'polyline',
        points: [
          { x: 0, y: 0, z: 0 },
          { x: 20, y: 0, z: 0 },
          { x: 20, y: 20, z: 0 },
          { x: 0, y: 20, z: 0 }
        ],
        closed: true
      }
    }
  })
  const hatchBoundaryHandle = (JSON.parse(textOf(hatchBoundary)) as { entity: { handle: string } })
    .entity.handle
  const hatchDetail = await createAndGetFull({
    kind: 'hatch',
    boundaryHandles: [hatchBoundaryHandle],
    pattern: 'ANSI31',
    patternScale: 1.5
  })
  assert.equal(hatchDetail.kind, 'hatch')
  assert.equal(hatchDetail.geometry.pattern, 'ANSI31')
  assert.equal(hatchDetail.geometry.patternScale, 1.5)
  assert.equal(hatchDetail.geometry.loopCount, 1)
  console.log(
    'entity.get(detail:"full") -> geometry/properties round-trip verified for line, circle, arc, ' +
      'polyline, rectangle(->polyline), mtext, text.singleLine, blockReference, dimension.linear/' +
      'aligned/ordinate, hatch'
  )

  const fullList = await client.callTool({
    name: 'entity',
    arguments: { operation: 'list', kind: 'circle', limit: 1, detail: 'full' }
  })
  assert.equal(fullList.isError, undefined)
  const fullListParsed = JSON.parse(textOf(fullList)) as {
    entities: Array<{ geometry?: unknown; properties?: unknown }>
  }
  assert.ok(
    fullListParsed.entities[0]?.geometry,
    'entity.list detail:"full" must include geometry per entity'
  )
  assert.ok(
    fullListParsed.entities[0]?.properties,
    'entity.list detail:"full" must include properties per entity'
  )
  console.log('entity.list(detail:"full") ->', textOf(fullList))

  // drawing.info's `revision` is what Aleph Cloud binds a spatial-validation record to, so the
  // guard can tell whether the drawing moved between validation and commit. Over the real MCP
  // transport it must be present AND move on a mutation — a revision that never changes would make
  // the staleness check vacuously pass. Scoped to the background tab (Drawing2.dwg) so this probe
  // adds no entity to the active document, which later assertions count.
  const revisionBefore = (JSON.parse(textOf(drawingInfo)) as { revision?: string }).revision
  assert.equal(typeof revisionBefore, 'string', 'drawing.info reports a revision')
  assert.ok(
    revisionBefore && revisionBefore.startsWith('tdu:'),
    `unexpected revision form: ${revisionBefore}`
  )
  const backgroundInfoBefore = await client.callTool({
    name: 'drawing',
    arguments: { operation: 'info', documentName: 'Drawing2.dwg' }
  })
  const bgRevisionBefore = (JSON.parse(textOf(backgroundInfoBefore)) as { revision?: string })
    .revision
  await client.callTool({
    name: 'entity',
    arguments: {
      operation: 'create',
      entity: { kind: 'circle', center: { x: 0, y: 0 }, radius: 1 },
      documentName: 'Drawing2.dwg'
    }
  })
  const bgRevisionAfter = (
    JSON.parse(
      textOf(
        await client.callTool({
          name: 'drawing',
          arguments: { operation: 'info', documentName: 'Drawing2.dwg' }
        })
      )
    ) as { revision?: string }
  ).revision
  assert.notEqual(bgRevisionAfter, bgRevisionBefore, 'a mutation moves the revision')
  console.log(
    `drawing.info revision -> Drawing2.dwg ${bgRevisionBefore} then ${bgRevisionAfter} after entity.create`
  )

  // Legacy clients may still submit the retired design-validation ticket. The server accepts the
  // call and Zod silently strips the field (nothing forwards it to the native Bridge) — but it must
  // NOT appear in tools/list, so the model is never told a ticket is a prerequisite to mutating CAD
  // (#413: Design Guard is retired; native protections are independent of this field).
  const withTicket = await client.callTool({
    name: 'entity',
    arguments: {
      operation: 'create',
      entity: { kind: 'circle', center: { x: 5, y: 5 }, radius: 1 },
      validationId: 'svr_smoke_ticket'
    }
  })
  assert.equal(
    withTicket.isError,
    undefined,
    'a mutation carrying a legacy validationId is accepted'
  )
  const entityToolSchema = tools.tools.find((t) => t.name === 'entity')
  assert.ok(
    entityToolSchema &&
      !(
        'validationId' in
        ((entityToolSchema.inputSchema as { properties?: object }).properties ?? {})
      ),
    'tools/list does NOT advertise the retired validationId on the entity tool'
  )
  console.log(
    'entity.create(validationId) -> legacy ticket accepted & stripped; tools/list hides the field'
  )

  // The CAD State Engine's transport: `cad` scan/changes over the real MCP server + mock bridge.
  // This is the path the portable-schema flattening of the operation union used to reject (a
  // shared `limit` field with different bounds across operations), so it must round-trip here,
  // not just advertise. scan brackets the page with revisionBefore/revisionAfter; changes replays
  // the mock's change feed after a cursor.
  const scan = JSON.parse(
    textOf(await client.callTool({ name: 'cad', arguments: { operation: 'scan', limit: 50 } }))
  ) as {
    entities: { handle: string; kind: string; layer: string }[]
    total: number
    revisionBefore: string
    revisionAfter: string
  }
  assert.ok(Array.isArray(scan.entities), 'cad.scan returns an entities array')
  assert.ok(scan.total > 0, 'cad.scan reports a non-empty total for the active drawing')
  assert.equal(scan.revisionBefore, scan.revisionAfter, 'a single scan page is revision-consistent')
  console.log(
    `cad.scan -> ${scan.entities.length}/${scan.total} entities, revision ${scan.revisionBefore}`
  )
  const changes = JSON.parse(
    textOf(
      await client.callTool({ name: 'cad', arguments: { operation: 'changes', afterSequence: 0 } })
    )
  ) as {
    earliestSequence: number
    latestSequence: number
    changes: { sequence: number; operation: string; handles: string[] }[]
    hasMore: boolean
  }
  assert.ok(Array.isArray(changes.changes), 'cad.changes returns a changes array')
  assert.ok(
    changes.latestSequence >= changes.earliestSequence,
    'cad.changes sequence window is ordered'
  )
  console.log(
    `cad.changes -> ${changes.changes.length} events, sequence ${changes.earliestSequence}..${changes.latestSequence}`
  )
  // edit tool: begin -> preview -> discard
  const editLineCreated = await client.callTool({
    name: 'entity',
    arguments: {
      operation: 'create',
      validationId: 'val_smoke_edit',
      entity: {
        kind: 'line',
        start: { x: 0, y: 0, z: 0 },
        end: { x: 50, y: 0, z: 0 }
      }
    }
  })
  const editLineHandle = (
    JSON.parse(textOf(editLineCreated as CallToolResult)) as { entity: { handle: string } }
  ).entity.handle

  const editBegin = JSON.parse(
    textOf(
      await client.callTool({
        name: 'edit',
        arguments: {
          operation: 'begin',
          handles: [editLineHandle]
        }
      })
    )
  ) as { editId: string; candidates: { handle: string }[] }
  assert.ok(editBegin.editId, 'edit.begin returns an editId')
  assert.equal(editBegin.candidates.length, 1, 'edit.begin returns 1 candidate')

  const editPreview = JSON.parse(
    textOf(
      await client.callTool({
        name: 'edit',
        arguments: {
          operation: 'preview',
          editId: editBegin.editId
        }
      })
    )
  ) as { diff: { diffDigest: string; candidateCount: number } }
  assert.ok(editPreview.diff.diffDigest, 'edit.preview returns a diffDigest')

  const editStatus = JSON.parse(
    textOf(
      await client.callTool({
        name: 'edit',
        arguments: {
          operation: 'status',
          editId: editBegin.editId
        }
      })
    )
  ) as { editId: string; status: string }
  assert.equal(editStatus.editId, editBegin.editId, 'edit.status returns editId')
  assert.ok(editStatus.status, 'edit.status returns status')

  const editDiscard = JSON.parse(
    textOf(
      await client.callTool({
        name: 'edit',
        arguments: {
          operation: 'discard',
          editId: editBegin.editId
        }
      })
    )
  ) as { status: string }
  assert.equal(editDiscard.status, 'discarded', 'edit.discard status is discarded')
  console.log('edit tool -> begin, preview, status, discard verified')

  await client.close()
  await server.close()
  await bridge.close()
  console.log('\nsmoke test passed')
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
