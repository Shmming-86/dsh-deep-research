# Compatibility audit — `@shmming/dsh-deep-research` on DSH 0.2.1-rc.3

> Evidence paths: `_ref/` is a local, gitignored snapshot of the upstream project used for verification;
> `_verify/` holds local verification artifacts. Neither directory is committed to this repository.

Independent, evidence-backed audit of the port from the reference project
`_ref/dsh-deep-research-main/` (old `ctx.workflows` API) to the **currently installed**
DeepSeek Harness `0.2.1-rc.3`, plus a line-level review of
the repository's `src/index.js` against the installed `.d.ts` contracts.

- Audit task: `task-3` (shared task board).
- Runtime audited: `dsh --version` → `0.2.1-rc.3`; install at
  `/usr/lib/node_modules/@deepseek-ai/dsh/`.
- Source revisions reviewed (the Lead was writing concurrently, so the file was re-read
  between revisions and the line review below refers to the last one):
  - **rev A** (`src/index.js` 718 lines, mtime 2026-10-29 18:43:03,
    sha256 `329f0ae0bfc5a6937f01dac282e4059b6c2ebb62061450c5fd474ee515b985d3`) — BUG-1 present.
  - **rev B** (732 lines, 18:45:16, sha256 `92d5c3452543fffae70ba35107579a58f1efdf9c77a225f6c089959ee111c08e`)
    — BUG-1 fixed; re-verified.
  - **rev C** (734 lines, 18:46:37, sha256 `9354eddeb7217619ae1019e792008b7a2e131c1792f89592e02281a9f3939443`)
    — the main line-level review below (§2 row numbers refer to rev C; rev D adds one line).
  - **rev D (final, re-verified in §5)** (735 lines, 18:50:06,
    sha256 `d789c4b7c27ffc43ea832d4269b60b1fb4800837ff7c6fd84dab1e49f5461506`) — RISK-05
    hardening; no other byte changed.
- No model/API calls were made (no quota spent); the verifier's profile was only read.

## Verdict

| verdict | count | meaning |
|---|---|---|
| **BUG** | **1** | BUG-1 (critical, tool was unusable) — found in rev A, **fixed by the Lead in rev B**, re-verified in rev C. No open BUG in rev C. |
| **RISK** | **11** | Correct on the installed contracts today, but with a known limitation or a fragility worth a guard/doc line (see §3). **RISK-05 closed in rev D (§5); the remaining 10 are accepted documented limitations.** |
| **OK** | **36** | Verified against the installed d.ts / implementation / behaviour probes. |

The port's central design decision — orchestrate on `ctx.subagents.startActivation` instead of
the old `ctx.workflows` / current `ctx.workflowEngine` — is **correct and necessary**: the
shipped `web` profile disables the root `workflowEngine` provider and only mounts it inside
agent-preset groups with `isolate: { workflowEngine: true }` (§1.1). The output/parameter
schemas are legal in both schema dialects in use, and the returned canonical value validates
against the declared tool output schema.

---

## 1. API migration table (reference → installed 0.2.1-rc.3)

Notation: `$B = /usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai`.
Reference paths are under `_ref/dsh-deep-research-main/`.

### 1.1 Orchestration seam: `ctx.workflows` → `ctx.workflowEngine` → **chosen** `ctx.subagents`

| Concern | Reference (old API) | Installed 0.2.1-rc.3 contract | Port decision | Evidence |
|---|---|---|---|---|
| Service to run the pipeline | `inject = ['tools', 'workflows']` and `ctx.workflows.start({ script, meta, args, subagentProvider, maxTotalAgents, parent, signal })` | `ctx.workflowEngine` exists (`WorkflowEngine.start(request)`), request type renamed/reshaped: `script`, `meta`, `args?`, `subagentProvider?`, `maxTotalAgents?`, `parent`, `signal?` | **not used** — root-level plugins cannot resolve it in the shipped `web` profile | ref `src/index.ts:70` (`inject`), `:483-516` (`ctx.workflows.start`); current `$B/dsh-workflow/lib/types/index.d.ts:119` (`abstract start`), `$B/dsh-workflow/lib/types/runtime-types.d.ts:15-38` (`WorkflowStartRequest`), `:40-52` (`WorkflowRun`: `result` never rejects, `cancel`, `dispose`) |
| Why the workflow engine is unusable at the profile root | n/a (old API provided it at root) | `dsh-base` mounts `workflow-ptc` + `tool-workflow` at root, but the **`web` bundle disables both root rows**; the shipped `standard`, `cordis` and `ptc` presets each re-mount their own `workflow-ptc` inside a `delegation` group with `isolate: { workflowEngine: true }` (the `minimal` preset has no delegation group) | root plugin uses the subagent seam (provided at root) instead | mount: `$B/dsh-base/cordis.patch.yml:400-407`; root disable: `$B/dsh-web-app/cordis.patch.yml:572-576` (`- id: workflow-ptc` / `disabled: true`, `- id: tool-workflow` / `disabled: true`); preset isolation: `$B/dsh-web-app/presets/standard.patch.yml:86-87,104-105`, `presets/cordis.patch.yml:86,104`, `presets/ptc.patch.yml:87,105-106`; authoritative dump of the shipped `dr` (base+web-app) profile: `_ref/dr-dump.yml:312-319` (root `workflow-ptc`…`disabled: true`) and `_ref/dr-dump.yml:751-776` (preset `delegation` group `workflowEngine: true` + its own `workflow-ptc`). Re-confirmed in this audit: `DSH_HOME=/tmp/dshhome-audit dsh --profile web --dump-config` produced the same root-disabled/preset-isolated shape. |
| Chosen seam | — | `ctx.subagents.startActivation(spec): Promise<SubagentActivation>`; spec = `{ provider, label, childId?, request, signal, delivery }`; `request = Omit<SubagentStartRequest,'label'\|'signal'>`; activation = `{ childId, messageId?, result: Promise<SubagentResult>, dispose(): Promise<void> }` | one activation per model call; `delivery: 'caller'`; result never rejects on child-level failure | `$B/dsh-subagent/lib/types/index.d.ts:135-145`; `$B/dsh-subagent/lib/types/types.d.ts:25-51` (spec/activation), `:127-176` (`SubagentStartRequest`), `:237-263` (`SubagentResult`); **async in the implementation**: `$B/dsh-subagent/lib/index.js:3036` (`async startActivation`) — verified at runtime `SubagentRuntime.prototype.startActivation.constructor.name === 'AsyncFunction'` |
| Canonical in-tree usage of that seam | — | The workflow engine itself calls the seam exactly this way: `const run = await this.subagents.startActivation({ provider, label, delivery: 'caller', signal, request: { cwd, prompt, parent, outputSchema?, agentOptions? } })` | port mirrors this shape (minus explicit `cwd`, which is inherited from the parent) | `$B/dsh-workflow-ptc/lib/index.js:327-348` |
| Result/stop vocabulary | `run.result` → `{ stopReason: 'completed'\|'cancelled'\|'error', value, error?, agentsStarted }` | `SubagentResult` → `{ output: ContentBlock[], structured?: unknown, stopReason: 'completed'\|'aborted'\|'error'\|'max-tokens'\|'refusal', diagnostic? }` | `stopReason === 'completed' && (no schema \|\| structured !== undefined)` = usable child; otherwise `ok:false`; text flattened from `output` text blocks | ref `src/index.ts:518-536`; current `$B/dsh-subagent/lib/types/types.d.ts:237-263`, workflow `runtime-types.d.ts:44-52` |
| Dispose/cancel | `run.dispose()` after awaiting result; `signal` cancels the run | `activation.dispose()` idempotent (memoized close transaction); spec `signal` cancels before publication, and per `SubagentStartRequest.signal` doc is the canonical cancellation channel after it; `ToolRunContext.signal` required | `signal: exec.signal` on the spec + abort listener that calls one memoized `disposeOnce()`; `disposeOnce()` in `finally`; abort after publication rejects the tool call with the abort reason | `$B/dsh-subagent/lib/types/types.d.ts:34-36` (spec signal), `:150-152` (request signal), `:49-51` (activation dispose); idempotent close: `$B/dsh-subagent/lib/index.js:1703-1708` (`dispose` → memoized `close`); tool context: `$B/dsh-tools/lib/types/index.d.ts:305-320` (`ToolRunContext extends ToolExecution`, `signal`) |
| Workflow-script hooks (`agent`/`parallel`/`phase`/`log`, `agent()` options `{label, phase, schema, provider, model}`) | script executed by the engine; phases drive progress UI | no root workflow engine ⇒ no hooks at all. The seam has no phase/log/progress surface; `agent()`'s option whitelist maps to seam fields: `label`→`label`, `schema`→`outputSchema`, `model`→`agentOptions.model`, `provider`→`agentOptions.provider` | port replaces script hooks with a JS async loop (`runResearchRound`), `labels` for test observability, and `agentOptions.model` for tiering; no progress UI (see RISK-07) | `$B/dsh-workflow-ptc/lib/index.js:12` embedded guest source: `SUPPORTED_AGENT_OPTIONS = {label, phase, schema, provider, model}`; `$B/dsh-workflow/lib/types/index.d.ts` (`workflow/*` lifecycle events); seam mapping: `$B/dsh-subagent/lib/types/types.d.ts:154-166`; `AgentOptions`: `$B/dsh-agent/lib/types/runtime-types.d.ts:21-30` (`model?: string`, `provider?: string`, …) |

