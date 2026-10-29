# @shmming/dsh-deep-research

An **adaptive deep-research orchestrator** plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).
It registers one model-facing tool, `deep_research`, that runs a live research loop designed from
cybernetics and information theory — answer-space calibration, dimension coverage, information-gain
driven research rounds, rate–distortion synthesis, and an optional adversarial review — reusing DSH's
built-in `web_search` / `web_fetch` tools through subagents.

Current target: **DSH 0.2.1-rc.3** · License: MIT · Author: [shmming](https://github.com/Shmming-86)

[English](README.md) | [中文](README.zh.md)

---

## Based on the original plugin

This project is a **port and continuation of an existing DSH plugin**:

| | |
|---|---|
| **Original plugin** | `@dsh-external/dsh-deep-research` (version `0.1.0`, MIT) |
| **Original repository** | <https://github.com/omdsh-dev/dsh-deep-research> (the snapshot this port was built from) |
| **Original copyright holder** | `dsh2026` (per the original `LICENSE`) |
| **Original design** | cybernetics + information-theory deep-research loop on the then-current DSH workflow engine (`ctx.workflows`), with planner/researcher/synthesizer/reviewer subagents and three-state evidence |
| **This repository** | <https://github.com/Shmming-86/dsh-deep-research> — maintained by shmming |
| **This version** | `0.2.0`, targeting DSH `0.2.1-rc.3` |

The snapshot used for this port was downloaded from `https://github.com/omdsh-dev/dsh-deep-research` on
2026-10-29. The original project's own README installs it from
`git+https://github.com/dsh-external/dsh-deep-research.git`, and its package.json declares no
`repository` field, so both locations identify the original project.

The original plugin cannot run on current DSH unchanged: `ctx.workflows` no longer exists (the service
is `ctx.workflowEngine`), and the shipped `web` profile mounts the workflow engine only inside agent-preset
delegation groups (`isolate: { workflowEngine: true }`), so a root-level plugin cannot inject it.
This port keeps the original research design, prompts, evidence model, adaptive loop, and configuration
surface, but replaces the execution substrate with the **official subagent seam**
(`ctx.subagents.startActivation`) that the workflow engine itself uses, so the plugin now loads in the
root composition of both `web` and `headless` profiles. It also adds a test suite, real-profile
verification, and formal packaging. Details: [docs/COMPAT.md](docs/COMPAT.md).

Upstream authors and design are credited; all bugs introduced by the port are ours.

## What it does

```
apply(ctx, config)
└─ registers tool `deep_research`
   ├─ planning (skippable): PLANNER_SCHEMA
   │    scope (answer space) + dimensions (requisite variety) + questions[] + coverage_gaps[]
   ├─ adaptive research loop (≤ depth+1 rounds, ≤ maxParallel children per round)
   │    researcher → confirmed[] / uncertain[] / gaps[{aspect, priority}]
   │    high-priority gaps become next-round questions (stops when marginal information gain ≈ 0)
   │    declared blind spots get one reconnaissance attempt (never silently dropped)
   ├─ synthesis: lossy compression into a cited report that preserves uncertainty
   └─ review (opt-in): citation spot-checks, coverage audit, contradictions, over-confidence
```

- Children inherit the parent preset's tools, including built-in `web_search` / `web_fetch`.
- Cancellation (`exec.signal`) is forwarded to every activation; aborts dispose live children and reject the call.
- `maxTotalAgents` is a hard per-call child budget (synthesis/review slots reserved); unstudied questions are reported as `skipped`.
- A failed researcher only marks its own section; a failed planner fails the tool call with a clear error.

## Requirements

- DSH `0.2.1-rc.2` … `<0.3.0` (verified on `0.2.1-rc.3`).
- A profile whose **root** composition provides `tools` and `subagents`; the shipped `web` and `headless`
  templates do. Profiles without `subagents` keep the row pending.

## Install

```bash
# from git (replace <profile> with web / headless / your profile name)
dsh plugin --profile <profile> add git+https://github.com/Shmming-86/dsh-deep-research.git

# or link a local checkout (no registry/network)
dsh plugin --profile <profile> add link:/path/to/dsh-deep-research

dsh --profile <profile>    # restart to activate
```

The package declares `dsh.bundle.patch` (`cordis.patch.yml`), so listing it in
`dsh.profile.bundles` inserts exactly one root row — no manual wiring.

## Usage

The model triggers the tool from its description; just ask in natural language:

- “Deep-research the current MCP ecosystem, compare the main implementations, and write a cited report.”
- “Research these questions: 1. … 2. …” (an explicit list skips automatic decomposition)
- “Investigate options A and B; the purpose is deciding which one we adopt.” (a clear purpose sharpens the answer space)
- Pass `depth: 3` for exhaustive coverage and `review: true` for citation/coverage auditing.

| Parameter | Required | Meaning |
|---|---|---|
| `topic` | yes | research topic |
| `purpose` | no | decision/judgement the report must support (defines the answer space) |
| `questions` | no | existing question list, one per line (`1.` / `1、` / `- ` markers accepted); skips planning |
| `depth` | no | `1` preliminary (≤2 rounds), `2` deep (default, ≤3), `3` exhaustive (≤4) |
| `synthesize` | no | write the final report with a synthesizer child (default `true`; `false` = evidence only) |
| `review` | no | adversarial review (default `false`) |

Output value: `ok`, `report`, `review?`, `rounds`, `subquestions`, `completed`, `failed`, `skipped`.

## Configuration

All fields optional; override them on the plugin's profile row:

```yaml
# profile cordis.patch.yml
- id: dsh-deep-research
  config:
    maxParallel: 6
    researcherModel: deepseek-chat
```

| Key | Default | Meaning |
|---|---|---|
| `childProvider` | `spawn` | subagent provider used for every child |
| `maxParallel` | `4` | research children per round |
| `maxTotalAgents` | `32` | child activations per tool call (synthesis/review reserved) |
| `plannerModel` / `researcherModel` / `synthesizerModel` / `reviewerModel` | inherit parent route | model tiering (`reviewerModel` falls back to `synthesizerModel`) |

## Project layout

```
dsh-deep-research/
├── package.json          # plugin manifest: engines.dsh, dsh.manifestVersion, dsh.bundle.patch,
│                         # exports for . / cordis.patch.yml / locale/*.json / icon, files, author
├── cordis.patch.yml      # bundle patch: inserts row id=dsh-deep-research
├── src/index.js          # Cordis plugin (plain ESM, zero build)
├── types/index.d.ts      # plugin surface declarations
├── locale/en.json        # plugin display metadata (meta.title / meta.description)
├── locale/zh.json        # Chinese display metadata
├── assets/icon.svg       # plugin icon (manifest `icon`)
├── test/                 # offline `node --test` suite (real defineTool + scripted async seam)
├── scripts/verify-profile.mjs  # real DSH profile composition/load verification
├── docs/                 # CONTRACT.md, COMPAT.md, VERIFICATION.md
├── CHANGELOG.md
└── LICENSE
```

## DSH plugin packaging conventions

This package follows the conventions the installed DSH `0.2.1-rc.3` packages use:

- **Manifest**: `engines.dsh` declares the compatible DSH range; `dsh.manifestVersion: 1` and
  `dsh.bundle.patch` declare the loader integration; `exports` covers `.`, `./cordis.patch.yml`,
  `./locale/*.json`, `./icon`; `files` whitelists the published surface; `publishConfig.access: public`
  for the scoped name.
- **Display metadata**: `locale/en.json` and `locale/zh.json` provide `meta.title` / `meta.description`,
  resolved by DSH's plugin metadata reader (`readPluginMeta`) without evaluating plugin code.
- **Icon**: `package.json.icon` points at `assets/icon.svg` (SVG, < 256 KiB), also exported as `./icon`.
- **Composition row**: `cordis.patch.yml` inserts the single row the loader mounts; users override its
  `config` by the same `id`.
- **Type declarations**: `types/index.d.ts` describes `name`, `inject`, `Config`, and `apply`.

## Verification

All verification is offline (no model API calls, no network, `~/.dsh` untouched):

```bash
npm test                  # node --test test/  → 20/20 PASS
npm run verify:profile    # real DSH profile    → 9/9 PASS
```

- **Unit/contract tests** (`test/`): registration and schema compilation with the installed real
  `defineTool`; explicit-question path; adaptive gap loop; planner + blind-spot recon; concurrency
  high-water; budget accounting; two cancellation paths; error isolation; validation; config forwarding.
- **Real-profile verification** (`scripts/verify-profile.mjs`): scratch `DSH_HOME` using the shipped
  `web` template; `--dump-config` shows exactly one active row inserted by the bundle patch;
  `--dump-config-schema` imports the module and projects its Config schema; `dsh web` boot smoke;
  an intentional-invalid-config control and an instrumented throwaway copy prove `apply()` runs and
  `deep_research` is registered at boot; the official `readPluginMeta` resolves the en/zh display
  metadata and icon; `npm pack --dry-run` confirms the 14-file publish surface, and a real
  `dsh plugin add link:` install was exercised end to end.
- **Independent API audit** ([docs/COMPAT.md](docs/COMPAT.md)): code audit OK 36 / RISK 11
  (1 closed) / BUG 1 (found, fixed, re-verified); packaging audit (55 findings) OK 50 / RISK 5 /
  BUG 0 — the one must-fix licensing finding (upstream MIT notice) is fixed and closed.
- Full report: [docs/VERIFICATION.md](docs/VERIFICATION.md).

## Development

```bash
npm test                  # offline unit/contract suite
npm run verify:profile    # profile-level verification (scratch DSH_HOME under _verify/)
```

`test/` and `scripts/` belong to the repository checkout: they are intentionally not part of the
published npm tarball (`files` whitelist), so run them from a git clone.

Node `>= 22.19` (or `>= 24`); no build step. The verification script needs a local `dsh` binary and the
installed `@deepseek-ai/*` packages; it never modifies `~/.dsh`.

## License

MIT. See [LICENSE](LICENSE).

See [CHANGELOG.md](CHANGELOG.md) for the change history.

## Acknowledgements

- Original plugin and design: **`@dsh-external/dsh-deep-research`** (MIT,
  Copyright (c) 2026 `dsh2026`) — <https://github.com/omdsh-dev/dsh-deep-research>.
- DeepSeek Harness and its plugin platform: <https://github.com/deepseek-ai/deepseek-harness>.
