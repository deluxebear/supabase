# pg_durable Flow Diagram Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render pg_durable workflows as a flow diagram (DAG) in the workflow detail sheet (runtime, status-colored, Graph/List toggle) and as a live preview in the create-workflow sheet (builder mode).

**Architecture:** A source-agnostic `FlowGraph` model with two pure adapters (`treeToFlowGraph` from the existing `buildNodeTree` output, `formToFlowGraph` from watched builder form values), a pure dagre layout (`layoutFlowGraph`, loop groups laid out bottom-up), and one `@xyflow/react` renderer (`WorkflowFlowDiagram`) used by both sheets.

**Tech Stack:** React 19, TypeScript, `@xyflow/react` 12.10, `@dagrejs/dagre` 1.x (both already Studio deps), vitest + Testing Library + MSW, Tailwind semantic tokens, `$t` i18n with `zh-CN.json`.

**Spec:** `docs/superpowers/specs/2026-10-02-pg-durable-flow-diagram-design.md`

## Global Constraints

- No new dependencies; use `@xyflow/react` and `@dagrejs/dagre` already in `apps/studio/package.json`.
- Named exports only; no default exports.
- Semantic Tailwind tokens only, no hardcoded colors.
- Every user-facing string goes through `$t(...)` (`import { t as $t } from '@/lib/i18n'`) and gets a `zh-CN.json` entry in the same task; load the `copywriting` skill before writing new copy.
- No `!` non-null assertions, no new `any`, no new `as` casts on external data (ESLint ratchet must not increase).
- Files stay under ~300 lines; `WorkflowDetailSheet.tsx` must not grow (the steps UI moves into its own component).
- `useEffect` is not used for derived state; selection preselect is derived in render.
- Do not use `onlyRenderVisibleElements` (jsdom has no viewport; workflows are small).
- Gates: `pnpm --filter studio typecheck`, `pnpm --filter studio run lint:ratchet`, `pnpm knip --workspace apps/studio`, `pnpm test:prettier`, Durable vitest suite.
- All paths below are relative to `apps/studio/components/interfaces/Integrations/Durable/` unless they start with `apps/` or `docs/`.

## Review Focus

1. **Status polling while the user has panned or zoomed** — the detail query refetches every 3 s; the view must not snap back. Pinned by `getFlowStructureKey` tests in Task 2 (status/summary changes keep the key stable).
2. **Builder values mid-edit** (empty URL, blank query, container with empty `then`/`else`/`body`, partially watched objects) — the preview must render placeholders, never throw. Pinned in Task 1 (`tolerates partially watched values`, `marks empty required fields as incomplete`).
3. **Runtime ids colliding with synthetic ids** (`__start`, `__end`, `x:merge`) or missing references — xyflow ids must stay unique. Pinned in Task 1 (`keeps ids unique…`, `renders missing references…`).
4. **Switching the selected step** (click A then B; select-change batches arrive in any order) — the newest selection wins. Pinned in Task 3 (`selects steps by click and keeps the newest selection`) and Task 4 (`shows the details of a clicked step`).
5. **Loops nested deeper than the builder allows** (runtime loop inside loop) — children must sit inside their group and parents must precede children in the xyflow node array. Pinned in Task 2 (`nests loops at any depth`).

---

### Task 1: Flow-graph model and adapters

**Files:**

- Create: `Durable.flow.ts`
- Test: `Durable.flow.test.ts`

**Interfaces:**

- Consumes: `DurableTreeNode`, `getNodeConfig`, `parseExecutionGeneration` from `./Durable.tree`; `LeafStep`, `WorkflowStep`, `WorkflowFormValues`, `createDefaultLeafStep`, `createDefaultStep`, `createDefaultContainer`, `workflowDefaultValues` from `./Durable.utils`; `DurableNode` from `@/data/pg-durable/pg-durable.types`.
- Produces:
  - `type FlowNodeKind = 'start' | 'end' | 'step' | 'decision' | 'fork' | 'merge' | 'loop' | 'unknown'`
  - `type FlowEdgeLabel = 'then' | 'else'`
  - `type FlowNode = { id; kind; parentId?; stepType?; title; summary?; isIncomplete?; status?; iteration?; mergeMode?: 'all' | 'first'; continueOnFailure?; durableNodeId? }`
  - `type FlowEdge = { id: string; source: string; target: string; label?: FlowEdgeLabel }`
  - `type FlowGraph = { mode: 'runtime' | 'builder'; nodes: FlowNode[]; edges: FlowEdge[] }`
  - `type WatchedWorkflowValues = DeepPartialSkipArrayKey<WorkflowFormValues>`
  - `getRuntimeSummary(node: DurableNode): string | undefined`
  - `treeToFlowGraph(root: DurableTreeNode): FlowGraph`
  - `formToFlowGraph(values: WatchedWorkflowValues): FlowGraph`
  - `getEdgeAppearance(mode: FlowGraph['mode'], targetStatus: string | null | undefined): { animated: boolean; isMuted: boolean }`
  - `getFirstFailedNodeId(graph: FlowGraph | null): string | null`

- [ ] **Step 1: Write the failing tests**