### 1.2 Module/plugin shape, package identity and loading

| Concern | Reference | Installed 0.2.1-rc.3 | Port | Evidence |
|---|---|---|---|---|
| Cordis package specifier | `cordis` (bare) in `peerDependencies` and `import type { Context } from 'cordis'` | package is **`@deepseek-ai/cordis` 4.0.5**; there is no bare `cordis` package installed | imports only `@deepseek-ai/schemastery` and `@deepseek-ai/dsh-tools`; no cordis import needed (plugin object literal) | ref `package.json:32-36` (peers incl. `cordis: ^4.0.0-rc.7`), `src/index.ts:63` (`from 'cordis'`); installed: `$B/cordis/package.json` version `4.0.5`, and `/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/cordis` does not exist |
| Plugin export shape | `export const name`, `export const inject`, `export interface Config`, `export function apply(ctx, config)` | Loader accepts the same ESM namespace shape and resolves `inject` as required-service readiness | same four exports (`export const Config = z.object(...)`) | `$B/cordis-plugin-loader/README.md:31-34` (`config` / `inject` columns); §2 F-02/F-03/F-04 |
| Entry point | TS source compiled to `./lib/types/index.js` (`main`/`exports` point there; `lib/tsconfig.tsbuildinfo` present) | plain ESM package (`type: module`) is the normal shape for shipped plugins | **plain ESM JS**, `main`/`exports` → `./src/index.js`; no build/tsx hook | ref `package.json:7-13`, `_ref/dsh-deep-research-main/lib/tsconfig.tsbuildinfo`; port `package.json:7-12`; loader imports the package entry as ordinary ESM |

### 1.3 Schema dialects (the most error-prone part of the port)

| Concern | Reference | Installed 0.2.1-rc.3 | Port | Evidence |
|---|---|---|---|---|
| `defineTool.parameters` dialect | per-property DSL (`required: true` on a property) | **author-facing DSL**: `ParameterSchemaSpec` = map of `ValueSchemaSpec & { required?: true }`; object nodes must declare `additionalProperties` explicitly; compiled to raw JSON Schema by `parameterSchemaSpecToJsonSchema` | `topic: { type:'string', required: true }`, others optional | `$B/dsh-tools/lib/types/schema.d.ts:178-198` (`DefineToolOptions`), `:56-110` (`ValueSchemaSpec`/`ParameterPropertySpec`); compiler: `$B/dsh-tools/lib/types/schema.js:79` (`required must be true when present`), `:159` (`additionalProperties must be explicitly true or false`), `:238` (parameters compiler) |
| `defineTool.output.schema` dialect | per-property `required: true`, `additionalProperties: false` | same DSL for output (`O extends ValueSchemaSpec`), compiled then checked by `assertSupportedJsonSchema` (any JSON root allowed, but object root here) | same DSL with per-property `required: true` | `$B/dsh-tools/lib/types/schema.d.ts:186-193`; `:228` (`valueSchemaSpecToJsonSchema`), `:296` (`outputSchema = valueSchemaSpecToJsonSchema(...)`); `$B/dsh-tools/lib/types/json-schema.d.ts:89` |
| Subagent `outputSchema` dialect | n/a (reference used workflow `schema` option) | **raw JSON Schema** in the enforced subset, applied with `assertObjectJsonSchema` at start: object root, keywords `type/oneOf/properties/required/additionalProperties/items/enum/const` (+ annotations), `required` must be **an array of strings**, `additionalProperties` **boolean**, `oneOf` exactly-one with at least two branches and no siblings, single `type` only | raw JSON Schema objects (`PLANNER_SCHEMA`, `RESEARCHER_SCHEMA`) with `required: [...]` arrays | `$B/dsh-subagent/lib/types/types.d.ts:160-166`; `$B/dsh-tools/lib/types/json-schema.d.ts:5-14` (module doc of the subset), `:96` (`assertObjectJsonSchema`); rules: `$B/dsh-tools/lib/index.js:155` (`required must be an array of strings`), `:160` (`additionalProperties must be a boolean`), `:175` (`… is not supported beside oneOf`), `:206` (allowed-keyword list), `:227` (`oneOf` ≥ 2) |
| Workflow `agent({schema})` dialect (reference only) | raw JSON Schema, object-rooted, checked by the engine | same raw subset (`assertObjectJsonSchema`) for `schema`/`outputSchema` consumers | not used; the port uses raw schemas for the seam and DSL only inside `defineTool` | `$B/dsh-workflow-ptc/lib/index.js:12` guest source (`readAgentOptions` → `assertObjectJsonSchema`) |
| Migration trap (verified) | — | A DSL fragment such as `{ type:'boolean', required:true }` is **rejected** by the raw-subset consumer (`unsupported JSON schema: schema.properties.ok.required is not supported on type "boolean"`), while it is required in the DSL | port keeps the two dialects separate; both legal (probes §4) | probe output in §4 |

### 1.4 Manifest, bundle patch and compatibility guarantees

| Concern | Reference | Installed 0.2.1-rc.3 | Port | Evidence |
|---|---|---|---|---|
| Profile wiring | `dsh.bundle.patch: ./cordis.patch.yml`, patch inserts `{ id: dsh-deep-research, name: '@shmming/dsh-deep-research' }` | a bundle's patch is applied when the profile lists the package in `dsh.profile.bundles`; patch rows are `insert` entries | identical wiring, root insert row (no preset-scoped row) | ref `package.json:41-45`, `cordis.patch.yml:6-8`; port `package.json:33-36`, `cordis.patch.yml:11-13`; profile field: `$B/dsh-app-boot/README.md:50`, example `_verify/home/profiles/dr/package.json (scratch profile)` |
| DSH compatibility declaration | no `engines.dsh`; `peerDependencies` on `@deepseek-ai/dsh-tools ^0.0.1`, `@deepseek-ai/dsh-workflow ^0.0.1`, `cordis ^4.0.0-rc.7` | when `engines.dsh` is declared, **that range alone decides and `peerDependencies` are ignored**; otherwise every `@deepseek-ai/dsh*` peer must match; prereleases participate; matching uses `semver.satisfies(..., { includePrerelease: true })` | `engines.dsh: ">=0.2.1-rc.2 <0.3.0"` ⇒ compatible with `0.2.1-rc.3` | `$B/dsh-app-boot/README.md:52`; `$B/dsh-app-boot/lib/types/plugin-compatibility.d.ts:3-28`; impl `$B/dsh-app-boot/lib/index.js:252-292` (`includePrerelease` at `:277`); evaluated in the audit: port ⇒ **COMPATIBLE**, reference ⇒ unmet `{"@deepseek-ai/dsh-tools":"^0.0.1","@deepseek-ai/dsh-workflow":"^0.0.1"}` |
| Consequence for the reference package | would have been skipped by the launcher as incompatible on 0.2.1-rc.3 | bundle resolution failure skips that bundle (`skippedBundles`) | port declares a satisfiable range and no unsatisfiable peers | `$B/dsh-app-boot/README.md:50`; probe §4 |

---

## 2. Line-level review of `src/index.js` (rev C, 734 lines, sha256 `9354edde…`)

**BUG-1 (critical, found → fixed → re-verified).**

- rev A `src/index.js:339` (line number in rev A) had
  `const activation = ctx.subagents.startActivation({ ... })` **without `await`**.
- Violated contract: `startActivation` returns `Promise<SubagentActivation>`
  (`$B/dsh-subagent/lib/types/index.d.ts:135,145`) and is `async startActivation(spec)`
  (`$B/dsh-subagent/lib/index.js:3036`); canonical usage awaits it
  (`$B/dsh-workflow-ptc/lib/index.js:330`).
- Reproduced in a no-quota scratch harness (real plugin loaded, scripted async seam):
  `activation.result`/`activation.dispose` were `undefined` → every child read as failed and
  the `finally` path threw `TypeError: activation.dispose is not a function` (the planner path
  would always throw “规划子代理未返回有效的结构化子问题”), and the published child was never
  disposed.
- **Fix applied by the Lead (rev B, present in rev C)**: line 343 is now
  `activation = await ctx.subagents.startActivation({ ... })`, plus a start-rejection mapping
  (`:356-360`), an abort-during-publication check (`:370-374`) and a memoized `disposeOnce()`
  (rev C `:362-365`; rev D `:362-366`). `docs/CONTRACT.md:82` pseudo-code was updated to show `await`.
