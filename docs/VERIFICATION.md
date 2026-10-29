# 验证报告 — `@shmming/dsh-deep-research`（DSH 0.2.1-rc.3）

本报告汇总对插件 `@shmming/dsh-deep-research`（本目录）的全部验证。命令中的 `<repo>` 指本仓库根目录
（本次验证时位于 `/data/code/dsh-plugin`；`_verify/` 为本地生成的验证产物，已 gitignore、不随包发布）。

全部验证**不消耗
模型 API 配额**、不访问网络、不修改 `~/.dsh`（真实 profile 只读）；profile 级验证使用工作区内的
一次性 `DSH_HOME`。

- 验证对象：`src/index.js` 735 行，sha256
  `bc29cbb15381c73d19103ec0ee5c5c2fd8306454a8433543b5a0001272ac63ae`
  （= 已审计的 rev D；规范化改名时只在 `@module` 文档行把 `@dsh-external` 改为 `@shmming`，
  逐行回退该行可逐字节还原 rev D 的 `d789c4b7c27ffc43ea832d4269b60b1fb4800837ff7c6fd84dab1e49f5461506`，
  逻辑零改动）
- 包身份：`@shmming/dsh-deep-research@0.2.0`，author `shmming`，
  repository `https://github.com/Shmming-86/dsh-deep-research`
- 运行时：`dsh 0.2.1-rc.3`（`/usr/lib/node_modules/@deepseek-ai/dsh/`），Node `v24.20.0`
- 结论：**通过** — 单元/契约测试 20/20；真实 DSH profile 验证 **9/9**；规范化打包/安装验证通过；
  独立 API 审计 OK 36 / RISK 11（1 项已关闭，其余为已记录限制）/ BUG 1（已修复并复验）；
  规范化打包审计 55 项 → **OK 50 / RISK 5 / BUG 0**（许可证归属问题 BUG-P1 已修复关闭）；
  验证过程中发现并修复了 2 个真实实现 bug。

## 0. 证据层级

| 层级 | 证明了什么 | 命令 | 结果 |
|---|---|---|---|
| L1 单元/契约 | 插件逻辑、工具 schema 编译、自适应闭环、预算、取消、错误隔离、配置校验（真实 `defineTool` + 脚本化 async subagent seam） | `node --test test/` | **20/20 PASS**，多次连续运行一致（~250 ms） |
| L2 真实 profile 组合 | 包清单/`dsh.bundle.patch`/行插入/模块 import/Config schema 投影/真实 `dsh web` 启动/apply 执行与注册/显示元数据/发布面 | `node scripts/verify-profile.mjs` | **9/9 PASS** |
| L3 规范化打包与安装 | `author`/`repository`/`engines`/`manifestVersion`/`locale`/`icon`/`types`/`files` 是否符合 DSH 约定，以及 `dsh plugin add` 真实安装路径 | `dsh plugin add link:` + `npm pack --dry-run` + 官方 `readPluginMeta` | **PASS**（详见 §3） |
| L4 独立 API 审计 | 参考项目 API → 当前 0.2.1-rc.3 的逐项映射、`src/index.js` 逐行对照 `.d.ts`、残留风险 | 见 [COMPAT.md](COMPAT.md) | OK 36 / RISK 11 / BUG 1（已关闭）+ 打包符合性 §6 |

## 1. L1 — 单元/契约测试（20/20）

```bash
cd <repo>
npm test                         # = node --test test/；exit 0, tests 20, pass 20, fail 0（~250ms）
node --test --test-reporter=spec test/   # 逐项名称与耗时
```

测试**使用安装版 `@deepseek-ai/dsh-tools` 的真实 `defineTool`** 编译工具定义（不是模拟编译器），
子代理由脚本化的 **async** `ctx.subagents.startActivation` 假实现提供（含 1ms 发布延迟，锁定
"seam 是 Promise"这一契约）。覆盖：

- 注册与导出（`name`/`inject`/`Config`/`apply`）、参数与输出 schema 编译/校验、render 投影
- 显式 `questions` 路径（跳过规划、每问题一个 researcher、综合）
- 自适应闭环：high-priority `gaps` 自动派发下一轮；跨轮去重；轮次上限
- 规划路径：`PLANNER_SCHEMA` + `coverage_gaps` → 盲区侦察子问题；答案空间写入报告
- `maxParallel` 并发高水位；`maxTotalAgents` 预算/不超发/`completed+failed+skipped === subquestions`
- 取消：运行中 abort、发布中 abort 两条路径（都 dispose 且以 abort reason 拒绝，无 unhandled rejection）
- 失败隔离（单问题失败仍出报告；规划失败报错；schema 请求但无 structured 视为失败）
- 参数/配置校验（空 topic、depth 0/4、maxParallel 0/-1/1.5、maxTotalAgents 0/-2）
- 配置透传（`childProvider`、角色模型、reviewer 回退到 synthesizer）