Create `Durable.flow.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import {
  formToFlowGraph,
  getEdgeAppearance,
  getFirstFailedNodeId,
  getRuntimeSummary,
  treeToFlowGraph,
  type FlowGraph,
} from './Durable.flow'
import { buildNodeTree } from './Durable.tree'
import {
  createDefaultContainer,
  createDefaultLeafStep,
  createDefaultStep,
  workflowDefaultValues,
  type LeafStep,
  type WorkflowStep,
} from './Durable.utils'
import type { DurableNode } from '@/data/pg-durable/pg-durable.types'

const node = (overrides: Partial<DurableNode> & { node_id: string }): DurableNode => ({
  node_type: 'SQL',
  query: null,
  result_name: null,
  left_node: null,
  right_node: null,
  status: null,
  result: null,
  status_details: null,
  inferred_status: null,
  updated_at: null,
  ...overrides,
})

const runtime = (rootId: string, nodes: DurableNode[]) => {
  const tree = buildNodeTree(rootId, nodes)
  if (!tree) throw new Error('empty tree')
  return treeToFlowGraph(tree)
}

const byId = (graph: FlowGraph, id: string) => {
  const found = graph.nodes.find((n) => n.id === id)
  if (!found) throw new Error(`missing node ${id}`)
  return found
}

const edgePairs = (graph: FlowGraph) =>
  graph.edges.map((e) => `${e.source}->${e.target}${e.label ? `:${e.label}` : ''}`)

const leaf = (overrides: Partial<LeafStep>): LeafStep => ({
  ...createDefaultLeafStep(),
  ...overrides,
})

const values = (steps: WorkflowStep[], composition: 'sequential' | 'parallel' = 'sequential') => ({
  ...workflowDefaultValues,
  composition,
  steps,
})

describe('getRuntimeSummary', () => {
  it.each([
    [
      { node_type: 'SIGNAL', query: '{"signal_name":"approve","timeout_seconds":60}' },
      'approve · 60s',
    ],
    [{ node_type: 'SIGNAL', query: '{"signal_name":"approve"}' }, 'approve'],
    [{ node_type: 'HTTP', query: '{"url":"https://x.dev","method":"POST"}' }, 'POST https://x.dev'],
    [{ node_type: 'WAIT_SCHEDULE', query: '{"cron_expr":"0 * * * *"}' }, '0 * * * *'],
    [{ node_type: 'BREAK', query: '{"break_value":{"ok":true}}' }, '{"ok":true}'],
    [{ node_type: 'SLEEP', query: ' 30 ' }, '30s'],
    [{ node_type: 'SQL', query: '\n  \nSELECT 1\nFROM t' }, 'SELECT 1'],
    [{ node_type: 'SQL', query: null }, undefined],
  ])('summarizes runtime node %#', (overrides, expected) => {
    expect(getRuntimeSummary(node({ node_id: 'n', ...overrides }))).toBe(expected)
  })
})

describe('treeToFlowGraph', () => {
  it('chains a THEN sequence between start and end', () => {
    const graph = runtime('t1', [
      node({ node_id: 't1', node_type: 'THEN', left_node: 'a', right_node: 'b' }),
      node({ node_id: 'a', query: 'SELECT 1\nFROM x', status: 'completed' }),
      node({ node_id: 'b', node_type: 'SLEEP', query: '30', status: 'running' }),
    ])
    expect(graph.mode).toBe('runtime')
    expect(new Set(edgePairs(graph))).toEqual(new Set(['__start->a', 'a->b', 'b->__end']))
    expect(byId(graph, 'a')).toMatchObject({
      kind: 'step',
      stepType: 'SQL',
      title: 'a',
      summary: 'SELECT 1',
      status: 'completed',
      durableNodeId: 'a',
    })
    expect(byId(graph, 'b')).toMatchObject({ stepType: 'SLEEP', summary: '30s', status: 'running' })
  })

  it('prefers inferred status and result names', () => {
    const graph = runtime('a', [
      node({ node_id: 'a', result_name: 'load', status: 'pending', inferred_status: 'skipped' }),
    ])
    expect(byId(graph, 'a')).toMatchObject({ title: 'load', status: 'skipped' })
  })

  it('draws JOIN branches, including extra nodes, between a fork and an all-merge', () => {
    const graph = runtime('j', [
      node({
        node_id: 'j',
        node_type: 'JOIN',
        left_node: 'a',
        right_node: 'b',
        query: '{"extra_nodes":["c"]}',
        status: 'completed',
      }),
      node({ node_id: 'a' }),
      node({ node_id: 'b' }),
      node({ node_id: 'c' }),
    ])
    expect(byId(graph, 'j:merge')).toMatchObject({
      kind: 'merge',
      mergeMode: 'all',
      durableNodeId: 'j',
      status: 'completed',
    })
    expect(new Set(edgePairs(graph))).toEqual(
      new Set([
        '__start->j:fork',
        'j:fork->a',
        'j:fork->b',
        'j:fork->c',
        'a->j:merge',
        'b->j:merge',
        'c->j:merge',
        'j:merge->__end',
      ])
    )
  })

  it('marks RACE merges as first-to-finish and keeps losing branch status', () => {
    const graph = runtime('r', [
      node({ node_id: 'r', node_type: 'RACE', left_node: 'a', right_node: 'b' }),
      node({ node_id: 'a', status: 'completed' }),
      node({ node_id: 'b', status: 'cancelled' }),
    ])
    expect(byId(graph, 'r:merge').mergeMode).toBe('first')
    expect(byId(graph, 'b').status).toBe('cancelled')
  })

  it('turns IF into a decision with then and else arms', () => {
    const graph = runtime('i', [
      node({
        node_id: 'i',
        node_type: 'IF',
        left_node: 't',
        right_node: 'e',
        query: '{"condition_node":"c"}',
        status: 'completed',
      }),
      node({ node_id: 'c', query: 'SELECT count(*) > 0 FROM jobs' }),
      node({ node_id: 't' }),
      node({ node_id: 'e', status: 'skipped' }),
    ])
    expect(byId(graph, 'i')).toMatchObject({
      kind: 'decision',
      stepType: 'IF',
      summary: 'SELECT count(*) > 0 FROM jobs',
      durableNodeId: 'i',
    })
    expect(graph.nodes.some((n) => n.id === 'c')).toBe(false)
    expect(new Set(edgePairs(graph))).toEqual(
      new Set([
        '__start->i',
        'i->t:then',
        'i->e:else',
        't->i:merge',
        'e->i:merge',
        'i:merge->__end',
      ])
    )
  })

  it('labels IF_ROWS and connects a missing else straight to the merge', () => {
    const graph = runtime('i', [
      node({
        node_id: 'i',
        node_type: 'IF',
        left_node: 't',
        query: '{"condition_type":"result_has_rows","result_name":"rows"}',
      }),
      node({ node_id: 't' }),
    ])
    expect(byId(graph, 'i')).toMatchObject({ stepType: 'IF_ROWS', summary: 'rows' })
    expect(edgePairs(graph)).toContain('i->i:merge:else')
  })

  it('groups a loop body and reports the latest iteration', () => {
    const graph = runtime('l', [
      node({
        node_id: 'l',
        node_type: 'LOOP',
        left_node: 't',
        query: '{"condition_node":"c","continue_on_failure":true}',
        status: 'running',
      }),
      node({ node_id: 'c', query: 'SELECT done FROM state' }),
      node({ node_id: 't', node_type: 'THEN', left_node: 'a', right_node: 'b' }),
      node({ node_id: 'a', status_details: '{"execution_id":"x::3"}' }),
      node({ node_id: 'b', status_details: '{"execution_id":"x::2"}' }),
    ])
    expect(byId(graph, 'l')).toMatchObject({
      kind: 'loop',
      stepType: 'LOOP',
      summary: 'SELECT done FROM state',
      continueOnFailure: true,
      iteration: 3,
    })
    expect(byId(graph, 'a')).toMatchObject({ parentId: 'l', iteration: 3 })
    expect(byId(graph, 'b').parentId).toBe('l')
    expect(new Set(edgePairs(graph))).toEqual(new Set(['__start->l', 'a->b', 'l->__end']))
  })

  it('nests runtime loops deeper than the builder allows', () => {
    const graph = runtime('outer', [
      node({ node_id: 'outer', node_type: 'LOOP', left_node: 'inner' }),
      node({ node_id: 'inner', node_type: 'LOOP', left_node: 'x' }),
      node({ node_id: 'x' }),
    ])
    expect(byId(graph, 'inner').parentId).toBe('outer')
    expect(byId(graph, 'x').parentId).toBe('inner')
  })

  it('renders missing references as unknown nodes', () => {
    const graph = runtime('t1', [
      node({ node_id: 't1', node_type: 'THEN', left_node: 'a', right_node: 'ghost' }),
      node({ node_id: 'a' }),
    ])
    expect(byId(graph, 'ghost')).toMatchObject({ kind: 'unknown', title: 'ghost' })
    expect(edgePairs(graph)).toContain('a->ghost')
  })

  it('keeps ids unique when a node id collides with a synthetic id', () => {
    const graph = runtime('t1', [
      node({ node_id: 't1', node_type: 'THEN', left_node: '__start', right_node: '__end' }),
      node({ node_id: '__start' }),
      node({ node_id: '__end' }),
    ])
    const ids = graph.nodes.map((n) => n.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(graph.nodes.filter((n) => n.durableNodeId === '__start')).toHaveLength(1)
    expect(graph.nodes.filter((n) => n.kind === 'start')).toHaveLength(1)
    expect(graph.nodes.filter((n) => n.kind === 'end')).toHaveLength(1)
  })
})

describe('formToFlowGraph', () => {
  it('chains top-level steps with result names or numbered titles', () => {
    const graph = formToFlowGraph(
      values([
        createDefaultStep(),
        { ...createDefaultStep(), type: 'sleep', seconds: '5', resultName: 'nap' },
      ])
    )
    expect(graph.mode).toBe('builder')
    expect(byId(graph, 'step-0')).toMatchObject({
      kind: 'step',
      stepType: 'SQL',
      title: 'Step 1',
      summary: 'SELECT 1 AS result',
      isIncomplete: false,
    })
    expect(byId(graph, 'step-1')).toMatchObject({ stepType: 'SLEEP', title: 'nap', summary: '5s' })
    expect(new Set(edgePairs(graph))).toEqual(
      new Set(['__start->step-0', 'step-0->step-1', 'step-1->__end'])
    )
  })

  it.each([
    [{ type: 'signal', signal: 'go', noTimeout: false, seconds: '10' }, 'SIGNAL', 'go · 10s'],
    [{ type: 'signal', signal: 'go', noTimeout: true }, 'SIGNAL', 'go'],
    [{ type: 'http', url: 'https://x.dev', method: 'PUT' }, 'HTTP', 'PUT https://x.dev'],
    [
      { type: 'multipart', url: 'https://x.dev', method: 'POST' },
      'HTTP_MULTIPART',
      'POST https://x.dev',
    ],
    [{ type: 'schedule', cron: '*/5 * * * *' }, 'WAIT_SCHEDULE', '*/5 * * * *'],
  ] as const)('summarizes builder leaf %#', (overrides, stepType, summary) => {
    const graph = formToFlowGraph(values([{ ...createDefaultStep(), ...overrides }]))
    expect(byId(graph, 'step-0')).toMatchObject({ stepType, summary, isIncomplete: false })
  })

  it('marks empty required fields as incomplete instead of failing', () => {
    const graph = formToFlowGraph(
      values([
        { ...createDefaultStep(), query: '  ' },
        { ...createDefaultStep(), type: 'http', url: '' },
      ])
    )
    expect(byId(graph, 'step-0')).toMatchObject({ isIncomplete: true })
    expect(byId(graph, 'step-0').summary).toBeUndefined()
    expect(byId(graph, 'step-1')).toMatchObject({ isIncomplete: true })
  })

  it('tolerates partially watched values', () => {
    expect(edgePairs(formToFlowGraph({}))).toEqual(['__start->__end'])
    const graph = formToFlowGraph({ steps: [{ type: 'loop' }, { type: 'if' }, {}] })
    expect(byId(graph, 'step-0').kind).toBe('loop')
    expect(byId(graph, 'step-1')).toMatchObject({ kind: 'decision', isIncomplete: true })
    expect(byId(graph, 'step-2')).toMatchObject({
      kind: 'step',
      stepType: 'SQL',
      isIncomplete: true,
    })
  })

  it('groups loop bodies inside the loop node', () => {
    const loop: WorkflowStep = {
      ...createDefaultContainer('loop'),
      condition: 'SELECT false',
      continueOnFailure: true,
      body: [leaf({}), leaf({ type: 'break' })],
    }
    const graph = formToFlowGraph(values([loop]))
    expect(byId(graph, 'step-0')).toMatchObject({
      kind: 'loop',
      summary: 'SELECT false',
      continueOnFailure: true,
    })
    expect(byId(graph, 'step-0-body-0')).toMatchObject({ parentId: 'step-0', title: 'Step 1.1' })
    expect(byId(graph, 'step-0-body-1')).toMatchObject({
      parentId: 'step-0',
      stepType: 'BREAK',
      isIncomplete: false,
    })
    expect(new Set(edgePairs(graph))).toEqual(
      new Set(['__start->step-0', 'step-0-body-0->step-0-body-1', 'step-0->__end'])
    )
  })

  it('draws if arms, numbering else after then, and joins an empty else to the merge', () => {
    const withElse: WorkflowStep = {
      ...createDefaultContainer('if'),
      condition: 'SELECT true',
      else: [leaf({})],
    }
    const graph = formToFlowGraph(values([withElse]))
    expect(byId(graph, 'step-0')).toMatchObject({
      kind: 'decision',
      stepType: 'IF',
      summary: 'SELECT true',
      isIncomplete: false,
    })
    expect(byId(graph, 'step-0-else-0').title).toBe('Step 1.2')
    expect(new Set(edgePairs(graph))).toEqual(
      new Set([
        '__start->step-0',
        'step-0->step-0-then-0:then',
        'step-0-then-0->step-0:merge',
        'step-0->step-0-else-0:else',
        'step-0-else-0->step-0:merge',
        'step-0:merge->__end',
      ])
    )
    const noElse = formToFlowGraph(
      values([{ ...createDefaultContainer('if_rows'), rowsResultName: '' }])
    )
    expect(byId(noElse, 'step-0')).toMatchObject({ stepType: 'IF_ROWS', isIncomplete: true })
    expect(edgePairs(noElse)).toContain('step-0->step-0:merge:else')
  })

  it('draws race and parallel bodies as branches', () => {
    const graph = formToFlowGraph(
      values([createDefaultContainer('race'), createDefaultContainer('parallel')])
    )
    expect(byId(graph, 'step-0:merge').mergeMode).toBe('first')
    expect(byId(graph, 'step-1:merge').mergeMode).toBe('all')
    expect(edgePairs(graph)).toEqual(
      expect.arrayContaining([
        'step-0:fork->step-0-body-0',
        'step-0:fork->step-0-body-1',
        'step-0:merge->step-1:fork',
      ])
    )
  })

  it('wraps top-level steps in a fork for parallel composition', () => {
    const graph = formToFlowGraph(values([createDefaultStep(), createDefaultStep()], 'parallel'))
    expect(new Set(edgePairs(graph))).toEqual(
      new Set([
        '__start->__root:fork',
        '__root:fork->step-0',
        '__root:fork->step-1',
        'step-0->__root:merge',
        'step-1->__root:merge',
        '__root:merge->__end',
      ])
    )
  })
})

describe('getEdgeAppearance', () => {
  it('never mutes builder edges', () => {
    expect(getEdgeAppearance('builder', undefined)).toEqual({ animated: false, isMuted: false })
  })

  it.each([
    ['completed', false, false],
    ['failed', false, false],
    ['running', true, false],
    ['pending', false, true],
    ['skipped', false, true],
    ['cancelled', false, true],
    [null, false, true],
  ])('styles runtime edges into %s nodes', (status, animated, isMuted) => {
    expect(getEdgeAppearance('runtime', status)).toEqual({ animated, isMuted })
  })
})

describe('getFirstFailedNodeId', () => {
  it('prefers a failed step over its failed container', () => {
    const graph = runtime('l', [
      node({ node_id: 'l', node_type: 'LOOP', left_node: 'a', status: 'failed' }),
      node({ node_id: 'a', status: 'failed' }),
    ])
    expect(getFirstFailedNodeId(graph)).toBe('a')
  })

  it('falls back to a failed container, then to null', () => {
    const graph = runtime('l', [
      node({ node_id: 'l', node_type: 'LOOP', left_node: 'a', status: 'failed' }),
      node({ node_id: 'a', status: 'completed' }),
    ])
    expect(getFirstFailedNodeId(graph)).toBe('l')
    expect(getFirstFailedNodeId(null)).toBeNull()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (from `apps/studio`): `pnpm vitest run components/interfaces/Integrations/Durable/Durable.flow.test.ts`
Expected: FAIL — `Failed to resolve import "./Durable.flow"`.

- [ ] **Step 3: Implement `Durable.flow.ts`**

```ts
import type { DeepPartialSkipArrayKey } from 'react-hook-form'