- **Re-verified in rev C** with the same no-quota harness: happy path starts
  `规划 | 研究·第1轮·1 | 综合 | 审查`, disposes 4/4, output `ok:true` with
  `validateJsonSchemaValue(output.schema, value)` = 0 violations; cancel-mid-research rejects
  with the abort reason and disposes 2/2; abort-during-publication disposes 1/1; start
  rejection yields a clean error; 0 unhandled rejections (§4).

### 2.1 Findings

Legend: **OK** = verified correct against the installed contract; **RISK** = works today but a
known limitation/fragility; **BUG** = contract violation (none open).

| # | lines (rev C) | verdict | finding / evidence |
|---|---|---|---|
| F-01 | 63-64 | OK | Imports `z` from `@deepseek-ai/schemastery` and `defineTool` from `@deepseek-ai/dsh-tools`; both are exported by the installed packages and resolve from a profile/linked checkout (`$B/dsh-tools/lib/types/index.d.ts:25`; §4 probe). |
| F-02 | 67 | OK | `export const name = 'dsh-deep-research'` — unique loader/plugin name. |
| F-03 | 73 | OK | `inject = ['tools','subagents']` matches the Context augmentations (`$B/dsh-tools/lib/types/index.d.ts` `Context.tools`; `$B/dsh-subagent/lib/types/index.d.ts` `Context.subagents`). Both are root rows of `dsh-base` — `subagent` + `spawn`/`fork` providers and `tools` (`$B/dsh-base/cordis.patch.yml:359-370,499`) — and the `web` bundle disables only the root delegation *tools* (`tool-subagent*`), not the service/providers or `tools` (`_ref/dr-dump.yml:279-290`: subagent+providers enabled; `:386-390`: tools enabled). The `headless` bundle likewise only restates the `tools` config. So `inject` is satisfiable at the root of both shipped compositions. |
| F-04 | 76-91, 268-294 | OK | `Config` is a valid schemastery object; `apply` re-validates (positive integers, non-empty model strings, `reviewerModel ?? synthesizerModel`), each error prefixed `dsh-deep-research:`; defaults match `docs/CONTRACT.md` (4/32). Verified `{maxParallel:0}`, `{maxTotalAgents:-1}`, `{maxParallel:2.5}`, `{maxTotalAgents:1}` all throw (§4). |
| F-05 | 186-260 | OK | `apply` registers exactly one tool via `ctx.tools.register(defineTool(...))`; ignoring the returned disposer matches shipped first-party plugins (`$B/dsh-tool-web/lib/index.js:261`) and `ToolRuntime.register` uses `layers.effect` (`$B/dsh-tools/lib/index.js:2982`). `ctx.logger?.info?.` is safe (`$B/cordis/lib/types/context.d.ts:27`). |
| F-06 | 98-121 | OK | `PLANNER_SCHEMA` is legal raw JSON Schema for the subagent subset (object root, `required` arrays of strings, `additionalProperties` booleans); `assertObjectJsonSchema` accepts it (§4). |
| F-07 | 128-171 | OK | `RESEARCHER_SCHEMA` likewise legal (`enum` on scalar types only; nested object `additionalProperties:false` + `required` arrays) — `assertObjectJsonSchema` accepts it (§4). |
| F-08 | 202-228 | OK | `parameters` uses the DSL correctly: `required: true` per property; compiles to `{type:'object', properties:{…}, required:['topic']}` with the installed `defineTool` (§4). |
| F-09 | 229-249 | OK | `output.schema` uses the DSL correctly: object root, `additionalProperties:false`, per-property `required:true` → compiled raw schema has `required:['ok','report']`; `assertSupportedJsonSchema` passes (§4). |
| F-10 | 244-249 | OK | `render` projects `report` (+`review`) and prefixes failures with `deep_research`; matches `docs/CONTRACT.md:66-68`. (The `ok:false` branch is unreachable in practice — see RISK-10.) |
| F-11 | 343-355 | OK | `startActivation` request shape matches the installed spec exactly: top-level `provider`/`label`/`signal`/`delivery`, and `request` omitting only `label`/`signal` (`prompt: ContentBlock[]`, `parent`, optional `outputSchema`, optional `agentOptions`) — same shape as `$B/dsh-workflow-ptc/lib/index.js:327-348`. |
| F-12 | 343 | OK | `await` present (BUG-1 fix); confirmed against the async signature (§2 BUG-1). |
| F-13 | 349 | OK | `agentOptions: { model }` is legal: `AgentOptions.model?: string` (`$B/dsh-agent/lib/types/runtime-types.d.ts:21-30`); the in-process `spawn` provider advertises `agentOptions: true` (`$B/dsh-subagent-spawn-in-process/lib/index.js:21-26`) and merges the override over the parent route (`$B/dsh-subagent/lib/index.js:315-331`). |
| F-14 | 305-308, 346 | OK | `exec.agent` is required (throws otherwise) and passed as `request.parent`; the seam additionally verifies the exact live parent (`$B/dsh-subagent/lib/index.js:3045`); `ToolRunContext.agent?` is registry-supplied (`$B/dsh-tools/lib/types/index.d.ts:305-320`). |
| F-15 | 356-360 | OK | Start rejection maps to the abort reason when the signal aborted, else a labelled `deep_research: 子代理启动失败(…)` error; behaviour verified (§4 [D]). |
| F-16 | 362-366 | OK | `disposeOnce` memoizes the dispose promise → exactly one `dispose()` call per activation; idempotent seam disposal confirmed (`$B/dsh-subagent/lib/index.js:1703-1708`); verified 4/4 disposals in the happy path; rev D adds the deferred-call hardening (§5). |
| F-17 | 367-374 | OK | Abort listener + post-publication aborted check closes the “aborted between publish and listener registration” window (an already-aborted signal never fires `abort`); verified 1/1 disposal and rejection (§4 [C]). |
| F-18 | 377-381 | OK | `activation.result` rejection is contained: non-abort → per-child `{ok:false}` (run continues; verified [E]); abort → abort reason. Matches the seam doc that result may reject on capture failure (`$B/dsh-subagent/lib/types/types.d.ts:44-49`). |
| F-19 | 396-400 | OK | `finally` removes the listener, awaits the memoized dispose, then re-raises the abort reason; every path disposes; no unhandled rejections in probes. |
| F-20 | 320-333 | OK | Budget layout reserves synthesis/review before research (`researchBudget`), and a too-small `maxTotalAgents` throws before any activation; verified 5 questions + `maxTotalAgents:3` → 2 researched + 3 skipped (§4 [2]). |
| F-21 | 336-338 | OK | Budget check + synchronous `state.started += 1` before the await makes the cap race-free under the concurrent round workers; verified `maxLive` never exceeds `maxParallel`. |
| F-22 | 442-479 | OK | Adaptive loop: `maxRounds = depth + 1`; high-priority gaps deduped through `queued` and appended to `pending`; loop ends on empty `pending`/round cap/budget. Matches `docs/CONTRACT.md:113-118`. |
| F-23 | 437-438, 466-477 | OK | Blind planner gaps become `{ question, dimension:'盲区侦察', blind:true }` queued after planned questions; follow-ups deduped and never silently dropped (contract §4). |
| F-24 | 483-494 | OK | Evidence aggregation dedupes by question, counts `completed`/`failed`/`skipped`; verified invariant `completed + failed + skipped === subquestions` (§4). |
| F-25 | 486-504 | OK | Skipped questions are reported in the evidence and in the summary header — never silent (contract §4). |
| F-26 | 511-529 | OK | Synthesis uses a text child; failure or empty output falls back to the evidence report with a note (contract §4). |
| F-27 | 531-544 | OK | Opt-in review child; `minimumBudget` guarantees budget for it whenever `review:true`, so “output review present” holds. |
| F-28 | 567-599 | OK | Bounded concurrency worker pool: width is `min(maxParallel, remainingBudget, pending)`; a failure sets the stop flag, survivors settle via `allSettled`, and each child is disposed in `runChild`'s `finally`. Verified `maxLive=2` with `maxParallel=2` (§4 [1]). |
| F-29 | 547-556 | OK | Returned canonical value has exactly the declared fields and types; validated against the compiled output schema with 0 violations (§4). |
| F-30 | 305-318 | OK | Topic non-empty and `depth ∈ {1,2,3}` are validated before any activation; also the too-small-budget check precedes children. |
| F-31 | 256-259 | OK | Startup log uses the optional callable logger service; no failure if a logger is absent. |
| F-32 | 709-716, 719-726, 729-734 | OK | Question-list parsing strips `1.`/`1、`/`(1)`/`-`/`*`/`•` markers; `positiveInt` and `abortReason` are total for their inputs. |
| F-33 | 7-13 (module doc), all code | OK | No reference-era API left in executable code: `ctx.workflows` appears only in the explanatory comment (`:7`); no `ctx.workflowEngine` call, no bare `cordis` import, no `^0.0.1` peer, no workflow script/`meta`; `cordis.patch.yml` is a plain root insert row. |
| F-34 | `package.json:13-14, 27-32`, `cordis.patch.yml` | OK | `engines.dsh` range satisfies the installed runtime; dsh peers are lower-bounded consistently with it; manifest is **COMPATIBLE** per `evaluatePluginCompatibility` (§4) and the bundle patch is declared via `dsh.bundle.patch`. |
| F-35 | 440, 461 | OK | `results` Map is written but never read (dead code, no behavioural effect) — harmless; could be removed for clarity. |
| F-36 | `docs/CONTRACT.md:80-84` | OK | The contract pseudo-code was updated to `await ctx.subagents.startActivation(...)`, so contract and implementation agree on the async seam. |

