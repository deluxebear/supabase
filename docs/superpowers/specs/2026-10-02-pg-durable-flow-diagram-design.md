# pg_durable flow diagram (DAG) — design

Date: 2026-10-02
Branch: `custom/main` (fork)
Builds on: pg_durable 0.2.8 Studio UI (`docs/superpowers/specs/2026-10-01-pg-durable-0.2.8-ui-design.md`)

## Goal

Show pg_durable workflows as a flow diagram (DAG) instead of only an indented list, in two
places:

1. **Workflow detail sheet (runtime)** — the nodes of one instance, colored by status, so a
   user can see at a glance where a workflow is, which branch ran, and where it failed.
2. **Create workflow sheet (builder preview)** — a live diagram of the workflow being built,
   so a user can check the control flow before starting it.

One rendering component serves both; only the data source differs.

### Decisions already made

- Both placements, one shared renderer.
- Detail sheet: **Graph / List toggle, Graph by default**. The existing `WorkflowStepTree`
  stays as the List view (long workflows, accessibility, copy-friendly).
- Approach: a source-agnostic flow-graph model with two pure adapters, a pure layout function
  (dagre), and an `@xyflow/react` renderer. No new dependencies — Studio already ships
  `@xyflow/react` and `@dagrejs/dagre`.
- UX details below were delegated ("best practice, you decide").

### Non-goals

- Editing the workflow by dragging nodes or drawing edges (the builder form stays the editor).
- A diagram for expression mode (DSL text is not parsed client-side; see §4).
- Per-iteration loop history (one node per step; the latest iteration number is shown).
- Live polling changes — the diagram re-renders from the same detail query the sheet already
  polls.

## 1. Flow-graph model (`Durable.flow.ts`)

```ts
type FlowNodeKind = 'start' | 'end' | 'step' | 'decision' | 'fork' | 'merge' | 'loop' | 'unknown'

type FlowNode = {
  id: string // unique within the graph
  kind: FlowNodeKind
  parentId?: string // set for nodes inside a loop group
  stepType?: string // SQL, HTTP, SLEEP, SIGNAL, WAIT_SCHEDULE, HTTP_MULTIPART, BREAK, …
  title: string // result name, else node id (runtime) / "Step N" (builder)
  summary?: string // one line: SQL first line, URL, signal name, cron, seconds, condition
  status?: string | null // runtime only (inferred_status ?? status)
  iteration?: number | null // runtime, nodes inside a loop
  mergeMode?: 'all' | 'first' // merge nodes: JOIN = all, RACE = first
  durableNodeId?: string // runtime: df node id, used for selection → details
}

type FlowEdge = {
  id: string
  source: string
  target: string
  label?: 'then' | 'else' // parallel lanes are unlabeled; the fork/merge bars make them clear
}

type FlowGraph = { nodes: FlowNode[]; edges: FlowEdge[] }
```

### Mapping (both adapters produce the same shapes)

| Construct         | Graph                                                                                    |
| ----------------- | ---------------------------------------------------------------------------------------- |
| Workflow          | `start` → … → `end`                                                                      |
| Sequence / THEN   | steps chained in order                                                                   |
| Leaf step         | one `step` node                                                                          |
| JOIN / parallel   | `fork` → one lane per branch → `merge` (`mergeMode: 'all'`), lanes unlabeled             |
| RACE              | same as JOIN with `mergeMode: 'first'`                                                   |
| IF / IF_ROWS      | `decision` (summary = condition / rows result name) → `then` lane, `else` lane → `merge` |
| Empty else        | `decision` → `merge` edge labeled `else` (no placeholder node)                           |
| LOOP              | `loop` group node; body nodes have `parentId` = loop id, chained inside the group        |
| Missing reference | `unknown` node (dashed), never throws                                                    |

Adapters convert recursively; each sub-conversion returns `{ entry, exit }` node ids so the
caller can chain it. Edge ids are `${source}->${target}` with a suffix for duplicates.

### `treeToFlowGraph(root: DurableTreeNode): FlowGraph` (runtime)

Consumes the existing `buildNodeTree` output (THEN chains already flattened, roles already
assigned, cycles and missing references already turned into `node: null` leaves).