import { getNodeConfig, parseExecutionGeneration, type DurableTreeNode } from './Durable.tree'
import type { WorkflowFormValues } from './Durable.utils'
import type { DurableNode } from '@/data/pg-durable/pg-durable.types'
import { t as $t } from '@/lib/i18n'

export type FlowNodeKind =
  | 'start'
  | 'end'
  | 'step'
  | 'decision'
  | 'fork'
  | 'merge'
  | 'loop'
  | 'unknown'

export type FlowEdgeLabel = 'then' | 'else'

export type FlowNode = {
  id: string
  kind: FlowNodeKind
  /** Loop group this node is drawn inside. */
  parentId?: string
  stepType?: string
  title: string
  summary?: string
  /** Builder only: a required field is still empty. */
  isIncomplete?: boolean
  status?: string | null
  iteration?: number | null
  mergeMode?: 'all' | 'first'
  continueOnFailure?: boolean
  /** Runtime only: the df node shown when this flow node is selected. */
  durableNodeId?: string
}

export type FlowEdge = { id: string; source: string; target: string; label?: FlowEdgeLabel }

export type FlowGraph = { mode: 'runtime' | 'builder'; nodes: FlowNode[]; edges: FlowEdge[] }

export type WatchedWorkflowValues = DeepPartialSkipArrayKey<WorkflowFormValues>
type WatchedStep = NonNullable<WatchedWorkflowValues['steps']>[number]
type WatchedLeaf = NonNullable<WatchedStep['body']>[number]

type Segment = { entry: string; exit: string }

const START_ID = '__start'
const END_ID = '__end'

const firstLine = (text: string) =>
  text
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? ''

const asText = (value: unknown): string | undefined => {
  if (value === undefined || value === null) return undefined
  return typeof value === 'string' ? value : JSON.stringify(value)
}

const getStatus = (node: DurableNode) => node.inferred_status ?? node.status

const createGraphBuilder = () => {
  const nodes: FlowNode[] = []
  const edges: FlowEdge[] = []
  const usedIds = new Set<string>()
  const unique = (base: string) => {
    let id = base
    for (let n = 1; usedIds.has(id); n++) id = `${base}~${n}`
    usedIds.add(id)
    return id
  }
  const addNode = (node: FlowNode) => {
    const id = unique(node.id)
    nodes.push({ ...node, id })
    return id
  }
  const patchNode = (id: string, fields: Partial<FlowNode>) => {
    const target = nodes.find((n) => n.id === id)
    if (target) Object.assign(target, fields)
  }
  const connect = (source: string, target: string, label?: FlowEdgeLabel) => {
    const edge: FlowEdge = { id: unique(`${source}->${target}`), source, target }
    if (label !== undefined) edge.label = label
    edges.push(edge)
  }
  const chain = (segments: Segment[]): Segment | null => {
    if (segments.length === 0) return null
    for (let i = 1; i < segments.length; i++) connect(segments[i - 1].exit, segments[i].entry)
    return { entry: segments[0].entry, exit: segments[segments.length - 1].exit }
  }
  const branches = (forkId: string, mergeId: string, segments: Segment[]) => {
    for (const segment of segments) {
      connect(forkId, segment.entry)
      connect(segment.exit, mergeId)
    }
  }
  const arm = (
    decisionId: string,
    mergeId: string,
    segment: Segment | null,
    label: FlowEdgeLabel
  ) => {
    if (!segment) {
      connect(decisionId, mergeId, label)
      return
    }
    connect(decisionId, segment.entry, label)
    connect(segment.exit, mergeId)
  }
  const close = (start: string, body: Segment | null, end: string) => {
    if (!body) {
      connect(start, end)
      return
    }
    connect(start, body.entry)
    connect(body.exit, end)
  }
  return { nodes, edges, addNode, patchNode, connect, chain, branches, arm, close }
}

const single = (id: string): Segment => ({ entry: id, exit: id })

export function getRuntimeSummary(node: DurableNode): string | undefined {
  const config = getNodeConfig(node)
  switch (node.node_type.toUpperCase()) {
    case 'SQL':
      return node.query ? firstLine(node.query) || undefined : undefined
    case 'SLEEP':
      return node.query?.trim() ? `${node.query.trim()}s` : undefined
    case 'SIGNAL': {
      const name = asText(config?.signal_name)
      if (!name) return undefined
      const timeout = asText(config?.timeout_seconds)
      return timeout ? `${name} · ${timeout}s` : name
    }
    case 'WAIT_SCHEDULE':
      return asText(config?.cron_expr)
    case 'HTTP':
    case 'HTTP_MULTIPART': {
      const url = asText(config?.url)
      if (!url) return undefined
      const method = asText(config?.method)
      return method ? `${method} ${url}` : url
    }
    case 'BREAK':
      return asText(config?.break_value)
    default:
      return undefined
  }
}

export function treeToFlowGraph(root: DurableTreeNode): FlowGraph {
  const g = createGraphBuilder()
  const start = g.addNode({ id: START_ID, kind: 'start', title: '' })

  const convert = (tree: DurableTreeNode, parentId: string | undefined): Segment => {
    const scope = parentId === undefined ? {} : { parentId }
    const { node } = tree
    if (!node) return single(g.addNode({ id: tree.id, kind: 'unknown', title: tree.id, ...scope }))

    const status = getStatus(node)
    const title = node.result_name || node.node_id
    const config = getNodeConfig(node)
    const childOf = (role: DurableTreeNode['role']) => tree.children.find((c) => c.role === role)
    const conditionQuery = childOf('condition')?.node?.query
    const conditionText = conditionQuery ? firstLine(conditionQuery) || undefined : undefined

    switch (node.node_type.toUpperCase()) {
      case 'THEN': {
        const segment = g.chain(tree.children.map((child) => convert(child, parentId)))
        return segment ?? single(g.addNode({ id: tree.id, kind: 'unknown', title, ...scope }))
      }
      case 'IF': {
        const isRows = config?.condition_type === 'result_has_rows'
        const decision = g.addNode({
          id: tree.id,
          kind: 'decision',
          stepType: isRows ? 'IF_ROWS' : 'IF',
          title,
          summary: isRows ? asText(config?.result_name) : conditionText,
          status,
          durableNodeId: node.node_id,
          ...scope,
        })
        const thenChild = childOf('then')
        const elseChild = childOf('else')
        const thenSegment = thenChild ? convert(thenChild, parentId) : null
        const elseSegment = elseChild ? convert(elseChild, parentId) : null
        const merge = g.addNode({
          id: `${tree.id}:merge`,
          kind: 'merge',
          title: '',
          status,
          ...scope,
        })
        g.arm(decision, merge, thenSegment, 'then')
        g.arm(decision, merge, elseSegment, 'else')
        return { entry: decision, exit: merge }
      }
      case 'LOOP': {
        const loop = g.addNode({
          id: tree.id,
          kind: 'loop',
          stepType: 'LOOP',
          title,
          summary: conditionText,
          continueOnFailure: config?.continue_on_failure === true,
          status,
          durableNodeId: node.node_id,
          ...scope,
        })
        const body = childOf('body')
        if (body) convert(body, loop)
        const iterations = g.nodes
          .filter((n) => n.parentId === loop)
          .map((n) => n.iteration)
          .filter((n): n is number => typeof n === 'number')
        if (iterations.length > 0) g.patchNode(loop, { iteration: Math.max(...iterations) })
        return single(loop)
      }
      case 'JOIN':
      case 'RACE': {
        const fork = g.addNode({ id: `${tree.id}:fork`, kind: 'fork', title: '', status, ...scope })
        const segments = tree.children
          .filter((c) => c.role === 'branch')
          .map((c) => convert(c, parentId))
        const merge = g.addNode({
          id: `${tree.id}:merge`,
          kind: 'merge',
          title: node.result_name ?? '',
          mergeMode: node.node_type.toUpperCase() === 'RACE' ? 'first' : 'all',
          status,
          durableNodeId: node.node_id,
          ...scope,
        })
        g.branches(fork, merge, segments)
        return { entry: fork, exit: merge }
      }
      default:
        return single(
          g.addNode({
            id: tree.id,
            kind: 'step',
            stepType: node.node_type,
            title,
            summary: getRuntimeSummary(node),
            status,
            iteration: tree.inLoop ? parseExecutionGeneration(node.status_details) : null,
            durableNodeId: node.node_id,
            ...scope,
          })
        )
    }
  }

  const body = convert(root, undefined)
  const end = g.addNode({
    id: END_ID,
    kind: 'end',
    title: '',
    status: root.node ? getStatus(root.node) : null,
  })
  g.close(start, body, end)
  return { mode: 'runtime', nodes: g.nodes, edges: g.edges }
}

const LEAF_NODE_TYPES: Record<string, string> = {
  sql: 'SQL',
  sleep: 'SLEEP',
  signal: 'SIGNAL',
  http: 'HTTP',
  multipart: 'HTTP_MULTIPART',
  schedule: 'WAIT_SCHEDULE',
  break: 'BREAK',
}

type LeafInput = WatchedLeaf | WatchedStep
type LeafSummary = { summary?: string; isIncomplete: boolean }

const trimmed = (value: string | undefined) => value?.trim() ?? ''
const complete = (summary: string): LeafSummary => ({ summary, isIncomplete: false })
const INCOMPLETE: LeafSummary = { isIncomplete: true }

function getLeafSummary(step: LeafInput): LeafSummary {
  switch (step.type) {
    case 'sleep': {
      const seconds = trimmed(step.seconds)
      return seconds ? complete(`${seconds}s`) : INCOMPLETE
    }
    case 'signal': {
      const name = trimmed(step.signal)
      if (!name) return INCOMPLETE
      const seconds = trimmed(step.seconds)
      return complete(step.noTimeout || !seconds ? name : `${name} · ${seconds}s`)
    }
    case 'http':
    case 'multipart': {
      const url = trimmed(step.url)
      return url ? complete(`${step.method ?? 'GET'} ${url}`) : INCOMPLETE
    }
    case 'schedule': {
      const cron = trimmed(step.cron)
      return cron ? complete(cron) : INCOMPLETE
    }
    case 'break': {
      const value = trimmed(step.breakValue)
      return value ? complete(value) : { isIncomplete: false }
    }
    default: {
      const query = firstLine(step.query ?? '')
      return query ? complete(query) : INCOMPLETE
    }
  }
}