**Line-review counts: OK = 36 (rows F-01…F-36), BUG = 1 (BUG-1, found → fixed → re-verified, row F-12), and 11 RISKs listed in §3 — each row there names the `src/index.js` lines it applies to, because a residual risk is not a contract violation in this revision.**

---

## 3. Residual risks / known limitations

| # | risk | evidence | mitigation / what would break |
|---|---|---|---|
| RISK-01 | **No delegation-depth cap.** The port never sets `request.maxDepth`; the seam only enforces a cap when the request provides one (`$B/dsh-subagent/lib/index.js:1399 resolveChildDepth(parent, request.maxDepth)`), and `SubagentRuntime.Config.maxDepth` is applied by delegation *tools* via `resolveMaxDepth`, not by direct seam consumers. Children therefore may spawn grandchildren. | `src/index.js:343-355`; `$B/dsh-subagent/lib/index.js:1399,3023`; canonical workflow host also omits it (`$B/dsh-workflow-ptc/lib/index.js:327-348`) | If nesting must be forbidden, pass `maxDepth` (e.g. parent depth + 1 via the exported `delegationDepthOf`) — note the seam then rejects at depth. |
| RISK-02 | **Recursive use of the tool.** It is registered globally at the root (`ctx.tools.register`, F-05), so research children inherit the `deep_research` tool; combined with RISK-01 a child can recursively fan out until the live-child capacity is hit. | `src/index.js:189`; `$B/dsh-tools/lib/index.d.ts` visibility model (global layer inherited by scopes) | Restrict the tool per child scope (`ctx.tools.restrict`) or set `maxDepth`; prompts already tell children to use only `web_search`/`web_fetch`, which is advisory only. |
| RISK-03 | **`maxParallel` is not clamped to `maxActiveSubagents`** (default **8**), and `ActivationPool.reserve` **throws** `ACTIVATION_LIMIT_REACHED` when exceeded. A profile setting `maxParallel > 8` therefore turns a round into a whole-call failure. | `src/index.js:80-82, 451`; `$B/dsh-subagent/lib/index.js:2980` (`maxActiveSubagents … default(8)`), `lib/index.js` `ActivationPool.reserve` throw | Keep `maxParallel ≤ 8` (or raise the subagent service config). Could also catch `ACTIVATION_LIMIT_REACHED` per child and mark it failed/skipped. |
| RISK-04 | **Infrastructure start failures abort the whole run.** Only the planner translates `BudgetExceeded`; research/synthesis/review start errors (e.g. `ACTIVATION_LIMIT_REACHED`, `UNSUPPORTED_CAPABILITY`, unknown provider) rethrow and fail the tool call instead of degrading to `failed`/`skipped`. | `src/index.js:356-360, 402-407, 454, 516, 534`; seam error codes `$B/dsh-subagent/lib/types/error.d.ts` (`SubagentError` codes) | Classify `SubagentError.code` and degrade per child; today a misconfigured `childProvider` fails loudly with a clear message, which is acceptable but brittle. |
| RISK-05 | **`disposeOnce` could mask the outcome on a synchronous dispose throw.** `Promise.resolve(activation.dispose())` evaluated the call first, so a synchronous throw escaped `disposeOnce` and the `finally` rethrow could replace the original result/error. **Closed in rev D (§5):** the call is deferred to a microtask (`Promise.resolve().then(() => activation.dispose())`), so a sync throw becomes a rejected promise contained by `.catch`; `disposePromise ??=` still keeps exactly one dispose per activation. | rev C `src/index.js:362-365`; rev D `:363-364, 398`; seam dispose memoization `$B/dsh-subagent/lib/index.js:1703-1708` | Fixed; regression shows rev C rejects `sync-dispose-boom` after 1 dispose while rev D resolves normally with 4/4 dispose attempts contained (§5). |
| RISK-06 | **Model tiering bypasses the session's subagent route policy.** `agentOptions.model` goes straight to the seam; the model-facing `dsh-tool-subagent` route allow-list/`modelSelectionSettings` path is not consulted, and no provider override is offered. A bad model id fails child creation (and aborts the run, RISK-04). Changing model also drops the inherited `reasoningEffort` (the seam clears route-owned effort when the route changes). | `src/index.js:349`; `$B/dsh-subagent/lib/index.js:315-331` (`resolveChildAgentOptions`, effort clearing at `:329`); `$B/dsh-tool-subagent/lib/index.js` model-route policy | Document that model names must be valid provider model ids; optionally validate via `ctx.llm` before starting children. |
| RISK-07 | **Unbounded output size / no cooperative timeout.** `report` = synth text + the full evidence appendix; the tool declares no `timeoutMs`, so cancellation is cooperative only and a single call can produce a very large model-facing result. | `src/index.js:506-529, 189-254`; `ToolDefinition.timeoutMs` doc `$B/dsh-tools/lib/types/index.d.ts` (“Cooperative tool-call timeout budget… NEVER sent to the model”) | Cap the appendix (e.g. per-question truncation) and/or declare `timeoutMs` plus signal-aware quiescence. |
| RISK-08 | **Parity loss vs the workflow engine.** The port runs orchestration in-plugin (no confined workflow guest / process isolation, no `phase()`/`log()` progress events, no workflow-run UI node, no `workflow/*` telemetry); the reference delegated that to `dsh-workflow-ptc`, whose PTC layer owns process confinement and cancellation. Child subagent lifecycle events still fire (`subagent/start\|end`), but there is no phase progress. | module doc `src/index.js:7-13`; `$B/dsh-workflow-ptc/lib/index.js:12` guest source (VM/PTC ownership); `$B/dsh-workflow/lib/types/index.d.ts` (`workflow/*` events) | Acceptable product trade-off; document the missing progress UI. A future DSH could expose the engine at root or a scoped service — then the port could be revisited. |
| RISK-09 | **`engines.dsh` upper bound admits future `0.3.0-rc.*`.** app-boot matches with `includePrerelease: true`, so `>=0.2.1-rc.2 <0.3.0` accepts `0.3.0-rc.1` (verified with the installed semver), which may carry breaking API changes. | `package.json:14`; `$B/dsh-app-boot/lib/index.js:277`; semver probe §4 | If a hard 0.2.x gate is intended, use `>=0.2.1-rc.2 <0.3.0-0`. |
| RISK-10 | **Dead render branch.** `runDeepResearch` always returns `ok:true` (every failure throws), so `output.render`'s `ok === false` failure projection is unreachable; the model sees registry-rendered thrown-error text instead. This matches the reference behaviour but makes that part of the contract untested. | `src/index.js:244-249, 547-556`; `docs/CONTRACT.md:66-68` | Either keep as-is (documented) or return a canonical `{ok:false, report:<reason>}` for expected failures. |
| RISK-11 | **Deployment: linked-checkout peer resolution + packaging nit.** The package declares no `dependencies`; its bare imports must resolve from the plugin location (the checkout uses `test/helpers/link-deps.mjs` to symlink the installation’s packages). `package.json`’s `files` lists `README.md`/`LICENSE`, which do not exist in the tree. | `package.json:16-26`; `scripts`/`test/helpers/link-deps.mjs`; repo listing | In a DSH profile the plugin must be installed under the profile’s `node_modules` graph (or linked with peers resolvable); add README/LICENSE or drop them from `files` before any publish. |

Additional non-risk notes: `questions` input is unbounded in length (only `depth+1` rounds ×
`maxParallel` questions are researched, the rest are reported `skipped`, which matches the
contract); `ctx.tools.register`’s disposer is intentionally ignored, like shipped plugins
(plugin unload relies on the framework’s effect scope, not on this file).

---

## 4. How this was verified (commands, no API quota)

All checks were static or in-process. **No LLM/API request was made.** Scratch harnesses were
created under `/tmp` (ephemeral), the DSH installation and the verifier’s profile were read only.

