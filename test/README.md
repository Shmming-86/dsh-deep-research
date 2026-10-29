# Offline unit tests — `@shmming/dsh-deep-research`

Zero-dependency test suite for the DSH 0.2.1-rc.3 port. Every test runs **offline**:
no model API calls, no network, no DSH profile. The tool definition is compiled by
the *real* `defineTool` from the installed `@deepseek-ai/dsh-tools` 0.2.1-rc.3
package, and child agents are served by a scripted fake
`ctx.subagents.startActivation` seam.

Coverage is the frozen contract in [`../docs/CONTRACT.md`](../docs/CONTRACT.md).

## Run

```bash
cd /data/code/dsh-plugin
node --test test/
```

Other useful invocations:

```bash
node --test --test-reporter=spec test/   # per-test names, timing
node --test test/plugin.test.mjs         # only the plugin suite
```

Node **>= 22** treats positional arguments of `node --test` as glob patterns, so a
bare directory (`node --test test/`) is resolved through
[`test/package.json`](./package.json) (`"main": "./plugin.test.mjs"`). That is why
the tiny `test/package.json` exists; without it Node 24 tries to load the directory
as a module and fails before running any test. Do **not** delete it if the
documented command must keep working.

## Files

| file | purpose |
|---|---|
| [`helpers/link-deps.mjs`](./helpers/link-deps.mjs) | Idempotently symlinks the installed peers (`dsh-tools`, `dsh-subagent`, `schemastery`, `cordis`) into the workspace `node_modules/@deepseek-ai/`, so the plugin's bare imports resolve outside a DSH profile. Verifies each target exists; replaces only stale symlinks; never removes a real directory. `DSH_INSTALL_ROOT` overrides the installation path. |
| [`helpers/load-plugin.mjs`](./helpers/load-plugin.mjs) | Creates the links **before** dynamically importing `src/index.js` (ESM links static imports before any module body runs, so a static import would be too late) and returns the real `defineTool`/`validateJsonSchemaValue` plus installed package versions. |
| [`helpers/fake-context.mjs`](./helpers/fake-context.mjs) | Fake cordis `ctx`: `tools.register`, async `subagents.startActivation` (returns a Promise resolved on a later tick, like the real seam), label + prompt-substring scripts, `DEFER` for cancellation, request recording, concurrency high-water, disposal counts, a caught `ctx.workflows` accessor, and optional `ctx.logger`. |
| [`plugin.test.mjs`](./plugin.test.mjs) | The suite itself (20 tests). |

### Fake seam details

- `ctx.script({ label, promptIncludes, provider, respond })` registers a child
  responder. `label` is a string (exact) or `RegExp`; `promptIncludes` is a
  substring or array of substrings that must all appear in the child prompt;
  the **last** matching script wins.
- `respond` is a result object, a function `(record) => result | Promise<result>`,
  or `DEFER` to keep the activation pending until `dispose()`/`release()`.
- A result is `{ stopReason, output: [{ type: 'text', text }], structured? }`.
  If no script matches, a schema-aware default (planner/researcher/text) is
  returned, so a missing script fails an assertion instead of hanging the run.
- Recorded per activation: `provider`, `label`, `delivery`, `signal`, `request`
  (including `request.parent`), `promptText`, `outputSchema`, `agentOptions`,
  `model`, `disposed`, `disposeCount`. Context-level: `highWater`,
  `activationCount`, `disposalCount`, `activationLabels()`, `labelCount()`.
- `startActivation` is **async** and publishes the child after a macrotask
  (`publicationDelayMs`, default 1 ms) to model `Promise<SubagentActivation>`.
  A synchronous fake would hide a missing `await` in the plugin.

## What each test proves