export function formToFlowGraph(values: WatchedWorkflowValues): FlowGraph {
  const g = createGraphBuilder()
  const start = g.addNode({ id: START_ID, kind: 'start', title: '' })
  const stepTitle = (step: LeafInput, label: string) =>
    trimmed(step.resultName) || $t('Step {{number}}', { number: label })

  const leaf = (step: LeafInput, id: string, label: string, parentId?: string): Segment =>
    single(
      g.addNode({
        id,
        kind: 'step',
        stepType: LEAF_NODE_TYPES[step.type ?? 'sql'] ?? 'SQL',
        title: stepTitle(step, label),
        ...getLeafSummary(step),
        ...(parentId === undefined ? {} : { parentId }),
      })
    )

  const leaves = (
    steps: WatchedLeaf[] | undefined,
    idPrefix: string,
    label: string,
    offset: number,
    parentId?: string
  ) =>
    (steps ?? []).map((child, j) =>
      leaf(child, `${idPrefix}-${j}`, `${label}.${offset + j + 1}`, parentId)
    )

  const step = (s: WatchedStep, index: number): Segment => {
    const id = `step-${index}`
    const label = String(index + 1)
    const title = stepTitle(s, label)
    switch (s.type) {
      case 'loop': {
        const loop = g.addNode({
          id,
          kind: 'loop',
          stepType: 'LOOP',
          title,
          summary: firstLine(s.condition ?? '') || undefined,
          continueOnFailure: s.continueOnFailure === true,
        })
        g.chain(leaves(s.body, `${id}-body`, label, 0, loop))
        return single(loop)
      }
      case 'if':
      case 'if_rows': {
        const isRows = s.type === 'if_rows'
        const condition = isRows ? trimmed(s.rowsResultName) : firstLine(s.condition ?? '')
        const decision = g.addNode({
          id,
          kind: 'decision',
          stepType: isRows ? 'IF_ROWS' : 'IF',
          title,
          summary: condition || undefined,
          isIncomplete: !condition,
        })
        const thenSteps = leaves(s.then, `${id}-then`, label, 0)
        const elseSteps = leaves(s.else, `${id}-else`, label, thenSteps.length)
        const merge = g.addNode({ id: `${id}:merge`, kind: 'merge', title: '' })
        g.arm(decision, merge, g.chain(thenSteps), 'then')
        g.arm(decision, merge, g.chain(elseSteps), 'else')
        return { entry: decision, exit: merge }
      }
      case 'race':
      case 'parallel': {
        const fork = g.addNode({ id: `${id}:fork`, kind: 'fork', title: '' })
        const bodySteps = leaves(s.body, `${id}-body`, label, 0)
        const merge = g.addNode({
          id: `${id}:merge`,
          kind: 'merge',
          title: trimmed(s.resultName),
          mergeMode: s.type === 'race' ? 'first' : 'all',
        })
        g.branches(fork, merge, bodySteps)
        return { entry: fork, exit: merge }
      }
      default:
        return leaf(s, id, label)
    }
  }

  const segments = (values.steps ?? []).map(step)
  let body: Segment | null
  if (values.composition === 'parallel' && segments.length > 0) {
    const fork = g.addNode({ id: '__root:fork', kind: 'fork', title: '' })
    const merge = g.addNode({ id: '__root:merge', kind: 'merge', title: '', mergeMode: 'all' })
    g.branches(fork, merge, segments)
    body = { entry: fork, exit: merge }
  } else {
    body = g.chain(segments)
  }
  const end = g.addNode({ id: END_ID, kind: 'end', title: '' })
  g.close(start, body, end)
  return { mode: 'builder', nodes: g.nodes, edges: g.edges }
}

const RAN_STATUSES = new Set(['completed', 'failed', 'running'])

export function getEdgeAppearance(
  mode: FlowGraph['mode'],
  targetStatus: string | null | undefined
): { animated: boolean; isMuted: boolean } {
  if (mode === 'builder') return { animated: false, isMuted: false }
  const status = targetStatus?.toLowerCase() ?? ''
  return { animated: status === 'running', isMuted: !RAN_STATUSES.has(status) }
}