```bash
# 0. Runtime + file under review
dsh --version                                   # 0.2.1-rc.3
sha256sum src/index.js                          # 9354edde… (rev C, 734 lines)
node --check src/index.js                       # SYNTAX_OK

# 1. Contract inspection (installed .d.ts / implementations / composition YAML)
grep -n "startActivation(spec" $B/dsh-subagent/lib/types/index.d.ts            # :135, :145
grep -n "async startActivation(spec)" $B/dsh-subagent/lib/index.js             # :3036
grep -n "await this.subagents.startActivation" $B/dsh-workflow-ptc/lib/index.js # :330 (canonical usage)
grep -n "interface SubagentActivationSpec\|interface SubagentStartRequest\|interface SubagentResult" \
  $B/dsh-subagent/lib/types/types.d.ts                                         # :25, :127, :237
grep -n "interface AgentOptions" -A10 $B/dsh-agent/lib/types/runtime-types.d.ts # model?: string
grep -n "assertObjectJsonSchema\|assertSupportedJsonSchema" \
  $B/dsh-tools/lib/types/json-schema.d.ts                                      # :96, :89
grep -n "required must be an array of strings\|additionalProperties must be a boolean" \
  $B/dsh-tools/lib/index.js                                                    # :155, :160
grep -n "valueSchemaSpecToJsonSchema\|parameterSchemaSpecToJsonSchema\|outputSchema =" \
  $B/dsh-tools/lib/types/schema.js                                             # :228, :238, :296
grep -n "id: workflow-ptc\|id: tool-workflow" $B/dsh-base/cordis.patch.yml     # :400, :405
sed -n '572,576p' $B/dsh-web-app/cordis.patch.yml                              # root rows disabled:true
grep -n "workflowEngine: true" $B/dsh-web-app/presets/*.patch.yml              # standard:87, cordis:86, ptc:87
sed -n '312,319p;751,776p' _ref/dr-dump.yml                                    # root disabled / preset isolated
grep -n "includePrerelease" $B/dsh-app-boot/lib/index.js                       # :277

# 2. Scratch cross-check of the shipped profile composition (fresh DSH_HOME in /tmp)
DSH_HOME=/tmp/dshhome-audit dsh --profile web --dump-config   # root workflow-ptc disabled:true; presets isolate

# 3. No-quota probes (real installed packages, /tmp scratch dir with a node_modules symlink)
#    a) schema legality: defineTool compiles the plugin's parameters/output exactly;
#       assertObjectJsonSchema accepts PLANNER/RESEARCHER; a DSL-style required:true is rejected
#       by the raw subset. Result:
#         defineTool OK; compiled output.schema required=['ok','report'];
#         PLANNER_SCHEMA OK; RESEARCHER_SCHEMA OK;
#         DSL-style raw schema rejected: "...schema.properties.ok.required is not supported on type \"boolean\""
#    b) startActivation asyncness: SubagentRuntime.prototype.startActivation.constructor.name == 'AsyncFunction'
#    c) manifest compatibility: evaluatePluginCompatibility(port) === undefined (COMPATIBLE);
#       evaluatePluginCompatibility(reference) === {requirements:{"@deepseek-ai/dsh-tools":"^0.0.1",
#       "@deepseek-ai/dsh-workflow":"^0.0.1"}}
#    d) semver boundary: 0.2.1-rc.3/0.2.2-rc.1/0.3.0-rc.1 satisfy ">=0.2.1-rc.2 <0.3.0"
#       with includePrerelease; 0.3.0 does not.
#    e) full plugin harness: load the real src/index.js, register it on a fake ctx with
#       `async startActivation` (+publication latency), then run tool.execute:
#         [A] happy path (review:true): labels 规划|研究·第1轮·1|综合|审查, disposals 4/4, live 0,
#             ok:true, output schema violations 0, review appended
#         [B] cancel mid-research: rejects with 'user-cancelled', disposals 2/2, live 0
#         [C] abort during publication: rejects with 'during-publish', disposals 1/1
#         [D] start rejection: "deep_research: 子代理启动失败（研究·第1轮·1）：Error: provider exploded"
#         [E] child result rejection: run continues, failed 1, failure note in report
#         [F] schema requested but no structured result: child counted failed
#         unhandledRejections: 0
#         concurrency/budget: 5 questions, maxParallel=2 → maxLive 2 (never >2);
#           maxTotalAgents=3 with synthesize → 2 researched + 3 skipped = 5 = subquestions;
#           completed+failed+skipped === subquestions
#         config: maxParallel 0 / maxTotalAgents -1 / maxParallel 2.5 / maxTotalAgents 1 all throw
```

Bug found/fix history for the record: BUG-1 was found in rev A
(`329f0ae0…`, line 339), reported to the Lead with the failing contract and a one-line fix, fixed
in rev B (`92d5c345…`, line 343 `await`), and re-verified in rev C (`9354edde…`) with the harness
above.

---

## 5. Rev D re-verification (final revision audited)

- **File audited:** `src/index.js` **735 lines**, mtime 2026-10-29 18:50:06,
  sha256 `d789c4b7c27ffc43ea832d4269b60b1fb4800837ff7c6fd84dab1e49f5461506`.
- **Delta vs rev C:** exactly one behavioural line plus its comment, in `runChild`'s
  `disposeOnce` (`:362-366`):
  `Promise.resolve(activation.dispose())` → `Promise.resolve().then(() => activation.dispose())`,
  with the comment `// Defer the call so a synchronous throw from dispose() cannot mask the outcome.`
- **Byte-exact delta proof:** reversing exactly that edit in a scratch copy of rev D reproduces
  sha256 `9354eddeb7217619ae1019e792008b7a2e131c1792f89592e02281a9f3939443` — the reviewed rev C —
  so **no other byte changed** between rev C and rev D.
- **Correctness / idempotency:** the deferred call converts a synchronous `dispose()` throw into a
  rejected promise that `.catch(() => {})` contains, so it can neither escape `disposeOnce` nor
  mask the run outcome in `finally` (`:398`). `disposePromise ??=` still memoizes one dispose per
  activation, and the seam's `dispose()` is itself a memoized close transaction
  (`$B/dsh-subagent/lib/index.js:1703-1708`), so exactly-once disposal is preserved.
- **Behavioural re-verification** (no quota; real plugin + scripted async seam, fresh `/tmp`
  scratch):
  - sync-throwing `dispose()`: **rev C** rejects `sync-dispose-boom` after 1 dispose (the old
    latent masking, now demonstrated); **rev D** resolves `ok:true`, 4/4 dispose attempts
    contained, 0 output-schema violations → **RISK-05 closed**.
  - happy path with `review:true`: labels `规划|研究·第1轮·1|综合|审查`, disposals 4/4, `ok:true`,
    0 output-schema violations.
  - cancel mid-research: rejects with the abort reason, 2/2 in-flight children disposed, no leak.
  - abort during publication: rejects with the abort reason, 1/1 disposed.
  - 0 unhandled rejections in every scenario; the Lead's unit suite passes 20/20 after the change.
- **Verdict unchanged: OK 36, RISK 11 (RISK-05 closed), BUG 1 (closed).** The remaining 10 RISKs
  are accepted documented limitations for this port. This is the final revision audited; if
  `src/index.js` changes again, re-run §4.

---

## 6. Formalized packaging conformance (`@shmming/dsh-deep-research`)

Scope: the project was formalized as a standard, publishable DSH plugin and renamed to
`@shmming/dsh-deep-research` (author `shmming`, repo `https://github.com/Shmming-86/dsh-deep-research`).
This section audits the manifest, locale, icon, type declarations, README/CHANGELOG/License provenance
and publish surface against the **installed DSH 0.2.1-rc.3** conventions. Prior sections (§1–§5) are
left untouched; this section is additive and has its own counts.

**Source identity — computed in this audit, not taken from a report.** `src/index.js` is **735 lines**,
sha256 `bc29cbb15381c73d19103ec0ee5c5c2fd8306454a8433543b5a0001272ac63ae`
(mtime 2026-10-29 19:05:24), `node --check` OK. Reverting the package-rename line in memory
(` * @module @shmming/dsh-deep-research` → ` * @module @dsh-external/dsh-deep-research`) reproduces
sha256 `d789c4b7c27ffc43ea832d4269b60b1fb4800837ff7c6fd84dab1e49f5461506` — the audited rev D — with
**exactly 1 differing line**. So: **code semantically unchanged vs audited rev D; only the `@module`
doc tag differs.** (The §5 note records rev D as the last logic revision; all §2/§5 findings stand.)

**Evidence base.** `$B = /usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai`; all checks
were static/read-only (no API quota). The Lead's official-reader result (`readPluginMeta` →
title en/zh + descriptions + `data:image/svg+xml;base64,` icon) and the `npm pack --dry-run` publish
surface are reused as context as instructed and were not re-run here; everything else below was
re-checked directly against the installed packages/reference tree.

### 6.1 Manifest / packaging field conformance

Legend as in §2. Evidence column: `P:` = current `package.json`; `Types:` =
`$B/dsh-package-manifest/lib/types/types.d.ts`; `Boot:` = `$B/dsh-app-boot/lib/index.js`;
`PM README` = `$B/dsh-plugin-manager/README.md`.