| # | test | proves |
|---|---|---|
| 1 | registration | exact one tool registered; `name`/`inject`/`Config` exports match the contract; real `defineTool` compiles parameters (`topic` only required) and the closed output schema (`ok`/`report` required, numbers optional); canonical value validates; `render()` = report (+ review) or a `deep_research` failure message; `ctx.workflows` untouched; no logger required |
| 2 | execute with questions | planner skipped; exactly one researcher per question (round-1 labels); synthesizer runs by default; `ok/report/rounds/subquestions/completed/failed/skipped`; evidence header; report contains questions, appended synthesized text and raw-evidence appendix; `render()` includes report; request contract (provider `spawn`, `delivery: 'caller'`, `signal`, `request.parent`, text prompt); every activation disposed once |
| 3 | adaptive loop | a `gaps[{priority:'high'}]` finding starts a round-2 follow-up child (`研究·第2轮·1`), `rounds === 2`, follow-up question appears in the report |
| 4 | planner path | planner child receives an object-rooted, closed `PLANNER_SCHEMA` (`scope`/`dimensions`/`questions`/`coverage_gaps` required); `purpose` reaches the planner prompt; `coverage_gaps` become blind-spot recon questions (never dropped); the plan's answer space appears in the report |
| 5 | maxParallel | 6 questions with `maxParallel: 2`: concurrency high-water is exactly 2 (never more), all 6 studied across 3 rounds |
| 6 | maxTotalAgents | with a low cap, no overrun, `skipped > 0`, every started researcher accounted for, `completed + failed + skipped === subquestions` |
| 7 | seam (async) | the plugin `await`s the Promise-returning `startActivation`: planner + research + synthesis succeed with a 2 ms publication delay; all activations disposed exactly once |
| 8 | cancellation | abort mid-run rejects the tool call with `exec.signal.reason`, every started activation disposed exactly once, no unhandled rejection |
| 9 | cancellation during publication | an abort while the activation is still being published still disposes the child and rejects with the abort reason |
| 10 | error isolation | a researcher `stopReason: 'error'` marks that section failed while the report is still produced (`completed + failed` consistent) |
| 11 | planner failure | planner error rejects the tool call and starts no research child |
| 12 | planner without structured | schema-requested planner completing without `structured` is treated as failure and rejects |
| 13 | validation | blank topic, `depth: 4`, `depth: 0`, missing `exec.agent` all reject **before** any activation |
| 14 | questions parsing | leading `1.` / `1、` markers stripped; blank lines ignored; one child per question |
| 15 | review: true | reviewer child runs once; `result.review` carries its text; `render()` appends review |
| 16 | synthesize: false | no synthesizer child; evidence-only report; `review` absent |
| 17 | config forwarding | `childProvider` and per-role `*Model` overrides reach the activation requests (`provider`, `agentOptions.model`) |
| 18 | reviewer model fallback | `reviewerModel` falls back to `synthesizerModel` |
| 19 | config validation | `maxParallel` 0/-1/1.5 and `maxTotalAgents` 0/-2 throw a `dsh-deep-research:` error from `apply` and register nothing |

## Observed results

Last run (Node v24.20.0, DSH 0.2.1-rc.3), executed twice back-to-back for timing
stability — identical results:

```
$ cd /data/code/dsh-plugin && node --test test/
ℹ tests 20
ℹ suites 0
ℹ pass 20
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms ~260
```

## Contract deviations found by this suite

Both were found by the harness, reported to the implementer, and fixed in
`src/index.js` (no test was weakened to make them pass):

1. **BUG-1 — async seam not awaited.** `ctx.subagents.startActivation(spec)` returns
   `Promise<SubagentActivation>` (see `@deepseek-ai/dsh-subagent/lib/types/index.d.ts`),
   but the plugin used the activation synchronously. Caught by the fake seam being
   async (`publicationDelayMs`) and by the abort-during-publication path; the
   regression test "seam: plugin awaits the Promise-returning startActivation and
   succeeds" now locks the behaviour in.
2. **BUG-2 — double-wrapped `questions` input.** `parseQuestionList` already returns
   `[{ question }]`, but the given-questions branch wrapped each entry again, so
   researcher prompts and report section headers contained `[object Object]`
   instead of the question text. Caught by "execute with questions",
   "maxParallel", "error isolation", "questions parsing" and "synthesize: false";
   fixed to `givenQuestions.map(item => ({ ...item }))`.

## Environment note (not a plugin bug)

Node 24 no longer expands a directory as a `node --test` positional argument
(positional args are glob patterns). The documented `node --test test/` command is
kept working through `test/package.json` (`"type": "module"`, `"main": "./plugin.test.mjs"`),
which Node resolves when it is handed the directory.

## Maintenance notes

- New peer packages used by the plugin must be added to `LINKED_PACKAGES` in
  `helpers/link-deps.mjs`.
- Tests must stay offline: never call a real provider, and never require a DSH
  profile.
- Any blocking await in a test should go through `withTimeout` / `waitFor` so a
  regression fails fast instead of hanging CI.
