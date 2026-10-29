# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-10-29

First standardized release of the port, targeting DeepSeek Harness `0.2.1-rc.3`.

### Changed

- Renamed the package to `@shmming/dsh-deep-research`, author `shmming`, repository
  <https://github.com/Shmming-86/dsh-deep-research>; the code remains derived from
  `@dsh-external/dsh-deep-research` (reference snapshot:
  <https://github.com/omdsh-dev/dsh-deep-research>; the original README also installs it from
  `git+https://github.com/dsh-external/dsh-deep-research.git`; MIT, Copyright (c) 2026 `dsh2026`).
- Replaced the reference project's old execution substrate (`ctx.workflows` + workflow script)
  with the official subagent seam (`ctx.subagents.startActivation`), because `ctx.workflows` no
  longer exists on DSH 0.2.1-rc.3 and the root `web` composition isolates `ctx.workflowEngine`
  inside agent-preset delegation groups. The adaptive research design, planner/researcher
  schemas, prompts, three-state evidence model, configuration surface and tool contract are
  preserved.
- Formalized packaging for DSH: `engines.dsh`/`engines.node`, `dsh.manifestVersion: 1`,
  `dsh.bundle.patch`, `exports` for `.`/`cordis.patch.yml`/`locale/*.json`/`icon`, `files`
  whitelist, `publishConfig.access: public`, `author`, `repository`, `keywords`.
- Added plugin display metadata (`locale/en.json`, `locale/zh.json`), an SVG icon
  (`assets/icon.svg`), and TypeScript surface declarations (`types/index.d.ts`).
- README is now bilingual: English (`README.md`) and Chinese (`README.zh.md`), both documenting
  the original plugin and repository this project is based on.

### Added

- Offline unit/contract suite (`test/`, 20 tests) using the installed real `defineTool` and a
  scripted asynchronous subagent seam.
- Real-profile verification script (`scripts/verify-profile.mjs`) covering bundle-patch row
  insertion, `--dump-config-schema` module import, `dsh web` boot smoke, an activation control,
  and an instrumented-copy proof that `apply()` runs and registers `deep_research` at boot.
- Documentation: `docs/CONTRACT.md`, `docs/COMPAT.md` (independent API audit), and
  `docs/VERIFICATION.md`.

### Fixed

- **BUG-1 (critical):** `ctx.subagents.startActivation` returns `Promise<SubagentActivation>`;
  the initial port did not `await` it, so every child was classified as failed and disposal
  threw. Now awaited, with abort-during-publication and start-failure handling.
- **BUG-2 (high):** the `questions` argument was double-wrapped, so child prompts and report
  headers contained `[object Object]`; the parsed entries are now passed through unchanged.
- **RISK-05 (low):** a synchronous throw from `dispose()` could escape `disposeOnce` and mask
  the tool's outcome; the call is now deferred through `Promise.resolve().then(...)`.

## [0.1.0] - upstream reference

The original plugin `@dsh-external/dsh-deep-research` 0.1.0 (MIT, Copyright (c) 2026
`dsh2026`), published at <https://github.com/omdsh-dev/dsh-deep-research> (and installed by its
own README from `git+https://github.com/dsh-external/dsh-deep-research.git`), built against the
older DSH `ctx.workflows` API. This project starts from that design and code; the upstream MIT
copyright notice is reproduced in [LICENSE](LICENSE).

[0.2.0]: https://github.com/Shmming-86/dsh-deep-research/releases/tag/v0.2.0