## 2. L2 — 真实 DSH profile 验证（9/9 PASS）

```bash
npm run verify:profile   # = node scripts/verify-profile.mjs；exit 0；报告：_verify/profile-report.{md,json}
```

一次性 scratch home：`_verify/home`（工作区内部；真实 `~/.dsh` 未触碰）。9 项检查：

| # | 检查 | 结果 | 关键证据 |
|---|---|---|---|
| 1 | 前置条件（运行时/清单/patch 行身份/模块导出） | PASS | dsh 0.2.1-rc.3；包 `@shmming/dsh-deep-research@0.2.0`；`inject=[tools,subagents]`；`engines.dsh=">=0.2.1-rc.2 <0.3.0"` |
| 2 | 从官方 web 模板初始化 scratch profile | PASS | `_verify/home/profiles/dr`，bundles = dsh-base + dsh-web-app |
| 3 | 安装（symlink + bundle manifest，无 pnpm/网络） | PASS | profile `node_modules/@shmming/dsh-deep-research -> <repo>`；bundles 追加；`link:` 依赖登记 |
| 4 | `--dump-config` 组合结果 | PASS | 根级**恰好一行** `id: dsh-deep-research`（未 disabled）；`workflow-ptc`/`tool-web` 仍在；根行数 192 vs 初始化 191（多出的正是 bundle patch 插入的本插件行） |
| 5 | `--dump-config-schema` 真实 import 并投影 Config | PASS | entry `/191 status=schema`；7 个 Config 字段全部投影；默认值 `spawn/4/32`。说明：0.2.1-rc.3 的 schema dump 在**未改动的 web 模板**上本就 exit 1（4 条上游 `/187-/190` 诊断）；本插件运行与基线逐字节一致，无插件归因错误 |
| 6a | `dsh web` 启动冒烟 | PASS | 401 auth fence → `?token=` 303 → 认证后 `/` 200（37.9KB）；存活；**无任何 loader 诊断指向本插件**；SIGTERM 优雅退出（<100ms） |
| 6b | 激活对照（故意非法配置） | PASS | `--patch` 注入 `maxParallel: 0` 后启动日志出现 `dsh: warning: 1 entry did not activate` + `dsh-deep-research (@shmming/dsh-deep-research): Error: dsh-deep-research: maxParallel must be a positive integer`（来自 `src/index.js` apply/resolveSettings）→ **证明 apply 在真实 boot 中被执行** |
| 6c | 真实 boot 下的 apply/注册（一次性插桩副本） | PASS | 见 §2.1 trace：模块被 import、`inject` 满足、schemastery 默认值生效、`ctx.tools.get('deep_research')` 可取到已注册工具；交付物 sha256 在插桩前后一致 |
| 7 | 插件显示元数据 + 发布面（新增） | PASS | 官方 `readPluginMeta` 解析出 `title {en:"Deep Research", zh:"深度研究"}`、en/zh description 与 `locale/*.json` 完全一致、icon data URL 解码为 758 字节的 `assets/icon.svg`；4/4 资源解析且都在包根内；`npm pack` 发布面 14 文件、必需 11/11、无 `node_modules/_verify/_ref/test/scripts`；`dsh.manifestVersion=1`、`engines.dsh` 接受 0.2.1-rc.3、patch 行名 = 包名 |

### 2.1 真实 boot 的 apply/注册 trace（一次性插桩副本，非交付物）

`_verify/instrumented-trace.jsonl`：

```json
{"event":"apply","tools":"object","subagents":"object","config":{"childProvider":"spawn","maxParallel":4,"maxTotalAgents":32},"ts":1793271364237}
{"event":"registered","tool":"deep_research","hasOutputSchema":true,"ts":1793271364238}
```

即：loader 导入 ESM 模块 → `inject: ['tools','subagents']` 两个服务在真实 web 组合根部满足 →
schemastery Config 默认值生效 → `ctx.tools.register(defineTool(...))` 执行后该工具可从
`ctx.tools` 解析（带 output schema）。插桩副本位于 `_verify/instrumented`（gitignore，一次性），
交付物 `src/index.js` 在验证前后 sha256 一致（`bc29cbb1…`）。

### 2.2 关于"没有模型调用时如何观测注册"

- web boot 只输出带 token 的 URL；info 级插件日志不会被 boot logger 导出，因此"没有警告"本身
  不足以证明 apply 执行。
- 上述 6b（故意失败 → loader 点名插件并打印 apply 抛出的错误）与 6c（插桩 trace）共同提供了
  **正向**证明；`GET /api/*` 返回 404（`/api` 是 Typert RPC/WebSocket 网关，没有 REST 工具清单）。