export function getFirstFailedNodeId(graph: FlowGraph | null): string | null {
  if (!graph) return null
  const isFailed = (n: FlowNode) => !!n.durableNodeId && n.status?.toLowerCase() === 'failed'
  const failed =
    graph.nodes.find((n) => n.kind === 'step' && isFailed(n)) ?? graph.nodes.find(isFailed)
  return failed?.durableNodeId ?? null
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run components/interfaces/Integrations/Durable/Durable.flow.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Typecheck the new file**

Run (from `apps/studio`): `pnpm tsc --noEmit -p . 2>&1 | grep Durable.flow || echo clean`
Expected: `clean`. If `DeepPartialSkipArrayKey` element types reject `{}` in the partial-values test, widen the test literal with `satisfies WatchedWorkflowValues` instead of casting.

- [ ] **Step 6: Commit**

```bash
git add apps/studio/components/interfaces/Integrations/Durable/Durable.flow.ts apps/studio/components/interfaces/Integrations/Durable/Durable.flow.test.ts
git commit -m "feat(studio): model pg_durable workflows as flow graphs"
```

---

### Task 2: Flow layout

**Files:**

- Create: `Durable.flowLayout.ts`
- Test: `Durable.flowLayout.test.ts`

**Interfaces:**

- Consumes: `FlowGraph`, `FlowNode`, `FlowNodeKind`, `FlowEdgeLabel` from `./Durable.flow` (Task 1).
- Produces:
  - `FLOW_NODE_SIZES: Record<Exclude<FlowNodeKind, 'loop'>, { width: number; height: number }>`
  - `LOOP_PADDING = 16`, `LOOP_HEADER_HEIGHT = 32`
  - `type FlowNodeData = { flow: FlowNode }`
  - `type FlowDiagramNode = Node<FlowNodeData>` (xyflow `type` = `FlowNode.kind`)
  - `type FlowDiagramEdge = Edge<{ label?: FlowEdgeLabel }>`
  - `layoutFlowGraph(graph: FlowGraph): { nodes: FlowDiagramNode[]; edges: FlowDiagramEdge[] }`
  - `getFlowStructureKey(graph: FlowGraph): string`

- [ ] **Step 1: Write the failing tests**

Create `Durable.flowLayout.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import type { FlowGraph, FlowNode } from './Durable.flow'
import {
  getFlowStructureKey,
  layoutFlowGraph,
  LOOP_HEADER_HEIGHT,
  LOOP_PADDING,
  type FlowDiagramNode,
} from './Durable.flowLayout'

const flowNode = (id: string, kind: FlowNode['kind'] = 'step', parentId?: string): FlowNode => ({
  id,
  kind,
  title: id,
  ...(parentId === undefined ? {} : { parentId }),
})

const graphOf = (nodes: FlowNode[], pairs: [string, string][]): FlowGraph => ({
  mode: 'runtime',
  nodes,
  edges: pairs.map(([source, target]) => ({ id: `${source}->${target}`, source, target })),
})

const get = (nodes: FlowDiagramNode[], id: string) => {
  const found = nodes.find((n) => n.id === id)
  if (!found) throw new Error(`missing node ${id}`)
  return found
}

describe('layoutFlowGraph', () => {
  it('positions every node and orders a sequence top to bottom', () => {
    const { nodes, edges } = layoutFlowGraph(
      graphOf(
        [flowNode('__start', 'start'), flowNode('a'), flowNode('b'), flowNode('__end', 'end')],
        [
          ['__start', 'a'],
          ['a', 'b'],
          ['b', '__end'],
        ]
      )
    )
    const y = (id: string) => get(nodes, id).position.y
    expect(y('__start')).toBeLessThan(y('a'))
    expect(y('a')).toBeLessThan(y('b'))
    expect(y('b')).toBeLessThan(y('__end'))
    expect(get(nodes, 'a')).toMatchObject({
      type: 'step',
      width: 240,
      height: 64,
      draggable: false,
      connectable: false,
    })
    expect(edges.map((e) => e.id)).toEqual(['__start->a', 'a->b', 'b->__end'])
  })

  it('places loop children inside their group, after the group', () => {
    const { nodes } = layoutFlowGraph(
      graphOf(
        [
          flowNode('__start', 'start'),
          flowNode('l', 'loop'),
          flowNode('a', 'step', 'l'),
          flowNode('b', 'step', 'l'),
          flowNode('__end', 'end'),
        ],
        [
          ['__start', 'l'],
          ['a', 'b'],
          ['l', '__end'],
        ]
      )
    )
    const ids = nodes.map((n) => n.id)
    expect(ids.indexOf('l')).toBeLessThan(ids.indexOf('a'))
    const loop = get(nodes, 'l')
    const a = get(nodes, 'a')
    const b = get(nodes, 'b')
    expect(a).toMatchObject({ parentId: 'l', extent: 'parent' })
    for (const child of [a, b]) {
      expect(child.position.x).toBeGreaterThanOrEqual(LOOP_PADDING)
      expect(child.position.y).toBeGreaterThanOrEqual(LOOP_HEADER_HEIGHT + LOOP_PADDING)
      expect(child.position.x + (child.width ?? 0)).toBeLessThanOrEqual(
        (loop.width ?? 0) - LOOP_PADDING
      )
      expect(child.position.y + (child.height ?? 0)).toBeLessThanOrEqual(
        (loop.height ?? 0) - LOOP_PADDING
      )
    }
    expect(a.position.y).toBeLessThan(b.position.y)
  })

  it('sizes an empty loop to the minimum body', () => {
    const { nodes } = layoutFlowGraph(graphOf([flowNode('l', 'loop')], []))
    expect(get(nodes, 'l')).toMatchObject({
      width: 240 + 2 * LOOP_PADDING,
      height: LOOP_HEADER_HEIGHT + 48 + 2 * LOOP_PADDING,
    })
  })

  it('nests loops at any depth', () => {
    const { nodes } = layoutFlowGraph(
      graphOf([flowNode('o', 'loop'), flowNode('i', 'loop', 'o'), flowNode('x', 'step', 'i')], [])
    )
    expect(nodes.map((n) => n.id)).toEqual(['o', 'i', 'x'])
    expect(get(nodes, 'i').parentId).toBe('o')
    expect(get(nodes, 'x').parentId).toBe('i')
    expect(get(nodes, 'o').width ?? 0).toBeGreaterThan(get(nodes, 'i').width ?? 0)
  })

  it('drops edges that reference unknown nodes', () => {
    const { edges } = layoutFlowGraph(
      graphOf(
        [flowNode('a')],
        [
          ['a', 'ghost'],
          ['ghost', 'a'],
        ]
      )
    )
    expect(edges).toEqual([])
  })

  it('marks only nodes with a durable node id as selectable', () => {
    const { nodes } = layoutFlowGraph(
      graphOf([{ ...flowNode('a'), durableNodeId: 'a' }, flowNode('__start', 'start')], [])
    )
    expect(get(nodes, 'a').selectable).toBe(true)
    expect(get(nodes, '__start').selectable).toBe(false)
  })

  it('passes edge labels through as data', () => {
    const graph: FlowGraph = {
      mode: 'builder',
      nodes: [flowNode('d', 'decision'), flowNode('t')],
      edges: [{ id: 'd->t', source: 'd', target: 't', label: 'then' }],
    }
    expect(layoutFlowGraph(graph).edges[0]).toMatchObject({
      type: 'smoothstep',
      data: { label: 'then' },
    })
  })
})

describe('getFlowStructureKey', () => {
  it('ignores status and summary changes', () => {
    const base = graphOf([flowNode('a'), flowNode('b')], [['a', 'b']])
    const polled: FlowGraph = {
      ...base,
      nodes: base.nodes.map((n) => ({ ...n, status: 'completed', summary: 'changed' })),
    }
    expect(getFlowStructureKey(polled)).toBe(getFlowStructureKey(base))
  })

  it('changes when nodes, edges, or kinds change', () => {
    const base = graphOf([flowNode('a'), flowNode('b')], [['a', 'b']])
    const grown = graphOf(
      [flowNode('a'), flowNode('b'), flowNode('c')],
      [
        ['a', 'b'],
        ['b', 'c'],
      ]
    )
    const retyped = graphOf([flowNode('a', 'loop'), flowNode('b')], [['a', 'b']])
    expect(getFlowStructureKey(grown)).not.toBe(getFlowStructureKey(base))
    expect(getFlowStructureKey(retyped)).not.toBe(getFlowStructureKey(base))
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run components/interfaces/Integrations/Durable/Durable.flowLayout.test.ts`
Expected: FAIL — `Failed to resolve import "./Durable.flowLayout"`.

- [ ] **Step 3: Implement `Durable.flowLayout.ts`**

```ts
import dagre from '@dagrejs/dagre'
import { MarkerType, Position, type Edge, type Node } from '@xyflow/react'

import type { FlowEdgeLabel, FlowGraph, FlowNode, FlowNodeKind } from './Durable.flow'

type Box = { width: number; height: number }
type Placed = Box & { x: number; y: number }

export const FLOW_NODE_SIZES: Record<Exclude<FlowNodeKind, 'loop'>, Box> = {
  step: { width: 240, height: 64 },
  decision: { width: 240, height: 64 },
  unknown: { width: 240, height: 48 },
  start: { width: 96, height: 32 },
  end: { width: 96, height: 32 },
  fork: { width: 120, height: 8 },
  merge: { width: 160, height: 24 },
}
export const LOOP_PADDING = 16
/** Matches the `h-8` loop header in `WorkflowFlowNodes.tsx`. */
export const LOOP_HEADER_HEIGHT = 32
const EMPTY_LOOP_BODY: Box = { width: 240, height: 48 }
const NODE_SEP = 32
const RANK_SEP = 40

export type FlowNodeData = { flow: FlowNode }
export type FlowDiagramNode = Node<FlowNodeData>
export type FlowDiagramEdge = Edge<{ label?: FlowEdgeLabel }>

/**
 * Lays out a flow graph top to bottom with dagre. Loop groups are laid out bottom-up: each
 * loop's children get their own dagre pass, then the loop is one fixed-size node in its
 * parent's pass. Child positions are relative to their loop, as React Flow expects.
 */
export function layoutFlowGraph(graph: FlowGraph): {
  nodes: FlowDiagramNode[]
  edges: FlowDiagramEdge[]
} {
  const ids = new Set(graph.nodes.map((n) => n.id))
  const scopeOf = new Map<string, string | undefined>()
  const childrenOf = new Map<string | undefined, FlowNode[]>()
  for (const node of graph.nodes) {
    const parent = node.parentId !== undefined && ids.has(node.parentId) ? node.parentId : undefined
    scopeOf.set(node.id, parent)
    childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), node])
  }
  const placed = new Map<string, Placed>()

  const layoutLoop = (loop: FlowNode): Box => {
    const content = layoutScope(loop.id)
    const inner: Box = {
      width: Math.max(content.width, EMPTY_LOOP_BODY.width),
      height: Math.max(content.height, EMPTY_LOOP_BODY.height),
    }
    const offsetX = LOOP_PADDING + (inner.width - content.width) / 2
    const offsetY = LOOP_HEADER_HEIGHT + LOOP_PADDING
    for (const child of childrenOf.get(loop.id) ?? []) {
      const p = placed.get(child.id)
      if (p) placed.set(child.id, { ...p, x: p.x + offsetX, y: p.y + offsetY })
    }
    return {
      width: inner.width + 2 * LOOP_PADDING,
      height: LOOP_HEADER_HEIGHT + inner.height + 2 * LOOP_PADDING,
    }
  }

  function layoutScope(parentId: string | undefined): Box {
    const members = childrenOf.get(parentId) ?? []
    if (members.length === 0) return { width: 0, height: 0 }
    const dg = new dagre.graphlib.Graph()
    dg.setDefaultEdgeLabel(() => ({}))
    dg.setGraph({ rankdir: 'TB', nodesep: NODE_SEP, ranksep: RANK_SEP })
    for (const member of members) {
      const size = member.kind === 'loop' ? layoutLoop(member) : FLOW_NODE_SIZES[member.kind]
      dg.setNode(member.id, { width: size.width, height: size.height })
    }
    for (const edge of graph.edges) {
      if (!ids.has(edge.source) || !ids.has(edge.target)) continue
      if (scopeOf.get(edge.source) !== parentId || scopeOf.get(edge.target) !== parentId) continue
      dg.setEdge(edge.source, edge.target)
    }
    dagre.layout(dg)

    const raw = members.map((member) => {
      const p = dg.node(member.id)
      return {
        id: member.id,
        x: p.x - p.width / 2,
        y: p.y - p.height / 2,
        width: p.width,
        height: p.height,
      }
    })
    const minX = Math.min(...raw.map((r) => r.x))
    const minY = Math.min(...raw.map((r) => r.y))
    const maxX = Math.max(...raw.map((r) => r.x + r.width))
    const maxY = Math.max(...raw.map((r) => r.y + r.height))
    for (const r of raw) {
      placed.set(r.id, { x: r.x - minX, y: r.y - minY, width: r.width, height: r.height })
    }
    return { width: maxX - minX, height: maxY - minY }
  }

  layoutScope(undefined)

  // React Flow requires parents to precede their children.
  const nodes: FlowDiagramNode[] = []
  const emit = (parentId: string | undefined) => {
    for (const member of childrenOf.get(parentId) ?? []) {
      const p = placed.get(member.id) ?? { x: 0, y: 0, ...EMPTY_LOOP_BODY }
      nodes.push({
        id: member.id,
        type: member.kind,
        position: { x: p.x, y: p.y },
        width: p.width,
        height: p.height,
        data: { flow: member },
        draggable: false,
        connectable: false,
        selectable: member.durableNodeId !== undefined,
        sourcePosition: Position.Bottom,
        targetPosition: Position.Top,
        ...(parentId === undefined ? {} : { parentId, extent: 'parent' as const }),
      })
      if (member.kind === 'loop') emit(member.id)
    }
  }
  emit(undefined)

  const edges: FlowDiagramEdge[] = graph.edges
    .filter((edge) => ids.has(edge.source) && ids.has(edge.target))
    .map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      type: 'smoothstep',
      markerEnd: { type: MarkerType.ArrowClosed },
      data: edge.label === undefined ? {} : { label: edge.label },
    }))

  return { nodes, edges }
}

/** Changes only when the drawn structure changes, not on status or summary updates. */
export const getFlowStructureKey = (graph: FlowGraph) =>
  [
    ...graph.nodes.map((n) => `${n.id}:${n.kind}:${n.parentId ?? ''}`),
    ...graph.edges.map((e) => e.id),
  ].join('|')
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run components/interfaces/Integrations/Durable/Durable.flowLayout.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/studio/components/interfaces/Integrations/Durable/Durable.flowLayout.ts apps/studio/components/interfaces/Integrations/Durable/Durable.flowLayout.test.ts
git commit -m "feat(studio): lay out pg_durable flow graphs with dagre"
```

---

### Task 3: Flow diagram renderer

**Files:**

- Create: `WorkflowFlowNodes.tsx`, `WorkflowFlowDiagram.tsx`
- Test: `WorkflowFlowDiagram.test.tsx`
- Modify: `apps/studio/lib/i18n/locales/zh-CN.json`

**Interfaces:**

- Consumes: `FlowGraph`, `FlowNode`, `FlowEdgeLabel`, `getEdgeAppearance` (Task 1); `layoutFlowGraph`, `getFlowStructureKey`, `FlowDiagramNode`, `LOOP_HEADER_HEIGHT` (Task 2); `WorkflowStatus` from `./DurableShared`.
- Produces:
  - `flowNodeTypes: NodeTypes` (in `WorkflowFlowNodes.tsx`)
  - `WorkflowFlowDiagram(props: { graph: FlowGraph; className?: string; selectedNodeId?: string | null; onSelectNode?: (durableNodeId: string | null) => void; canExpand?: boolean })`
  - The canvas container is `role="region"` with accessible name `Workflow diagram`; every selectable node has `aria-label` = `[stepType, title, status].filter(Boolean).join(', ')` on the xyflow node wrapper (`role="group"`).

- [ ] **Step 1: Load the `copywriting` skill**

Copy introduced here: `Workflow diagram`, `Not configured yet`, `All branches`, `First to finish`. Reused existing keys: `Start`, `End`, `Then`, `Else`, `Expand`, `Unknown step`, `Iteration {{number}}`, `Continue after step failures`. Adjust wording only if the skill demands it, and keep tests in sync.

- [ ] **Step 2: Write the failing tests**

Create `WorkflowFlowDiagram.test.tsx`:

```tsx
import { fireEvent, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { mockAnimationsApi } from 'jsdom-testing-mocks'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'

import type { FlowGraph } from './Durable.flow'
import { WorkflowFlowDiagram } from './WorkflowFlowDiagram'
import { customRender } from '@/tests/lib/custom-render'

mockAnimationsApi()

const GRAPH: FlowGraph = {
  mode: 'runtime',
  nodes: [
    { id: '__start', kind: 'start', title: '' },
    {
      id: 'a',
      kind: 'step',
      stepType: 'SQL',
      title: 'load',
      summary: 'SELECT 1',
      status: 'completed',
      durableNodeId: 'a',
    },
    {
      id: 'b',
      kind: 'step',
      stepType: 'HTTP',
      title: 'notify',
      summary: 'POST https://x.dev',
      status: 'running',
      durableNodeId: 'b',
    },
    { id: '__end', kind: 'end', title: '' },
  ],
  edges: [
    { id: 'e1', source: '__start', target: 'a' },
    { id: 'e2', source: 'a', target: 'b' },
    { id: 'e3', source: 'b', target: '__end' },
  ],
}

const SelectableDiagram = ({ onSelectNode }: { onSelectNode: (id: string | null) => void }) => {
  const [selected, setSelected] = useState<string | null>(null)
  return (
    <WorkflowFlowDiagram
      graph={GRAPH}
      selectedNodeId={selected}
      onSelectNode={(id) => {
        setSelected(id)
        onSelectNode(id)
      }}
    />
  )
}

describe('WorkflowFlowDiagram', () => {
  it('renders nodes with titles, summaries, and terminals', () => {
    customRender(<WorkflowFlowDiagram graph={GRAPH} />)
    const diagram = screen.getByRole('region', { name: 'Workflow diagram' })
    expect(within(diagram).getByText('load')).toBeInTheDocument()
    expect(within(diagram).getByText('POST https://x.dev')).toBeInTheDocument()
    expect(within(diagram).getByText('Start')).toBeInTheDocument()
    expect(within(diagram).getByText('End')).toBeInTheDocument()
  })

  it('selects steps by click and keeps the newest selection', () => {
    const onSelectNode = vi.fn()
    customRender(<SelectableDiagram onSelectNode={onSelectNode} />)
    fireEvent.click(screen.getByText('load'))
    expect(onSelectNode).toHaveBeenLastCalledWith('a')
    fireEvent.click(screen.getByText('notify'))
    expect(onSelectNode).toHaveBeenLastCalledWith('b')
  })

  it('selects a focused step with Enter', () => {
    const onSelectNode = vi.fn()
    customRender(<SelectableDiagram onSelectNode={onSelectNode} />)
    const step = screen.getByRole('group', { name: 'SQL, load, completed' })
    step.focus()
    fireEvent.keyDown(step, { key: 'Enter' })
    expect(onSelectNode).toHaveBeenLastCalledWith('a')
  })

  it('opens a larger diagram from Expand', async () => {
    const user = userEvent.setup()
    customRender(<WorkflowFlowDiagram graph={GRAPH} canExpand />)
    await user.click(screen.getByRole('button', { name: 'Expand' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('load')).toBeInTheDocument()
  })

  it('shows a placeholder for incomplete builder steps', () => {
    customRender(
      <WorkflowFlowDiagram
        graph={{
          mode: 'builder',
          nodes: [{ id: 's', kind: 'step', stepType: 'SQL', title: 'Step 1', isIncomplete: true }],
          edges: [],
        }}
      />
    )
    expect(screen.getByText('Not configured yet')).toBeInTheDocument()
  })

  it('captions race merges and shows loop details', () => {
    customRender(
      <WorkflowFlowDiagram
        graph={{
          mode: 'runtime',
          nodes: [
            { id: 'm', kind: 'merge', title: '', mergeMode: 'first' },
            {
              id: 'l',
              kind: 'loop',
              stepType: 'LOOP',
              title: 'poll',
              summary: 'SELECT done',
              continueOnFailure: true,
              iteration: 4,
            },
          ],
          edges: [],
        }}
      />
    )
    expect(screen.getByText('First to finish')).toBeInTheDocument()
    expect(screen.getByText('SELECT done')).toBeInTheDocument()
    expect(screen.getByText('Continue after step failures')).toBeInTheDocument()
    expect(screen.getByText('Iteration 4')).toBeInTheDocument()
  })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm vitest run components/interfaces/Integrations/Durable/WorkflowFlowDiagram.test.tsx`
Expected: FAIL — `Failed to resolve import "./WorkflowFlowDiagram"`.

- [ ] **Step 4: Implement `WorkflowFlowNodes.tsx`**

```tsx
import { Handle, Position, type NodeProps, type NodeTypes } from '@xyflow/react'
import { Repeat, Split } from 'lucide-react'
import type { PropsWithChildren } from 'react'
import { Badge, cn } from 'ui'

import type { FlowNode } from './Durable.flow'
import type { FlowDiagramNode } from './Durable.flowLayout'
import { WorkflowStatus } from './DurableShared'
import { t as $t } from '@/lib/i18n'

const MERGE_CAPTIONS = { all: 'All branches', first: 'First to finish' } as const
const SELECTED_RING = 'ring-2 ring-foreground-light'

const getStatusAccent = (status?: string | null) => {
  switch (status?.toLowerCase()) {
    case 'completed':
      return 'border-brand-500'
    case 'failed':
      return 'border-destructive-500'
    case 'running':
      return 'border-warning-400'
    case 'skipped':
    case 'cancelled':
      return 'border-dashed opacity-60'
    default:
      return ''
  }
}

const HiddenHandles = () => (
  <>
    <Handle type="target" position={Position.Top} isConnectable={false} className="!opacity-0" />
    <Handle type="source" position={Position.Bottom} isConnectable={false} className="!opacity-0" />
  </>
)

const StatusIndicator = ({ status }: { status?: string | null }) => {
  if (!status) return null
  return (
    <span className="flex items-center gap-1 shrink-0">
      {status.toLowerCase() === 'running' && (
        <span className="size-2 rounded-full bg-warning animate-pulse" aria-hidden />
      )}
      <WorkflowStatus status={status} />
    </span>
  )
}

const Summary = ({ flow }: { flow: FlowNode }) => {
  if (flow.isIncomplete) {
    return (
      <p className="text-xs italic text-foreground-muted truncate">{$t('Not configured yet')}</p>
    )
  }
  if (!flow.summary) return null
  return (
    <p className="text-xs font-mono text-foreground-light truncate" title={flow.summary}>
      {flow.summary}
    </p>
  )
}

const CardShell = ({
  selected,
  status,
  isDashed = false,
  children,
}: PropsWithChildren<{ selected: boolean; status?: string | null; isDashed?: boolean }>) => (
  <div
    className={cn(
      'h-full w-full rounded-md border bg-surface-100 px-3 py-2 flex flex-col justify-center gap-1',
      getStatusAccent(status),
      isDashed && 'border-dashed',
      selected && SELECTED_RING
    )}
  >
    <HiddenHandles />
    {children}
  </div>
)

const StepNode = ({ data, selected }: NodeProps<FlowDiagramNode>) => {
  const { flow } = data
  return (
    <CardShell selected={selected} status={flow.status}>
      <div className="flex items-center gap-2 min-w-0">
        {flow.kind === 'decision' && (
          <Split size={14} className="text-foreground-light shrink-0" aria-hidden />
        )}
        <Badge>{flow.stepType}</Badge>
        <span className="text-xs font-mono truncate" title={flow.title}>
          {flow.title}
        </span>
        <span className="ml-auto">
          <StatusIndicator status={flow.status} />
        </span>
      </div>
      <Summary flow={flow} />
    </CardShell>
  )
}

const UnknownNode = ({ data, selected }: NodeProps<FlowDiagramNode>) => (
  <CardShell selected={selected} isDashed>
    <span className="text-xs text-foreground-muted">{$t('Unknown step')}</span>
    <code className="text-xs text-foreground-muted truncate">{data.flow.title}</code>
  </CardShell>
)

const GatewayNode = ({ data, selected }: NodeProps<FlowDiagramNode>) => {
  const { flow } = data
  const caption = flow.mergeMode ? $t(MERGE_CAPTIONS[flow.mergeMode]) : null
  return (
    <div className={cn('h-full w-full flex flex-col items-center', selected && SELECTED_RING)}>
      <HiddenHandles />
      <div className="h-2 w-full rounded-full bg-foreground-muted" />
      {caption && (
        <span className="text-[10px] leading-4 text-foreground-light truncate max-w-full">
          {flow.title ? `${flow.title} · ${caption}` : caption}
        </span>
      )}
    </div>
  )
}

const TerminalNode = ({ data }: NodeProps<FlowDiagramNode>) => (
  <div className="h-full w-full rounded-full border bg-surface-200 flex items-center justify-center text-xs text-foreground-light">
    <HiddenHandles />
    {data.flow.kind === 'start' ? $t('Start') : $t('End')}
  </div>
)

const LoopNode = ({ data, selected }: NodeProps<FlowDiagramNode>) => {
  const { flow } = data
  return (
    <div
      className={cn(
        'h-full w-full rounded-md border border-dashed',
        getStatusAccent(flow.status),
        selected && SELECTED_RING
      )}
    >
      <HiddenHandles />
      {/* h-8 must match LOOP_HEADER_HEIGHT in Durable.flowLayout.ts */}
      <div className="h-8 flex items-center gap-2 px-3 min-w-0">
        <Repeat size={14} className="text-foreground-light shrink-0" aria-hidden />
        <Badge>{flow.stepType}</Badge>
        <span className="text-xs font-mono truncate" title={flow.summary ?? flow.title}>
          {flow.summary ?? flow.title}
        </span>
        {flow.continueOnFailure && (
          <span className="text-[11px] text-foreground-light shrink-0">
            {$t('Continue after step failures')}
          </span>
        )}
        {typeof flow.iteration === 'number' && (
          <span className="text-[11px] text-foreground-light shrink-0">
            {$t('Iteration {{number}}', { number: flow.iteration })}
          </span>
        )}
        <span className="ml-auto">
          <StatusIndicator status={flow.status} />
        </span>
      </div>
    </div>
  )
}

/** Keys match `FlowNode.kind`, which `layoutFlowGraph` uses as the React Flow node type. */
export const flowNodeTypes: NodeTypes = {
  start: TerminalNode,
  end: TerminalNode,
  step: StepNode,
  decision: StepNode,
  unknown: UnknownNode,
  fork: GatewayNode,
  merge: GatewayNode,
  loop: LoopNode,
}
```

If `NodeTypes` rejects the `NodeProps<FlowDiagramNode>` components, type the map as `satisfies Record<FlowNode['kind'], ComponentType<NodeProps<FlowDiagramNode>>>` and pass it to `ReactFlow<FlowDiagramNode>` (no `as` casts).

- [ ] **Step 5: Implement `WorkflowFlowDiagram.tsx`**

```tsx
import {
  Background,
  Controls,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  type NodeChange,
  type NodeSelectionChange,
} from '@xyflow/react'
import { Maximize2 } from 'lucide-react'
import { useTheme } from 'next-themes'
import { useMemo, useState } from 'react'

import '@xyflow/react/dist/style.css'

import { Button, cn, Dialog, DialogContent, DialogHeader, DialogSection, DialogTitle } from 'ui'

import {
  getEdgeAppearance,
  type FlowEdgeLabel,
  type FlowGraph,
  type FlowNode,
} from './Durable.flow'
import { getFlowStructureKey, layoutFlowGraph, type FlowDiagramNode } from './Durable.flowLayout'
import { flowNodeTypes } from './WorkflowFlowNodes'
import { t as $t } from '@/lib/i18n'

type WorkflowFlowDiagramProps = {
  graph: FlowGraph
  /** Height utility for the canvas, e.g. `h-80`. Defaults to `h-[420px]`. */
  className?: string
  selectedNodeId?: string | null
  onSelectNode?: (durableNodeId: string | null) => void
  canExpand?: boolean
}

const MUTED_EDGE_STYLE = { strokeDasharray: '4 4', opacity: 0.5 }

const getEdgeLabelText = (label?: FlowEdgeLabel) => {
  if (label === 'then') return $t('Then')
  if (label === 'else') return $t('Else')
  return undefined
}

const getNodeAriaLabel = (flow: FlowNode) =>
  [flow.stepType, flow.title, flow.status].filter(Boolean).join(', ') || undefined

const FlowCanvas = ({
  graph,
  className,
  selectedNodeId,
  onSelectNode,
  onExpand,
}: Omit<WorkflowFlowDiagramProps, 'canExpand'> & { onExpand?: () => void }) => {
  const { resolvedTheme } = useTheme()
  // Dagre layout is the expensive part; reuse it while the graph object is unchanged.
  const layout = useMemo(() => layoutFlowGraph(graph), [graph])
  const canSelect = onSelectNode !== undefined
  const statusById = new Map(graph.nodes.map((node) => [node.id, node.status]))

  const nodes = layout.nodes.map((node) => ({
    ...node,
    selectable: canSelect && node.selectable,
    selected: !!selectedNodeId && node.data.flow.durableNodeId === selectedNodeId,
    ariaLabel: getNodeAriaLabel(node.data.flow),
  }))
  const edges = layout.edges.map((edge) => {
    const { animated, isMuted } = getEdgeAppearance(graph.mode, statusById.get(edge.target))
    return {
      ...edge,
      animated,
      label: getEdgeLabelText(edge.data?.label),
      style: isMuted ? MUTED_EDGE_STYLE : undefined,
    }
  })

  const durableIdOf = (id: string) =>
    layout.nodes.find((node) => node.id === id)?.data.flow.durableNodeId ?? null

  // Selection changes can arrive in any order within a batch; the newly selected node wins.
  const handleNodesChange = (changes: NodeChange<FlowDiagramNode>[]) => {
    if (!onSelectNode) return
    const selectChanges = changes.filter(
      (change): change is NodeSelectionChange => change.type === 'select'
    )
    const picked = selectChanges.find((change) => change.selected)
    if (picked) {
      onSelectNode(durableIdOf(picked.id))
      return
    }
    if (selectChanges.some((change) => durableIdOf(change.id) === selectedNodeId)) {
      onSelectNode(null)
    }
  }

  return (
    <div
      role="region"
      aria-label={$t('Workflow diagram')}
      className={cn('relative rounded-md border overflow-hidden', className ?? 'h-[420px]')}
    >
      {/* Remount (and refit) only when the structure changes, so status polling keeps the
          user's pan and zoom. */}
      <ReactFlowProvider key={getFlowStructureKey(graph)}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={flowNodeTypes}
          onNodesChange={handleNodesChange}
          onPaneClick={() => onSelectNode?.(null)}
          fitView
          fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
          minZoom={0.2}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={canSelect}
          colorMode={resolvedTheme === 'dark' ? 'dark' : 'light'}
          proOptions={{ hideAttribution: true }}
        >
          <Background />
          <Controls showInteractive={false} position="bottom-right" />
          {onExpand && (
            <Panel position="top-right">
              <Button size="tiny" icon={<Maximize2 size={12} />} onClick={onExpand}>
                {$t('Expand')}
              </Button>
            </Panel>
          )}
        </ReactFlow>
      </ReactFlowProvider>
    </div>
  )
}

export const WorkflowFlowDiagram = ({ canExpand = false, ...props }: WorkflowFlowDiagramProps) => {
  const [isExpanded, setIsExpanded] = useState(false)
  return (
    <>
      <FlowCanvas {...props} onExpand={canExpand ? () => setIsExpanded(true) : undefined} />
      {canExpand && (
        <Dialog open={isExpanded} onOpenChange={setIsExpanded}>
          <DialogContent size="xxlarge">
            <DialogHeader>
              <DialogTitle>{$t('Workflow diagram')}</DialogTitle>
            </DialogHeader>
            <DialogSection>
              <FlowCanvas {...props} className="h-[70vh]" />
            </DialogSection>
          </DialogContent>
        </Dialog>
      )}
    </>
  )
}
```

Fallback if the selection tests fail because select changes are not emitted for clicks: add `onNodeClick={(_, node) => onSelectNode?.(node.data.flow.durableNodeId ?? null)}` and keep `handleNodesChange` for keyboard selection. Do not add both paths unless a test proves it is needed.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm vitest run components/interfaces/Integrations/Durable/WorkflowFlowDiagram.test.tsx`
Expected: PASS (6 tests). Edges do not render in jsdom (handles are unmeasured); that is expected and no test asserts edge DOM.

- [ ] **Step 7: Add translations**

Add to `apps/studio/lib/i18n/locales/zh-CN.json` (keep the file's existing key order convention; check with `node -e` that each key is new before adding):

```json
"Workflow diagram": "工作流流程图",
"Not configured yet": "尚未配置",
"All branches": "全部分支完成",
"First to finish": "最先完成者胜出"
```

Run: `node -e "JSON.parse(require('fs').readFileSync('apps/studio/lib/i18n/locales/zh-CN.json','utf8'))" && echo ok` (from repo root)
Expected: `ok`.

- [ ] **Step 8: Typecheck and commit**

Run (from `apps/studio`): `pnpm tsc --noEmit -p . 2>&1 | grep -E "WorkflowFlow|Durable.flow" || echo clean`
Expected: `clean`.

```bash
git add apps/studio/components/interfaces/Integrations/Durable/WorkflowFlowNodes.tsx apps/studio/components/interfaces/Integrations/Durable/WorkflowFlowDiagram.tsx apps/studio/components/interfaces/Integrations/Durable/WorkflowFlowDiagram.test.tsx apps/studio/lib/i18n/locales/zh-CN.json
git commit -m "feat(studio): render pg_durable flow diagrams with React Flow"
```

---

### Task 4: Graph view in the workflow detail sheet

**Files:**

- Create: `WorkflowStepDetails.tsx`, `WorkflowStepsSection.tsx`
- Modify: `WorkflowStepTree.tsx` (use `WorkflowStepDetails`), `WorkflowDetailSheet.tsx:259-270` (replace the Steps section body)
- Test: `WorkflowDetailSheet.test.tsx`
- Modify: `apps/studio/lib/i18n/locales/zh-CN.json`

**Interfaces:**

- Consumes: `treeToFlowGraph`, `getFirstFailedNodeId` (Task 1); `WorkflowFlowDiagram` (Task 3); `DurableTreeNode` from `./Durable.tree`; `WorkflowStepTree`; `WorkflowStatus`.
- Produces:
  - `WorkflowStepDetails({ node }: { node: DurableNode })` — skip reason, definition, result or error, collapsed metadata.
  - `WorkflowStepsSection({ tree, nodes, instanceStatus }: { tree: DurableTreeNode | null; nodes: DurableNode[]; instanceStatus?: string | null })`

- [ ] **Step 1: Update the detail sheet tests (failing)**

In `WorkflowDetailSheet.test.tsx`:

1. Add `within` to the `@testing-library/react` import.
2. Add a helper after `renderSheet`:

```tsx
const showList = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(await screen.findByRole('radio', { name: 'List' }))
}
```

3. Change `renders steps in chain order` to switch to the list first:

```tsx
it('renders steps in chain order in the list view', async () => {
  mockQueries()
  const { user } = renderSheet()
  await showList(user)
  await waitFor(() => expect(screen.getAllByText('SQL')).toHaveLength(3))
  const ids = ['a', 'b', 'c'].map((id) => screen.getByText(id))
  for (let i = 0; i < ids.length - 1; i++) {
    expect(
      ids[i].compareDocumentPosition(ids[i + 1]) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  }
})
```

4. Change `explains skipped steps` to call `await showList(user)` (destructure `user` from `renderSheet()`) before the assertion.
5. Add new tests inside the same `describe`:

```tsx
it('shows the graph by default and preselects the failed step', async () => {
  mockQueries()
  renderSheet()
  const diagram = await screen.findByRole('region', { name: 'Workflow diagram' })
  expect(within(diagram).getByRole('group', { name: 'SQL, b, failed' })).toBeInTheDocument()
  expect(screen.getByRole('radio', { name: 'Graph' })).toHaveAttribute('aria-checked', 'true')
  expect(await screen.findByText(/boom explosion/)).toBeInTheDocument()
})

it('shows the details of a clicked step', async () => {
  mockQueries()
  renderSheet()
  const diagram = await screen.findByRole('region', { name: 'Workflow diagram' })
  fireEvent.click(within(diagram).getByText('a'))
  expect(await screen.findByText(/first ok/)).toBeInTheDocument()
  expect(screen.queryByText(/boom explosion/)).not.toBeInTheDocument()
})

it('asks for a selection when nothing failed', async () => {
  mockQueries(CHAIN.map((n) => ({ ...n, status: 'completed' })))
  renderSheet()
  await screen.findByRole('region', { name: 'Workflow diagram' })
  expect(screen.getByText('Select a step to see its details.')).toBeInTheDocument()
})
```

Note: the mocked instance `info.status` is `'failed'` in every case, so "asks for a selection" relies on no node being failed (`getFirstFailedNodeId` returns null).

Run: `pnpm vitest run components/interfaces/Integrations/Durable/WorkflowDetailSheet.test.tsx`
Expected: FAIL — no `radio` named `List`, no `Workflow diagram` region.

- [ ] **Step 2: Extract `WorkflowStepDetails.tsx`**

```tsx
import { formatWorkflowValue } from './Durable.utils'
import type { DurableNode } from '@/data/pg-durable/pg-durable.types'
import { t as $t } from '@/lib/i18n'

export const WorkflowStepDetails = ({ node }: { node: DurableNode }) => {
  const status = (node.inferred_status ?? node.status)?.toLowerCase()
  const isFailed = status === 'failed'
  const isSkipped = status === 'skipped'
  return (
    <>
      {isSkipped && node.inferred_status_from_ancestor_id && (
        <p className="text-xs text-foreground-light">
          {$t("Skipped because step {{id}} decided this branch won't run.", {
            id: node.inferred_status_from_ancestor_id,
          })}
        </p>
      )}
      {node.query && (
        <>
          <p className="text-xs text-foreground-light">{$t('Step definition')}</p>
          <pre className="text-xs font-mono whitespace-pre-wrap break-all max-h-60 overflow-auto">
            {formatWorkflowValue(node.query)}
          </pre>
        </>
      )}
      {isFailed ? (
        <>
          <p className="text-xs text-foreground-light">{$t('Error')}</p>
          <pre className="text-xs font-mono whitespace-pre-wrap break-all max-h-60 overflow-auto text-destructive">
            {formatWorkflowValue(node.result)}
          </pre>
        </>
      ) : (
        <>
          <p className="text-xs text-foreground-light">{$t('Step result')}</p>
          <pre className="text-xs font-mono whitespace-pre-wrap break-all max-h-60 overflow-auto">
            {formatWorkflowValue(node.result)}
          </pre>
        </>
      )}
      {node.status_details && (
        <details className="border rounded-md">
          <summary className="cursor-pointer p-2 text-xs text-foreground-light">
            {$t('Metadata')}
          </summary>
          <pre className="text-xs font-mono whitespace-pre-wrap break-all p-2 pt-0 max-h-60 overflow-auto">
            {formatWorkflowValue(node.status_details)}
          </pre>
        </details>
      )}
    </>
  )
}
```

In `WorkflowStepTree.tsx`, replace the body of `<div className="p-4 pt-0 space-y-3">…</div>` (current lines 63-104) with `<WorkflowStepDetails node={node} />`, import it from `./WorkflowStepDetails`, and delete the now-unused `isFailed`, `isSkipped`, and `formatWorkflowValue` import. `status` stays (used by `WorkflowStatus`).

- [ ] **Step 3: Create `WorkflowStepsSection.tsx`**

```tsx
import { List, Workflow } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Badge, ToggleGroup, ToggleGroupItem } from 'ui'