- An IF node becomes one `decision` node: `durableNodeId`, `status` and selection come from
  the IF df node; `summary` comes from the `condition` child's query (or the rows result
  name for IF_ROWS). The condition child is not drawn as a separate node.
- LOOP condition (if any) goes in the loop group's header, not as a separate node.
- `status` = `inferred_status ?? status`; `iteration` = `parseExecutionGeneration(...)` for
  `inLoop` nodes.

### `formToFlowGraph(values: WorkflowFormValues): FlowGraph` (builder)

Consumes the **raw** watched form values (not the zod-parsed result), so the diagram updates
while the user types and still renders with invalid or empty fields:

- Empty fields render as a muted placeholder summary ("No query yet", "No URL yet").
- Top-level `composition: 'parallel'` wraps the top-level steps in one fork/merge.
- Container children use the same leaf mapping; `if` / `if_rows` arms, `loop` body,
  `race` / `parallel` bodies follow the table above.
- No `status`, no `durableNodeId`.

## 2. Layout (`Durable.flowLayout.ts`)

`layoutFlowGraph(graph: FlowGraph): { nodes: Node[]; edges: Edge[] }` — returns
`@xyflow/react` nodes and edges with positions. Pure and unit-tested.

- Direction **top → bottom** (`rankdir: 'TB'`): sheets are tall and narrow; parallel lanes
  spread horizontally.
- **Fixed node sizes** per kind (no measure-then-relayout pass): step / decision 240×64,
  start / end 96×32 pill, fork 120×8 bar, merge 160×24 (bar + caption), unknown 240×48. Text truncates with a
  native `title` tooltip.
- **Loop groups lay out bottom-up**: each loop's children are laid out with their own dagre
  pass, the group's size becomes the bounding box plus padding and a 32px header, and the
  group is then a single fixed-size node in its parent's dagre pass. Children get positions
  relative to the group (`parentId` + `extent: 'parent'`). Works at any nesting depth
  (runtime graphs can nest deeper than the two-level builder).
- No real back edge for loops (dagre handles cycles poorly and it clutters the lanes); the
  group header shows a repeat icon and the condition instead.

## 3. Renderer (`WorkflowFlowDiagram.tsx`, `WorkflowFlowNodes.tsx`)

`WorkflowFlowDiagram` props: `graph`, `height` (default 420), `selectedNodeId?`,
`onSelectNode?`. Wraps its own `ReactFlowProvider`.

### Canvas

