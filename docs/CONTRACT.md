# Implementation contract — `@shmming/dsh-deep-research` (DSH 0.2.1-rc.3 port)

This file is the frozen interface contract between the plugin implementation and the
verification harnesses. If the implementation changes a field here, update this file in the
same change.

## Runtime target

- DSH runtime: `0.2.1-rc.3` (`dsh --version`), installation at `/usr/lib/node_modules/@deepseek-ai/dsh/`.
- Current API used: `ctx.tools.register(defineTool(...))` from `@deepseek-ai/dsh-tools`, and
  `ctx.subagents.startActivation(...)` from `@deepseek-ai/dsh-subagent`.
- NOT used: `ctx.workflows` (old reference API), `ctx.workflowEngine` (current API, but the
  shipped `web` profile only mounts it inside agent-preset groups with
  `isolate: { workflowEngine: true }`, so a root plugin cannot inject it reliably).

## Module exports (`src/index.js`)

```js
export const name = 'dsh-deep-research'
export const inject = ['tools', 'subagents']
export const Config = /* schemastery schema, fields below */
export function apply(ctx, config) // registers exactly one tool
```

### Config (all optional)

| key | type | default | meaning |
|---|---|---|---|
| `childProvider` | string | `'spawn'` | subagent provider name for every child call |
| `maxParallel` | number | `4` | research children per round (positive integer) |
| `maxTotalAgents` | number | `32` | total child activations one tool call may start (positive integer) |
| `plannerModel` | string | – | model override for the planner child |
| `researcherModel` | string | – | model override for research children |
| `synthesizerModel` | string | – | model override for the synthesizer child |
| `reviewerModel` | string | – | model override for the reviewer child (defaults to `synthesizerModel`) |

`apply` validates the positive integers and throws `Error` messages prefixed
`dsh-deep-research:` before registering anything invalid.

## Tool: `deep_research`

Parameters (DSH schema DSL: `required: true` per property):

| param | type | required | meaning |
|---|---|---|---|
| `topic` | string | yes | research topic |
| `purpose` | string | no | decision/judgement the report must support (answer space) |
| `questions` | string | no | pre-existing question list, one per line (leading `1.`/`1、` markers stripped); when given the planner is skipped |
| `depth` | number | no (2) | 1 = preliminary (≤2 research rounds), 2 = deep (≤3), 3 = exhaustive (≤4) |
| `synthesize` | boolean | no (true) | write the final report with a synthesizer child; false = evidence only |
| `review` | boolean | no (false) | adversarial reviewer child (citation / coverage / contradiction audit) |

Output schema (object, `additionalProperties: false`):

| field | type | required |
|---|---|---|
| `ok` | boolean | yes |
| `report` | string | yes |
| `review` | string | no |
| `rounds` | number | no |
| `subquestions` | number | no |
| `completed` | number | no |
| `failed` | number | no |
| `skipped` | number | no |

`output.render(args, value)` returns `[{ type: 'text', text }]`; with `value.ok === true` the
text is `report` plus (when present) `\n\n` + `review`; otherwise a failure message containing
`deep_research`.

### Execution contract

`execute(args, exec)`:

1. Requires `exec.agent`; otherwise throws.
2. Validates `topic` (non-empty) and `depth` ∈ {1,2,3}; invalid input throws **before** any
   child activation starts.
3. Child activation helper (every model call goes through it):

```js
// startActivation is async — it resolves only after the child is published
// and cancellable (dsh-subagent: Promise<SubagentActivation>).
const activation = await ctx.subagents.startActivation({
  provider: config.childProvider,          // default 'spawn'
  label,                                   // see labels below
  delivery: 'caller',                      // no parent-facing completion notices
  signal: exec.signal,
  request: {
    prompt: [{ type: 'text', text: prompt }],
    parent: exec.agent,
    ...(schema ? { outputSchema: schema } : {}),
    ...(model ? { agentOptions: { model } } : {}),
  },
})
```

then awaits `activation.result` (never rejects on child-level failure), and always
`await activation.dispose()` in a `finally`. An abort of `exec.signal` after publication
disposes the activation and the tool call rejects with the abort reason.

Child labels (tests script on these + on prompt text):

| role | label |
|---|---|
| planner | `规划` |
| researcher | `研究·第<round>轮·<i>` (i is 1-based inside the round) |
| synthesizer | `综合` |
| reviewer | `审查` |

4. Orchestration:
   - Without `questions`: planner child with the object-rooted `PLANNER_SCHEMA`
     (`scope`, `dimensions`, `questions[{question,dimension,keywords?,acceptance?}]`,
     `coverage_gaps[]`). Planner failure (null / non-`completed` / no `structured`) throws.
   - Blind spots from `coverage_gaps` become extra research questions marked blind; they are
     queued after the planned questions and never silently dropped.
   - Adaptive research loop: at most `depth + 1` rounds; each round runs
     `min(maxParallel, remaining budget, pending)` questions concurrently; every
     high-priority (`priority: 'high'`) gap reported by a researcher is deduplicated and
     queued as a follow-up question for the next round. A round that yields no new
     high-priority gap ends the loop (marginal information gain ≈ 0).
   - `maxTotalAgents` is a hard cap over every activation (planner + research + synthesizer +
     reviewer). Research questions left unconsumed when the budget is gone are reported as
     `skipped` (never silent).
   - Researcher structured result (`RESEARCHER_SCHEMA`): `confirmed[{claim,source,confidence}]`,
     `uncertain[{point,reason?}]`, `gaps[{aspect,priority}]`.
   - Synthesis (when `synthesize !== false`): text child; failure falls back to the evidence
     report with a note. `review === true` adds a text review child; output `review` present.
   - Report structure: the evidence markdown starts with
     `# <topic> — 深度研究中间结果（证据状态）`, then per-question sections, then the
     synthesized report when available (plus an appendix of raw evidence).
     Concretely: when synthesis succeeds the report is
     `<synthesized text>\n\n---\n\n## 附录：原始证据状态\n\n<evidence markdown>` (so the
     evidence header lives inside the appendix); when synthesis is requested but fails, or is
     disabled, the report is the evidence markdown itself (plus a fallback note on failure).

5. Returned canonical value matches the output schema above; `completed + failed + skipped ===
   subquestions` for research questions.

## Test harness contract (`test/`)

- Unit tests import the real `defineTool` from the installation (see
  `test/helpers/link-deps.mjs`) so registration/schema compilation is checked against the
  actual 0.2.1-rc.3 package.
- A fake `ctx` provides `tools.register` and `subagents.startActivation`. Scripted activations
  are matched by label and/or prompt substring; each one records its request and returns
  `{ childId, result: Promise<{ stopReason, output, structured }>, dispose() }`.
- The fake also tracks concurrency (activations whose result has not settled) so tests assert
  `maxParallel` is respected, and disposal counts.