import { getFirstFailedNodeId, treeToFlowGraph } from './Durable.flow'
import type { DurableTreeNode } from './Durable.tree'
import { WorkflowStatus } from './DurableShared'
import { WorkflowFlowDiagram } from './WorkflowFlowDiagram'
import { WorkflowStepDetails } from './WorkflowStepDetails'
import { WorkflowStepTree } from './WorkflowStepTree'
import type { DurableNode } from '@/data/pg-durable/pg-durable.types'
import { t as $t } from '@/lib/i18n'

type StepView = 'graph' | 'list'

export const WorkflowStepsSection = ({
  tree,
  nodes,
  instanceStatus,
}: {
  tree: DurableTreeNode | null
  nodes: DurableNode[]
  instanceStatus?: string | null
}) => {
  const [view, setView] = useState<StepView>('graph')
  // null until the user picks a step, so a failed step can be preselected.
  const [selection, setSelection] = useState<{ nodeId: string | null } | null>(null)
  // Stable graph identity lets the diagram reuse its layout across unrelated re-renders.
  const graph = useMemo(() => (tree ? treeToFlowGraph(tree) : null), [tree])
  const failedNodeId =
    instanceStatus?.toLowerCase() === 'failed' ? getFirstFailedNodeId(graph) : null
  const selectedNodeId = selection ? selection.nodeId : failedNodeId
  const selectedNode = nodes.find((node) => node.node_id === selectedNodeId)

  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <h4>{$t('Steps')}</h4>
        {graph && (
          <ToggleGroup
            type="single"
            size="sm"
            value={view}
            onValueChange={(value) => {
              if (value === 'graph' || value === 'list') setView(value)
            }}
          >
            <ToggleGroupItem value="graph" className="gap-1 px-2">
              <Workflow size={14} aria-hidden />
              <span className="text-xs">{$t('Graph')}</span>
            </ToggleGroupItem>
            <ToggleGroupItem value="list" className="gap-1 px-2">
              <List size={14} aria-hidden />
              <span className="text-xs">{$t('List')}</span>
            </ToggleGroupItem>
          </ToggleGroup>
        )}
      </div>
      <p className="text-xs text-foreground-light">
        {$t(
          'Step status reflects the current execution, including steps waiting for timers or signals.'
        )}
      </p>
      {graph && view === 'graph' && (
        <>
          <WorkflowFlowDiagram
            graph={graph}
            selectedNodeId={selectedNodeId}
            onSelectNode={(nodeId) => setSelection({ nodeId })}
            canExpand
          />
          {selectedNode ? (
            <div className="border rounded-md bg-surface-100 p-4 space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge>{selectedNode.node_type}</Badge>
                <span className="text-xs font-mono">
                  {selectedNode.result_name || selectedNode.node_id}
                </span>
                <span className="ml-auto">
                  <WorkflowStatus status={selectedNode.inferred_status ?? selectedNode.status} />
                </span>
              </div>
              <WorkflowStepDetails node={selectedNode} />
            </div>
          ) : (
            <p className="text-xs text-foreground-light">
              {$t('Select a step to see its details.')}
            </p>
          )}
        </>
      )}
      {tree && view === 'list' && <WorkflowStepTree root={tree} />}
      {nodes.length === 0 && (
        <p className="text-xs text-foreground-light">{$t('No steps available yet')}</p>
      )}
    </>
  )
}
```

- [ ] **Step 4: Wire it into `WorkflowDetailSheet.tsx`**

Replace the Steps `SheetSection` (currently lines 259-270) with:

```tsx
<SheetSection className="border-t space-y-3">
  <WorkflowStepsSection
    tree={stepTree}
    nodes={detail.data.nodes}
    instanceStatus={detail.data.info.status}
  />