## 3. L3 — 规范化打包与真实安装

### 3.1 包身份与清单（作者改为 shmming）

```jsonc
{
  "name": "@shmming/dsh-deep-research",
  "version": "0.2.0",
  "author": "shmming",
  "license": "MIT",
  "repository": { "type": "git", "url": "git+https://github.com/Shmming-86/dsh-deep-research.git" },
  "engines": { "node": "^22.19.0 || >=24.0.0", "dsh": ">=0.2.1-rc.2 <0.3.0" },
  "dsh": { "manifestVersion": 1, "bundle": { "patch": "./cordis.patch.yml" } },
  "icon": "./assets/icon.svg",
  "exports": { ".": { "types": "./types/index.d.ts", "default": "./src/index.js" },
               "./cordis.patch.yml": "./cordis.patch.yml", "./icon": "./assets/icon.svg",
               "./locale/*.json": "./locale/*.json", "./package.json": "./package.json" },
  "files": ["src", "types", "assets", "locale", "cordis.patch.yml", "README.md", "README.zh.md",
            "CHANGELOG.md", "LICENSE", "docs"],
  "publishConfig": { "access": "public" }
}
```

- **显示元数据**：`locale/en.json` + `locale/zh.json`（`meta.title`/`meta.description`）由 DSH 官方
  `readPluginMeta` 解析（不执行插件代码）；icon 由 `package.json.icon`（`assets/icon.svg`）解析为
  data URL。逐字段证据见 [COMPAT.md §6](COMPAT.md)。
- **类型声明**：`types/index.d.ts` 声明 `name`/`inject`/`Config`/`apply`。
- **README**：[README.md](README.md)（英文）与 [README.zh.md](README.zh.md)（中文）均包含
  「基于的原始插件与仓库」章节：原始插件 `@dsh-external/dsh-deep-research` v0.1.0、MIT、
  原始仓库 <https://github.com/omdsh-dev/dsh-deep-research>（本移植所用快照来源；原项目自身
  README 的安装示例指向 <https://github.com/dsh-external/dsh-deep-research>）、版权持有者
  `dsh2026`（依据原 LICENSE）、原项目设计归属，以及本移植的改动说明。
- **CHANGELOG / LICENSE**：`CHANGELOG.md` 记录 0.2.0 的规范化与移植改动；`LICENSE` 同时保留
  shmming 与原项目的 MIT 版权声明（`Copyright (c) 2026 dsh2026`，按 MIT 要求逐字复现）。

### 3.2 发布面（npm pack，离线）

```bash
npm_config_cache=$PWD/_verify/npm-cache npm_config_logs_dir=$PWD/_verify/npm-logs \
  npm pack --dry-run --json --ignore-scripts
```

结果：**14 个文件**（必需 11/11 + `docs/{COMPAT,CONTRACT,VERIFICATION}.md`），不含
`node_modules/`、`_verify/`、`_ref/`、`test/`、`scripts/`。证据：`_verify/npm-pack.json`。

### 3.3 真实安装路径（`dsh plugin add`，非手工 symlink）

```bash
DSH_HOME=$PWD/_verify/install-home dsh --profile drl --from-default-profile web --dump-config
DSH_HOME=$PWD/_verify/install-home dsh plugin --profile drl add link:<repo>
```

- pnpm 12.6.0 安装成功（`add` 退出码 0），profile `package.json` 记录
  `"@shmming/dsh-deep-research": "link:<repo>"`，`dsh.profile.bundles` **自动追加**
  本插件（安装即启用）。
- 该操作走过 DSH 的兼容性预检（`engines.dsh` 满足 0.2.1-rc.3）与 bundle patch 校验。
- 随后 `--dump-config` 出现 `- id: dsh-deep-research / name: '@shmming/dsh-deep-research'`；
  `dsh --profile drl --port 3197 --no-open` 启动成功（401 auth fence、无诊断）。
- 未执行 git URL 安装（仓库尚未发布/无凭据）；`link:` 与 git 安装共用同一 pnpm + bundle-patch +
  兼容性检查路径，仅包来源不同。

## 4. L4 — 独立 API 与打包审计

见 [COMPAT.md](COMPAT.md)。摘要：

- **核心结论**：参考项目使用的 `ctx.workflows` 在 0.2.1-rc.3 已不存在；当前服务是
  `ctx.workflowEngine`，但官方 `web` 组合在根上禁用 `workflow-ptc`，只在 agent preset 的
  `delegation` group 内以 `isolate: { workflowEngine: true }` 提供 —— 根级插件无法注入。
  本移植改用官方 subagent seam（`ctx.subagents.startActivation`，workflow 引擎内部同款 seam）是
  **正确且必要**的。