| # | field | value (current file:line) | authoritative evidence | verdict |
|---|---|---|---|---|
| F-P01 | `name` | `@shmming/dsh-deep-research` (P:2) | scoped npm name; DSH resolves bundles by package name (`Boot` manifest readers, `Types:7-9`) | **OK** |
| F-P02 | `version` | `0.2.0` (P:3) | matches `CHANGELOG.md:7` and README "This version 0.2.0"; npm semver | **OK** |
| F-P03 | `description` | provenance text incl. "Ported from @dsh-external/…" (P:4) | reader falls back to it for display (`Boot:2216-2230`); provenance mention is accurate | **OK** |
| F-P04 | `keywords` | 10 keywords (P:5-16) | discovery-only; `workflow` is legacy context (plugin no longer uses the workflow engine) but harmless | **OK** (note) |
| F-P05 | `author` | `shmming` (P:17) | string form is valid npm `person`; matches requested author | **OK** |
| F-P06 | `license` | `MIT` (P:18) | SPDX id; upstream is MIT (`_ref/package.json:31`) | **OK** |
| F-P07 | `repository` | `{type:git,url:git+https://github.com/Shmming-86/dsh-deep-research.git}` (P:19-22) | valid npm form; matches requested repo (see P-P07) | **OK** |
| F-P08 | `bugs` | `https://github.com/Shmming-86/dsh-deep-research/issues` (P:23-25) | matches repository host | **OK** |
| F-P09 | `homepage` | `https://github.com/Shmming-86/dsh-deep-research#readme` (P:26) | matches publishable package | **OK** |
| F-P10 | `private` absent | not present | publishable package; upstream's `private: true` was dropped | **OK** |
| F-P11 | `type` | `module` (P:27) | plain-ESM plugin; loader imports it as ESM | **OK** |
| F-P12 | `main` | `./src/index.js` (P:29) | legacy-resolver fallback; matches §1.2 architecture | **OK** |
| F-P13 | `types` | `./types/index.d.ts` (P:30) | file exists; not consumed by the DSH loader | **OK** |
| F-P14 | `exports["."]` | `types` + `default` (P:31-35) | shipped convention (`$B/dsh-tool-workflow/package.json` exports), Node ESM resolver | **OK** |
| F-P15 | `exports["./cordis.patch.yml"]` | `./cordis.patch.yml` (P:36) | shipped convention (`$B/dsh-experimental-plugin-market-bundle/package.json` exports) | **OK** |
| F-P16 | `exports["./icon"]` | `./assets/icon.svg` (P:37) | optional icon resource; manifest `icon` takes priority (`Boot:2085-2126`) | **OK** |
| F-P17 | `exports["./locale/*.json"]` | `./locale/*.json` (P:38) | **required** for `readPluginMeta` to resolve `<pkg>/locale/en.json` (`Boot:2168-2199`); same pattern as shipped packages | **OK** |
| F-P18 | `exports["./package.json"]` | `./package.json` (P:39) | shipped convention; lets readers resolve the manifest | **OK** |
| F-P19 | `files` whitelist | `src,types,assets,locale,cordis.patch.yml,README.md,README.zh.md,CHANGELOG.md,LICENSE,docs` (P:41-52) | matches `npm pack --dry-run` surface (Lead's check 7); excludes `test/`, `scripts/`, `_ref/`, `_verify/`, `_testhome/`, `node_modules/` (`.gitignore`) | **OK** (docs publication is assessed as D-P03) |
| F-P20 | `icon` | `./assets/icon.svg` (P:28) | relative path inside the manifest directory; SVG; **758 bytes** < 256 KiB; XML valid — all rules in `Types:14` and `Boot:2085-2126` | **OK** |
| F-P21 | `engines.node` | `^22.19.0 \|\| >=24.0.0` (P:54) | inherited from upstream (`_ref/package.json:16-18`); tested runtime Node v24.20.0; the DSH CLI itself declares no `engines.node`; npm-advisory only (plugin-manager only enforces the DSH requirement, PM README:69) | **OK** |
| F-P22 | `engines.dsh` | `>=0.2.1-rc.2 <0.3.0` (P:55) | runtime `0.2.1-rc.3` satisfies; app-boot matches with `includePrerelease:true` (`Boot:276-292`, `:277`), so `0.3.0-rc.*` would also pass — cross-ref §3 RISK-09 | **RISK** |
| F-P23 | `peerDependencies` | coral `@deepseek-ai/cordis ~4.0.5`, `dsh-subagent`/`dsh-tools` `>=0.2.1-rc.2 <0.3.0`, `schemastery ^3.18.0` (P:62-67) | installed: cordis 4.0.5, subagent/tools 0.2.1-rc.3, schemastery 3.18.5 — all satisfied; app-boot ignores peers when `engines.dsh` exists (`README:52`); plugin-manager checks peers/engines on install (PM README:69) | **OK** |
| F-P24 | `publishConfig.access` | `public` (P:68-70) | required for scoped npm packages; shipped packages use it | **OK** |
| F-P25 | install specs in README | `dsh plugin --profile <profile> add git+https://…git` and `add link:/path` (README.md:66-73) | both are supported profile-dependency spec forms (PM README:44, `:50`); same form as upstream (`_ref/README.md:51`) | **OK** |
| F-P26 | install-time compatibility | package declares `engines.dsh` satisfied by rc.3 | plugin-manager rejects unmet DSH requirements (pre-check for paths/registry, post-install rollback for git) (PM README:69); ours is met | **OK** |
| F-P27 | `dsh.manifestVersion` | `1` (P:72) | `Types:30` (`manifestVersion?: 1`) and README:46-53 | **OK** |
| F-P28 | `dsh.bundle.patch` | `./cordis.patch.yml` (P:73-75) | `Types:66-69`; `files` ships the patch; plugin-manager treats a bundle without a patch as not-a-bundle (PM README:48,60) | **OK** |
| F-P29 | patch composition row | `{ id: dsh-deep-research, name: '@shmming/dsh-deep-research' }` (`cordis.patch.yml:11-13`) | row `name` equals the package name; `id` is the stable override handle documented in README:103-109; verified loaded at boot (verifier) | **OK** |
| F-P30 | `locale/en.json` | `{"meta":{"title":"Deep Research","description":"…"}}` (locale/en.json:1-6) | exact display-metadata shape of shipped reference `$B/dsh-experimental-plugin-market-bundle/locale/en.json`; `dictionariesOf` accepts `meta.title`/`meta.description` non-empty strings (`Boot:2168-2199`) | **OK** |
| F-P31 | `locale/zh.json` + fallback | `{"meta":{"title":"深度研究","description":"…"}}` (locale/zh.json:1-6) | filename `zh` and `en` are valid language ids (`Boot:2075`); both files share the English locale directory (required); `localizedText` always sets the `en` fallback, so missing fields can never render blank (`Boot:2168-2199`) | **OK** |
| F-P32 | icon resolution | manifest `icon` wins over `./icon`; returns `data:image/svg+xml;base64,…` | rules: relative path only, inside the manifest dir after realpath, extension SVG/PNG/JPEG/WebP, regular file, ≤256 KiB (`Boot:2085-2126`); Lead's official reader returned the decoded SVG data URL; static re-check: 758-byte valid SVG | **OK** |
| F-P33 | `types/index.d.ts` surface | `name` literal, `inject` tuple, `Config`, `apply(ctx, config)` (types/index.d.ts:30-44) | mirrors runtime exports (`src/index.js:67,73,76,186`); types path is exported via `exports["."].types` | **OK** |
| F-P34 | `Config` declaration precision | `Record<string, unknown>` (types/index.d.ts:37) | runtime `Config` is a schemastery object schema; declaration loses `.parse`/type inference. No runtime impact (loader imports JS, not `.d.ts`) | **RISK** (low) |
| F-P35 | type-only cordis import | `import type { Context } from '@deepseek-ai/cordis'` (types/index.d.ts:10) | acceptable: erased at runtime; `@deepseek-ai/cordis ~4.0.5` is a declared peer and installed; DSH's loader never imports the `.d.ts`. Consumer risk: a TS consumer resolving the package without cordis types gets TS2307 — that is exactly what the peer declaration signals | **OK** |
| F-P36 | README requirements | "DSH `0.2.1-rc.2` … `<0.3.0` (verified on `0.2.1-rc.3`)"; "profiles without `subagents` keep the row pending" (README.md:58-62) | matches `engines.dsh`; pending behavior is Cordis `inject` readiness (§1.2) | **OK** |
| F-P37 | README usage/config/output | tool params, config table, output fields (README.md:88-116) | match `src/index.js` `parameters`/`Config`/returned value and `docs/CONTRACT.md` (§2 F-04/F-08/F-29) | **OK** |
| F-P38 | CHANGELOG factual entries | rename, substrate switch, packaging, tests; BUG-1/BUG-2/RISK-05 fixed entries; upstream 0.1.0 section (CHANGELOG.md:7-55) | BUG-1/§5, questions fix (`src/index.js:86-89`) and RISK-05 hardening (`:362-366`) all present in source; claims match this audit | **OK** |

### 6.2 Provenance / attribution accuracy (vs `_ref/dsh-deep-research-main/`)

| # | claim | where (current file:line) | reference evidence | verdict |
|---|---|---|---|---|
| P-P01 | Original plugin name `@dsh-external/dsh-deep-research` | README.md:21, README.zh.md:19, package.json:4, CHANGELOG.md:52 | `_ref/package.json:2` — exact match | **OK** |
| P-P02 | Original version `0.1.0` | README.md:21,25, CHANGELOG.md:52 | `_ref/package.json:4` — exact match | **OK** |
| P-P03 | Original license MIT | README.md:21, CHANGELOG.md:15,52-55, LICENSE:7 | `_ref/package.json:31` + `_ref/LICENSE:1-8` — MIT confirmed | **OK** |
| P-P04 | Original design used the then-current `ctx.workflows` workflow engine | README.md:23,27-30, README.zh.md:21,25-30, CHANGELOG.md:16-21 | `_ref/src/index.ts:70` (`inject = ['tools','workflows']`), `:483` (`ctx.workflows.start`) | **OK** |
| P-P05 | Original repository `https://github.com/omdsh-dev/dsh-deep-research` | README.md:22, README.zh.md:20, CHANGELOG.md:15,54, LICENSE:6 | **Not supported by `_ref`**: the string `omdsh-dev` appears nowhere in the reference tree; `_ref/README.md:51` instead publishes `git+https://github.com/dsh-external/dsh-deep-research.git`, and `_ref/package.json` declares no `repository`. Verify the canonical upstream URL before publishing (if `omdsh-dev` is the authoritative/renamed home, keep it and cite both; otherwise correct these 5 sites) | **RISK** |
| P-P06 | Original copyright notice retained / holder named | LICENSE:3,6 — port lists only `Copyright (c) 2026 shmming` and states the upstream holder as `omdsh-dev` | `_ref/LICENSE:3` says **`Copyright (c) 2026 dsh2026`**; the port neither reproduces that notice nor states the correct holder. MIT requires the copyright notice to be included in copies/substantial portions; this is a derivative work | **BUG** |
| P-P07 | This repo/author/version point at shmming / Shmming-86 / 0.2.0 targeting rc.3 | README.md:9,24-25, package.json:2-3,17-26, README.zh.md:7,22-23 | requested identity; fields are mutually consistent and match `dsh --version` target | **OK** |
| P-P08 | Attribution and port responsibility statements | README.md:36,189-191, README.zh.md:32,182-184, CHANGELOG.md:13-15 | design credited to the original project; "bugs introduced by the port are ours" | **OK** |

**BUG-P1 (must fix before publishing):** `LICENSE:3-8` — the original MIT notice is not reproduced
and its copyright holder is misstated. Fix: keep the MIT text and list both notices, e.g.
`Copyright (c) 2026 dsh2026` (original, verbatim per `_ref/LICENSE:3`) and
`Copyright (c) 2026 shmming` (port), then state the upstream project/repository (aligned with P-P05).

### 6.3 Divergences from ecosystem conventions / documentation consistency

| # | divergence | evidence | verdict / recommendation |
|---|---|---|---|
| D-P01 | No `README.i18n.yaml` bilingual-pair record | shipped packages ship one (`$B/dsh-tool-workflow/README.i18n.yaml`, `$B/dsh-package-manifest/README.i18n.yaml` — per-heading EN/ZH hash record for the repo's docs/i18n tooling). Not read by app-boot, plugin-manager or the loader | **RISK** (low): only needed if adopting the upstream docs CI; otherwise document as a repo-only convention |
| D-P02 | No README YAML front-matter (`description`, `kind`) | shipped READMEs start with `--- description: … kind: "package-reference" ---` (`$B/dsh-tool-workflow/README.md:1-5`); used by the upstream docs site, not by DSH | **RISK** (low): cosmetic/ecosystem-only |
| D-P03 | `docs/` is published (in `files`) and contains internal absolute paths, `$B=…`, `_ref/`, `_testhome/`, `_verify/` references and audit task ids | package.json:51; docs/COMPAT.md §1–§5, docs/VERIFICATION.md | **RISK** (medium): sanitize for the npm surface (describe the install path generically, drop task ids/repo-only artifact references) or ship only user-facing docs. README.md:34,169-171 links to these files |
| D-P04 | `test/` and `scripts/` are excluded from `files` while README tells readers to run them | package.json:41-52 excludes them; `scripts` point at them (package.json:57-61); README.md:152-171 and 173-181 instruct `npm test` / `npm run verify:profile` | **RISK** (medium): on the published tarball both commands fail (missing directories). Either add `test`/`scripts` to `files` or state that these sections apply to a git checkout |
| D-P05 | Published `docs/VERIFICATION.md` records the pre-rename sha as the delivered file | docs/VERIFICATION.md:7-8,76,97 cite `d789c4b7…`; the shipped file is `bc29cbb1…` (differs only in the `@module` tag, §6 intro) | **RISK** (low): record both ("logic rev D `d789c4b7…`; delivered file `bc29cbb1…` after the package rename") or update the hash |
| D-P06 | Docs language mix | README is a bilingual pair, but `docs/` mixes English (COMPAT.md, CONTRACT.md) and Chinese (VERIFICATION.md), and the English README links the Chinese report | **RISK** (low): add a language note or keep docs consistently bilingual |
| D-P07 | Prior §1.2/§1.4 line references to `package.json` are stale after formalization | §1.2 cites `port package.json:7-12` (now 27-40), §1.4 cites `port package.json:33-36` (now 31-40; `dsh` now at 71-76) | **RISK** (low, doc-only): §6.1 is the current authoritative manifest map; prior line numbers refer to the pre-formalization manifest (rev-D era) |
| D-P08 | Old package name occurrences are all deliberate provenance | §6.4 | **OK** |
| D-P09 | No CHANGELOG link from the README (and the shipped `CHANGELOG.md` is only named in the layout tree) | README.md:133 lists `CHANGELOG.md` without a link; README.md/README.zh.md never link it, though `docs/` files are linked (README.md:34,169-171). `CHANGELOG.md` is shipped (package.json:49) | **RISK** (low): add a "See [CHANGELOG.md](CHANGELOG.md)" line near the version/license header |

### 6.4 Remaining occurrences of the old package name (`@dsh-external/dsh-deep-research`)

All occurrences are **legitimate provenance** (attribution/rename history); **none are stale
operational references** — no occurrence remains in `cordis.patch.yml`, `src/index.js`, `types/`,
`locale/`, `scripts/`, or `test/`, and `docs/CONTRACT.md` / `docs/VERIFICATION.md` carry none either.

| file:line | context | classification |
|---|---|---|
| README.md:21 | "Original plugin" table row | legitimate provenance |
| README.md:189 | Acknowledgements | legitimate provenance |
| README.zh.md:19 | "原始插件" table row | legitimate provenance |
| README.zh.md:182 | 致谢 | legitimate provenance |
| CHANGELOG.md:15 | rename entry (what the code derives from) | legitimate provenance |
| CHANGELOG.md:52 | `[0.1.0] - upstream reference` section | legitimate provenance |
| package.json:4 | `description` states the port provenance | legitimate provenance |
| LICENSE:5 | port-of-original statement in the MIT text | legitimate *intent*, but its surrounding copyright/URL statements are BUG-P1 / RISK-P05 |

Unscoped `dsh-deep-research` occurrences (plugin `name` export `src/index.js:67`, `types/index.d.ts:31`,
patch row `id` `cordis.patch.yml:12`, `@module` tags, test-suite/package names) are **not** old package
names — they are the stable Cordis row id / diagnostics name documented in README:103-109.

### 6.5 Verdict counts (§6 only)

| subsection | findings | OK | RISK | BUG |
|---|---|---|---|---|
| 6.1 manifest/packaging fields | 38 | 36 | 2 (F-P22 engines prerelease, F-P34 Config declaration) | 0 |
| 6.2 provenance/attribution | 8 | 6 | 1 (P-P05 upstream URL) | **1 (P-P06 LICENSE)** |
| 6.3 ecosystem divergences | 9 | 1 | 8 | 0 |
| **§6 total** | **55** | **43** | **11** | **1** |

**§6 verdict: OK 43 / RISK 11 / BUG 1.** One must-fix before publishing: **BUG-P1** — reproduce the
upstream MIT copyright notice (`Copyright (c) 2026 dsh2026`, `_ref/LICENSE:3`) and correct the holder
statement in `LICENSE:3-8`; reconcile the upstream repository URL claim (P-P05) at the same time.
Highest-value packaging cleanups: D-P04 (README commands vs publish surface) and D-P03 (internal paths
in published docs). The manifest, locale, icon, composition row, exports and publish settings are
conformant with the installed 0.2.1-rc.3 readers (`readPluginMeta`, app-boot compatibility preflight,
plugin-manager install rules); the source is the audited rev D logic with only the `@module` tag
renamed.

**Post-fix roll-up (§6.6):** BUG-P1 and RISK-P05 are now **closed**; D-P04, D-P05 and D-P09 were fixed;
D-P01/D-P02 were accepted as documented non-requirements. Revised §6 counts: **OK 50 / RISK 5 / BUG 0**
(the table above is the pre-fix record, kept for traceability).

### 6.6 Resolution of §6 findings (post-fix)

Re-verified after the Lead's fixes. Only packaging/docs files changed — `src/index.js` is still the
audited `bc29cbb1…` (735 lines; §2/§5 remain valid). Primary evidence below is the reference tree and
the current files; the Lead's `git ls-remote` result (omdsh-dev resolves; dsh-external did not from that
host) is treated as **supporting context only** — my own re-run of `git ls-remote` for both URLs timed
out in this sandbox (exit 124), so it could not be independently reproduced here.

#### 6.6.1 BUG-P1 — **CLOSED**

| check | current evidence | verdict |
|---|---|---|
| Port copyright notice | `LICENSE:3` = `Copyright (c) 2026 shmming` | OK |
| Upstream copyright notice retained | `LICENSE:4` = `Copyright (c) 2026 dsh2026 (original plugin \`@dsh-external/dsh-deep-research\`)`; the upstream string `Copyright (c) 2026 dsh2026` from `_ref/LICENSE:3` appears **verbatim** (the trailing parenthetical is an annotation, it does not alter the notice) | OK |
| MIT permission body unchanged | `LICENSE:15-31` is byte-identical to `_ref/LICENSE:5-21` from `Permission is hereby granted…` onward (verified by diff) | OK |
| Derivative-work statement | `LICENSE:6-13` names both repository locations and states the upstream notice is reproduced as MIT requires | OK |

MIT notice retention is satisfied; the holder is now correctly named. **BUG-P1 closed.**

#### 6.6.2 RISK-P05 — **CLOSED (reconciled with evidence)**

The five original citation sites now state provenance with the nuance that matches the reference tree:

| original citation site | current state | cross-check |
|---|---|---|
| README.md:22 | "Original repository … (the snapshot this port was built from)", plus README.md:28-31: snapshot downloaded 2026-10-29; the original README installs from `dsh-external`; original package.json declares no `repository`; both identify the original project | `_ref/README.md:51` (dsh-external URL), `_ref/package.json` (no `repository`) |
| README.zh.md:20 | same nuance (README.zh.md:26-28) | same |
| CHANGELOG.md:15 | 0.2.0 rename entry now carries both locations + `MIT, Copyright (c) 2026 dsh2026` (CHANGELOG.md:15-17) | `_ref/LICENSE:3` |
| CHANGELOG.md:54 | 0.1.0 entry same nuance (CHANGELOG.md:54-56) | same |
| LICENSE:6 | derivative statement names both locations (LICENSE:8-9) | same |

Additional consistency: `README.md:23` / `README.zh.md:21` add an "Original copyright holder `dsh2026`"
row; `docs/VERIFICATION.md:122-127` (§3.1) records the same provenance and the licence retention. The
claims are now split correctly — *snapshot provenance* (`omdsh-dev`) vs *the original README's install
URL* (`dsh-external`) — instead of asserting one canonical repository. **RISK-P05 closed.**

#### 6.6.3 Other §6 findings

| finding | post-fix state | new verdict |
|---|---|---|
| D-P01 (`README.i18n.yaml`) | Not added by design; decision documented in `docs/VERIFICATION.md:192` (official-repo docs-pipeline artifact, not a plugin requirement) | **OK** (accepted, documented) |
| D-P02 (README front-matter) | Same decision; not added | **OK** (accepted, documented) |
| D-P03 (internal paths in published docs) | `/data/code/dsh-plugin` now appears only in the explanatory note `docs/VERIFICATION.md:4` (commands use a `<repo>` placeholder) ✓. Residual: published `docs/COMPAT.md` still cites repo-only artifacts as audit notation (`_ref/…` 4×, `_testhome/…` at :80, `task-3` at :8, `$B = /usr/lib/node_modules/…` at :43/:299) | **RISK (low, residual)** — acceptable for an audit appendix; sanitize if COMPAT is distributed standalone |
| D-P04 (README commands vs publish surface) | `README.md:188-189` and `README.zh.md:179`: "`test/` and `scripts/` belong to the repository checkout … intentionally not part of the published npm tarball … run them from a git clone" | **OK** |
| D-P05 (stale verification hash) | `docs/VERIFICATION.md:10-14` records delivered sha `bc29cbb1…`, plus rev D `d789c4b7…` and the single-line `@module` rename explanation; `:85` and `:168` consistent | **OK** |
| D-P06 (docs language mix) | Unchanged: English README links Chinese `docs/VERIFICATION.md`; COMPAT/CONTRACT are English, VERIFICATION is Chinese | **RISK (low, open)** |
| D-P07 (stale §1 line refs) | Unchanged: `docs/COMPAT.md:64,80` still cite pre-formalization `package.json:7-12` / `:33-36`; §6.1 is the authoritative map | **RISK (low, open, doc-only)** |
| D-P09 (no CHANGELOG link) | `README.md:198` and `README.zh.md:188` now link `CHANGELOG.md` | **OK** |

#### 6.6.4 Provenance citations and old-name occurrences — re-check

The 5 original citations (README.md:22, README.zh.md:20, CHANGELOG.md:15,54, LICENSE:6) were re-read at
their current line numbers; all now carry the reconciled, evidence-backed wording (table above), and no
unsupported provenance claim remains.

Old-name occurrences in shipable/published files after the fix — **13 lines, all legitimate, 0 stale**
(§6.4's 8-line table is the pre-fix record and is superseded by this list):

| file:line | context | classification |
|---|---|---|
| README.md:21 | "Original plugin" table row | legitimate provenance |
| README.md:202 | Acknowledgements (now with `dsh2026` + URL) | legitimate provenance |
| README.zh.md:19 | "原始插件" table row | legitimate provenance |
| README.zh.md:192 | 致谢 (now with `dsh2026` + URL) | legitimate provenance |
| CHANGELOG.md:15 | 0.2.0 rename entry (reference snapshot) | legitimate provenance |
| CHANGELOG.md:54 | `[0.1.0] - upstream reference` entry | legitimate provenance |
| LICENSE:4 | upstream copyright notice (required by MIT) | legitimate — required retention |
| LICENSE:7 | derivative-work statement | legitimate provenance |
| package.json:4 | `description` states the port provenance | legitimate provenance |
| docs/VERIFICATION.md:122 | §3.1 record of the provenance audit | legitimate verification record |
| docs/COMPAT.md:294 | §6 rename proof (`@module` tag change) | legitimate audit evidence |
| docs/COMPAT.md:356 | §6.2 P-P01 row quoting the original name | legitimate audit evidence |
| docs/COMPAT.md:384 | §6.4 heading | legitimate audit heading |

Operational files remain completely clean: no occurrence in `cordis.patch.yml`, `src/index.js`,
`types/`, `locale/`, `scripts/`, `test/`, or `docs/CONTRACT.md`.

#### 6.6.5 Revised roll-up (supersedes the §6.5 table)

| subsection | findings | pre-fix OK/RISK/BUG | post-fix OK/RISK/BUG |
|---|---|---|---|
| 6.1 manifest/packaging fields | 38 | 36 / 2 / 0 | **36 / 2 / 0** (F-P22, F-P34 unchanged) |
| 6.2 provenance/attribution | 8 | 6 / 1 / 1 | **8 / 0 / 0** (BUG-P1 and RISK-P05 closed) |
| 6.3 ecosystem divergences | 9 | 1 / 8 / 0 | **6 / 3 / 0** (D-P01/D-P02 accepted, D-P04/D-P05/D-P09 fixed; D-P03 residual, D-P06, D-P07 open) |
| **§6 total** | **55** | 43 / 11 / 1 | **50 / 5 / 0** |

**Post-fix §6 verdict: OK 50 / RISK 5 / BUG 0.** The previous must-fix (**BUG-P1**) and the provenance
risk (**RISK-P05**) are closed. The five still-open items are low and non-blocking: F-P22 (`engines.dsh`
upper bound admits `0.3.0-rc.*`), F-P34 (`Config` declaration looseness), D-P03 (repo-only artifact refs
inside the published audit appendix), D-P06 (docs language mix) and D-P07 (stale pre-formalization line
refs in §1). None of them affects the runtime contract or the publishable manifest.