</SheetSection>
```

Replace `import { WorkflowStepTree } from './WorkflowStepTree'` with `import { WorkflowStepsSection } from './WorkflowStepsSection'`.

- [ ] **Step 5: Add translations**

Add to `zh-CN.json` (`List` already exists):

```json
"Graph": "图",
"Select a step to see its details.": "选择一个步骤以查看详情。"
```

- [ ] **Step 6: Run the Durable tests**

Run: `pnpm vitest run components/interfaces/Integrations/Durable`
Expected: PASS for every Durable test file. If an existing assertion now matches both the graph and the details panel (duplicate text), scope it with `within(...)` rather than deleting it.

- [ ] **Step 7: Commit**

```bash
git add apps/studio/components/interfaces/Integrations/Durable/WorkflowStepDetails.tsx apps/studio/components/interfaces/Integrations/Durable/WorkflowStepsSection.tsx apps/studio/components/interfaces/Integrations/Durable/WorkflowStepTree.tsx apps/studio/components/interfaces/Integrations/Durable/WorkflowDetailSheet.tsx apps/studio/components/interfaces/Integrations/Durable/WorkflowDetailSheet.test.tsx apps/studio/lib/i18n/locales/zh-CN.json
git commit -m "feat(studio): show pg_durable workflow steps as a flow diagram"
```

---

### Task 5: Live flow preview in the create sheet

**Files:**

- Modify: `CreateWorkflowSheet.tsx` (builder step list section around lines 430-440; expression section around lines 451-475)
- Test: `CreateWorkflowSheet.test.tsx`
- Modify: `apps/studio/lib/i18n/locales/zh-CN.json`

**Interfaces:**

- Consumes: `formToFlowGraph` (Task 1), `WorkflowFlowDiagram` (Task 3); the existing `values = useWatch({ control: form.control })`.
- Produces: no new exports.

- [ ] **Step 1: Write the failing tests**

Add `within` to the `@testing-library/react` import in `CreateWorkflowSheet.test.tsx`, then add inside `describe('workflow creation', …)`:

```tsx
it('shows a live flow preview in builder mode', async () => {
  const { user } = renderSheet()
  const diagram = screen.getByRole('region', { name: 'Workflow diagram' })
  expect(within(diagram).getByText('SELECT 1 AS result')).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Add step' }))
  const updated = screen.getByRole('region', { name: 'Workflow diagram' })
  expect(within(updated).getAllByText('SELECT 1 AS result')).toHaveLength(2)
})