- 两种 schema 方言各自合法：工具 `parameters`/`output.schema` 用 defineTool DSL（逐属性
  `required: true`、object 必须 `additionalProperties`）；subagent `outputSchema` 用受控
  JSON Schema 子集（object 根、`required: [...]`）。
- 代码审计计数：**OK 36 / RISK 11 / BUG 1（closed）**；rev D 已复验（回退改名文档行即
  `d789c4b7…`）。
- 规范化打包审计（COMPAT §6，55 项）：**OK 50 / RISK 5 / BUG 0**。发现的许可证归属问题
  BUG-P1（原项目 MIT 版权声明未逐字保留）已修复（`LICENSE` 同时保留 shmming 与
  `dsh2026` 的声明）；原始仓库引用 RISK-P05 已按证据澄清（快照来源 omdsh-dev，原 README
  安装示例指向 dsh-external，原 package.json 无 repository 字段）。剩余 5 项为低风险、
  不阻塞发布（详见 COMPAT §6）。

## 5. 验证过程中发现并修复的真实 bug

| # | 严重性 | 发现者 | 现象 | 根因 | 修复（rev） |
|---|---|---|---|---|---|
| BUG-1 | **致命**（工具完全不可用） | compat-auditor | 所有子代理被判失败；`TypeError: activation.dispose is not a function`；每个子代理泄漏未 dispose | `ctx.subagents.startActivation` 返回 `Promise<SubagentActivation>`（`dsh-subagent/lib/types/index.d.ts:145`；impl `async`），旧代码未 `await` | `await ctx.subagents.startActivation({...})`，并处理"发布过程中被取消"与启动失败（rev B） |
| BUG-2 | 高（数据错误） | test-harness | `questions` 参数被双重包装成 `{question:{question:'…'}}`：子代理提示词与报告出现 `[object Object]` | `parseQuestionList` 已返回 `{question}`，调用处又 `map(question => ({ question }))` | `givenQuestions.map(item => ({ ...item }))`（rev C） |
| RISK-05 | 低（潜在掩盖结果） | compat-auditor | 若 `dispose()` 同步抛错，会从 `finally` 逃出并掩盖本次调用结果 | `Promise.resolve(activation.dispose())` 无法捕获同步 throw | `Promise.resolve().then(() => activation.dispose()).catch(() => {})`（rev D） |

修复后回归：单元 20/20；异步 seam/取消/发布期取消/同步抛 dispose 的专项 harness 全部通过；
审计 rev D 复验（反向编辑可逐字节还原 rev C，证明改动唯一）。

## 6. 未覆盖项（明确声明）

- **未做真实模型端到端调用**（0 API 配额消耗）。工具的真实子代理编排、模型路由、web_search
  行为属于 DSH 已测试 seam 的行为；本插件对这些调用的请求形状已用真实 seam 契约与 fake seam
  断言。若需真实验证：把插件装进一个可写 profile，启动 `dsh web`，在会话里说
  「深度调研一下 ……，出一份带引用的报告」，或 `dsh --profile <p> "用 deep_research 调研 ……"`。
- 模型分级（`plannerModel` 等）只验证了请求透传，未验证具体模型的真实响应。
- `maxParallel` 的 live 并发只在单元测试中验证（fake seam 高水位），未在真实子代理上测。
- 未执行 **git URL** 安装与市场（market index）上架验证；仓库尚未发布，`link:` 安装已覆盖
  同一 pnpm + bundle patch + 兼容性检查路径。上架还需要的市场索引字段属于外部清单，
  不在本包内。
- 未添加 `README.i18n.yaml`（DSH 官方仓库的文档流水线用于记录双语 README 的 git blob 配对，
  不是插件运行/加载要求）；若本仓库接入该流水线再加。
- 未验证其它 profile（如 tui/sdk）；本插件依赖根级 `tools` + `subagents`，官方 `web`/`headless`
  模板满足，其它组合需自行确认。

## 7. 复现命令汇总

```bash
cd <repo>

# L1 单元/契约（离线、零依赖、~0.3s）
npm test

# L2 真实 DSH profile（scratch DSH_HOME、无模型调用、无网络）
npm run verify:profile
cat _verify/profile-report.md

# L3 发布面与显示元数据
npm pack --dry-run --json --ignore-scripts | head -40    # 14 files
node -e "..."   # 见 §3.1；官方 readPluginMeta 由验证脚本 check 7 自动执行

# L3 真实安装（scratch home）
DSH_HOME=$PWD/_verify/install-home dsh --profile drl --from-default-profile web --dump-config
DSH_HOME=$PWD/_verify/install-home dsh plugin --profile drl add link:$PWD
DSH_HOME=$PWD/_verify/install-home dsh --profile drl --dump-config | grep -A1 'id: dsh-deep-research'

# L4 审计文档
sed -n '1,60p' docs/COMPAT.md
```