- `fitView` on mount and whenever the set of node ids changes (not on every status poll, so
  a user's pan/zoom is kept while a workflow runs).
- Pan and zoom enabled; nodes not draggable or connectable; `onlyRenderVisibleElements`.
- Small control cluster (zoom in, zoom out, fit view) and an **Expand** button that opens the
  same diagram in a large `Dialog` for big workflows.
- Background dots via the xyflow `Background`, theme-aware like `DiagramFlow`.

### Node visuals (semantic tokens only)

| Kind      | Look                                                                                           |
| --------- | ---------------------------------------------------------------------------------------------- |
| step      | card: step-type badge, title (mono), summary (muted, one line), status badge on the right      |
| decision  | card with a split icon, "If" / "If rows" label and the condition summary                       |
| fork      | thin bar; merge bar carries a small caption "All branches" / "First to finish"                 |
| loop      | dashed group box; header: repeat icon, "Loop", condition, "Continue on failure", "Iteration N" |
| start/end | small pills                                                                                    |
| unknown   | dashed card, "Unknown step" + id                                                               |

Runtime status styling (reuses the `WorkflowStatus` badge plus a border accent):

- completed → `border-brand`, failed → `border-destructive`, running → `border-warning` with
  `animate-pulse` on the status dot only, skipped / cancelled → `opacity-60` + dashed border,
  pending → default border.
- Edges into a node that has run (completed / running / failed) are solid; edges into
  pending / skipped nodes are muted and dashed; an edge into a running node is `animated`.
- In RACE, losing branches end up cancelled or skipped and so read as muted automatically —
  no RACE-specific logic.

Builder preview: no status styling; all nodes default border.

### Interaction and accessibility

- Click (or focus + Enter, xyflow `nodesFocusable`) on a step / decision / loop selects it;
  the selected node gets a `ring`. Clicking the pane clears the selection.
- Every node has an `aria-label` ("{type} step {title}, {status}").
- The List view remains the fully accessible alternative.

## 4. Integration

### Detail sheet (`WorkflowDetailSheet.tsx`)

- The "Steps" section gets a two-option toggle (Graph | List), Graph default, local state.
- Graph view: `WorkflowFlowDiagram` built from `treeToFlowGraph(stepTree)` (memoized on the
  tree, since the tree itself is already memoized). Below the canvas, the selected step's
  details: definition, result or error, metadata, skip reason. On first render nothing is
  selected; a hint reads "Select a step to see its details."
  - Convenience: if the instance failed and nothing is selected yet, preselect the first
    failed step so the error is visible immediately.
- The details body is extracted from `StepRow` into `WorkflowStepDetails.tsx`; both
  `WorkflowStepTree` and the graph view use it (no duplicated rendering).
- List view: unchanged `WorkflowStepTree`.

### Create sheet (`CreateWorkflowSheet.tsx`)

- Builder mode: a "Flow preview" collapsible placed after the step list and before
  "Preview SQL", **open by default**, height 320, with the Expand button. Driven by the
  `values` already obtained via `useWatch` (no new `watch()` calls).
- Expression mode: no diagram; a one-line note "Flow preview is available in builder mode."
- Re-run opens the sheet in expression mode, so it shows the note; this is accepted (the
  original run's diagram is in the detail sheet).

## 5. Files

| File                             | Purpose                                                      |
| -------------------------------- | ------------------------------------------------------------ |
| `Durable.flow.ts` (+ test)       | model types, `treeToFlowGraph`, `formToFlowGraph`, summaries |
| `Durable.flowLayout.ts` (+ test) | `layoutFlowGraph` (dagre, loop groups)                       |
| `WorkflowFlowDiagram.tsx`        | canvas, controls, expand dialog                              |
| `WorkflowFlowNodes.tsx`          | custom xyflow node components                                |
| `WorkflowStepDetails.tsx`        | step details body extracted from `StepRow`                   |
| `WorkflowStepTree.tsx`           | uses `WorkflowStepDetails`                                   |
| `WorkflowDetailSheet.tsx`        | Graph / List toggle, selection, preselect failed             |
| `CreateWorkflowSheet.tsx`        | flow preview section                                         |
| `lib/i18n/locales/zh-CN.json`    | new strings                                                  |

All under `apps/studio/components/interfaces/Integrations/Durable/` unless noted.

## 6. Cross-cutting

- Copy via the `copywriting` skill, wrapped in `$t(...)`, translated in `zh-CN.json`.
- Semantic tokens only; no hardcoded colors (the xyflow background dot color follows the
  existing `DiagramFlow` precedent).
- Named exports only; files kept focused (<300 lines each).
- `import '@xyflow/react/dist/style.css'` in `WorkflowFlowDiagram.tsx`, same as
  `DiagramFlow`.

## 7. Testing

Unit (vitest):

- `treeToFlowGraph`: sequence, JOIN with extra nodes, RACE merge mode, IF with and without
  else, IF_ROWS, LOOP with condition and nested body, nested containers, missing reference →
  `unknown`, status and iteration propagation, edge labels.
- `formToFlowGraph`: each leaf type summary, empty-field placeholders, top-level parallel,
  each container type, empty `else`.
- `layoutFlowGraph`: every node gets a position; loop children are relative to and inside
  their group; group size covers its children; top-to-bottom ordering of a sequence.

Component (existing test files, `customRender`):

- `WorkflowDetailSheet.test.tsx`: Graph is the default; toggling to List shows the tree;
  a failed instance preselects the failed step and shows its error.
- `CreateWorkflowSheet.test.tsx`: flow preview renders in builder mode and is replaced by the
  note in expression mode.
- jsdom: `ResizeObserver` is already polyfilled in `tests/setup/radix.js`. If xyflow still
  needs `DOMMatrixReadOnly` or element sizes, add a minimal polyfill in the test file, not
  globally.

Gates: `pnpm --filter studio typecheck`, `pnpm --filter studio run lint:ratchet`,
`pnpm knip --workspace apps/studio`, Durable vitest suite, `pnpm test:prettier`.

Verification gap (same as the 0.2.8 work): no live pg_durable 0.2.8 instance, so runtime
diagrams are verified with fixtures; the builder preview can be checked in a browser against
the local dev server.