it('shows loop bodies inside the flow preview', async () => {
  const { user } = renderSheet()
  await chooseStepType(user, 'Loop')
  const diagram = screen.getByRole('region', { name: 'Workflow diagram' })
  expect(within(diagram).getByText('LOOP')).toBeInTheDocument()
  expect(within(diagram).getByText('Step 1.1')).toBeInTheDocument()
})

it('explains that expression mode has no flow preview', () => {
  renderSheet({ initialValues: { mode: 'expression', expression: 'df.sleep(1)' } })
  expect(screen.queryByRole('region', { name: 'Workflow diagram' })).not.toBeInTheDocument()
  expect(screen.getByText('Flow preview is available in builder mode.')).toBeInTheDocument()
})
```

Run: `pnpm vitest run components/interfaces/Integrations/Durable/CreateWorkflowSheet.test.tsx`
Expected: FAIL — no `Workflow diagram` region; missing builder-mode note.

- [ ] **Step 2: Add the preview to the builder section**

In `CreateWorkflowSheet.tsx`, import:

```tsx
import { formToFlowGraph } from './Durable.flow'
import { WorkflowFlowDiagram } from './WorkflowFlowDiagram'
```

Insert directly after the `Add step` `<Button>` and before `{planPreview}`:

```tsx
<details open className="text-sm">
  <summary className="cursor-pointer text-foreground-light">{$t('Flow preview')}</summary>
  <WorkflowFlowDiagram graph={formToFlowGraph(values)} className="h-80 mt-3" canExpand />
</details>
```

- [ ] **Step 3: Add the expression-mode note**

As the last child of the `mode === 'expression'` `SheetSection`, add:

```tsx
<p className="text-xs text-foreground-light">{$t('Flow preview is available in builder mode.')}</p>
```

- [ ] **Step 4: Add translations**

```json
"Flow preview": "流程预览",
"Flow preview is available in builder mode.": "流程预览仅在构建器模式下可用。"
```

- [ ] **Step 5: Run the Durable tests**

Run: `pnpm vitest run components/interfaces/Integrations/Durable`
Expected: PASS for all files. Existing create-sheet tests that query by text shared with the diagram (`Step 1`, SQL text) must be scoped with `within(...)` if they start matching twice.

- [ ] **Step 6: Commit**

```bash
git add apps/studio/components/interfaces/Integrations/Durable/CreateWorkflowSheet.tsx apps/studio/components/interfaces/Integrations/Durable/CreateWorkflowSheet.test.tsx apps/studio/lib/i18n/locales/zh-CN.json
git commit -m "feat(studio): preview pg_durable workflows as a flow while building"
```

---

### Task 6: Gates and browser check

**Files:**

- Modify only if a gate fails (fix in the file the gate names).

- [ ] **Step 1: Typecheck**

Run (from repo root): `pnpm --filter studio typecheck`
Expected: exit 0.

- [ ] **Step 2: Lint ratchet**

Run: `pnpm --filter studio run lint:ratchet`
Expected: no rule count increase. Fix new warnings (e.g. `exhaustive-deps`, non-null assertions) instead of raising the baseline.

- [ ] **Step 3: Dead code**

Run: `pnpm knip --workspace apps/studio`
Expected: no new unused files or exports from the Durable folder (`FLOW_NODE_SIZES`, `LOOP_*`, `getRuntimeSummary` are used by tests and code; if knip flags an export used only by tests, drop the `export`).

- [ ] **Step 4: Prettier**

Run: `pnpm test:prettier`
Expected: pass. If not, run `pnpm prettier --write` on the touched files and commit the result in Step 7.

- [ ] **Step 5: Full Durable suite**

Run (from `apps/studio`): `pnpm vitest run components/interfaces/Integrations/Durable data/pg-durable`
Expected: all pass.

- [ ] **Step 6: Browser check of the builder preview**

Start the dev server (`pnpm dev:studio`, see the `studio-source-dev-selfhosted` memory for `.env.local`) and open the pg_durable integration → Workflows → Create workflow. Verify in both light and dark themes:

- Default step shows Start → SQL card → End; typing in the SQL field updates the card summary without the view jumping.
- Switching a step to Loop shows a dashed group with the body inside and visible edges between body steps (if edges are hidden under the group, set `zIndex: 1` on edges whose endpoints have a `parentId`, then re-run Task 3 tests).
- If / Race / Parallel draw decision and fork/merge shapes; Expand opens the large dialog.

Runtime diagrams cannot be checked live (no pg_durable 0.2.8 instance); they are covered by fixtures. Record this gap in the final report.

- [ ] **Step 7: Commit any gate fixes**

```bash
git add -A apps/studio/components/interfaces/Integrations/Durable apps/studio/lib/i18n/locales/zh-CN.json
git commit -m "chore(studio): satisfy gates for pg_durable flow diagram"
```

Skip this step if nothing changed.
