# @shmming/dsh-deep-research（深度研究插件）

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的**自适应深度研究编排插件**。
它注册一个模型可见工具 `deep_research`：按**控制论 + 信息论**设计的研究闭环——答案空间校准、信息维度覆盖、
信息增益驱动的研究轮次、率失真综合、可选对抗性审查——并通过子代理复用 DSH 内置的 `web_search` / `web_fetch`。

当前目标版本：**DSH 0.2.1-rc.3** · 许可：MIT · 作者：[shmming](https://github.com/Shmming-86)

[English](README.md) | [中文](README.zh.md)

---

## 基于的原始插件与仓库

本项目是已有 DSH 插件的**移植与延续**：

| 项目 | 信息 |
|---|---|
| **原始插件** | `@dsh-external/dsh-deep-research`（版本 `0.1.0`，MIT） |
| **原始仓库** | <https://github.com/omdsh-dev/dsh-deep-research>（本移植所依据的快照来源） |
| **原始版权持有者** | `dsh2026`（依据原项目 `LICENSE`） |
| **原始设计** | 基于当时 DSH workflow 引擎（`ctx.workflows`）的控制论 + 信息论深度研究闭环：规划/研究/综合/审查子代理与三态证据模型 |
| **本仓库** | <https://github.com/Shmming-86/dsh-deep-research>，由 shmming 维护 |
| **本版本** | `0.2.0`，目标 DSH `0.2.1-rc.3` |

本移植依据的快照于 2026-10-29 下载自 `https://github.com/omdsh-dev/dsh-deep-research`；原项目自身 README 的
安装示例指向 `git+https://github.com/dsh-external/dsh-deep-research.git`，且其 package.json 未声明
`repository` 字段，因此两个位置指向同一个原始项目。

原始插件在当前 DSH 上无法直接运行：`ctx.workflows` 已不存在（现在是 `ctx.workflowEngine`），
且官方 `web` 组合把 workflow 引擎隔离在 agent preset 的 delegation group 内
（`isolate: { workflowEngine: true }`），根级插件注入不到。本移植**保留**了原项目的研究设计、提示词、
三态证据模型、自适应闭环与配置面，只把执行底座替换为 workflow 引擎内部同款的**官方 subagent seam**
（`ctx.subagents.startActivation`），因此在 `web` 与 `headless` 的根组合中都能加载；并补齐了测试、
真实 profile 验证与规范化打包。逐项 API 对照见 [docs/COMPAT.md](docs/COMPAT.md)。

原始作者与设计已注明；移植引入的问题由本项目负责。

## 功能

```
apply(ctx, config)
└─ 注册工具 `deep_research`
   ├─ 规划（可跳过）：PLANNER_SCHEMA
   │    scope（答案空间）+ dimensions（信息维度/必要多样性）+ questions[] + coverage_gaps[]
   ├─ 自适应研究闭环（≤ depth+1 轮，每轮 ≤ maxParallel 并发）
   │    researcher → confirmed[] / uncertain[] / gaps[{aspect, priority}]
   │    high-priority 缺口成为下一轮问题（边际信息增益 ≈ 0 时停止）
   │    规划声明的盲区会被定向侦察（绝不静默丢弃）
   ├─ 综合：率失真压缩为带引用的最终报告，保留不确定性
   └─ 审查（可选）：引用抽查、覆盖度审计、矛盾与过度自信标注
```

- 子代理继承父 preset 的工具集（含内置 `web_search` / `web_fetch`），插件自身零网络逻辑。
- `exec.signal` 转发给每个子代理；取消时 dispose 活着的子代理并让工具调用以 abort reason 拒绝。
- `maxTotalAgents` 是单次调用的子代理硬上限（综合/审查名额预留）；未研究的问题记为 `skipped`。
- 单个研究子代理失败只影响该节；规划失败则工具报错并给出可操作提示。

## 环境要求

- DSH `0.2.1-rc.2` … `<0.3.0`（已在 `0.2.1-rc.3` 验证）。
- profile 的**根组合**需提供 `tools` 与 `subagents`（官方 `web`、`headless` 模板满足）；
  未提供 `subagents` 的 profile 会保持该行 pending。

## 安装

```bash
# 从 git 安装（把 <profile> 换成 web / headless / 自建 profile 名）
dsh plugin --profile <profile> add git+https://github.com/Shmming-86/dsh-deep-research.git

# 或 link 本地 checkout（无需 registry/网络）
dsh plugin --profile <profile> add link:/path/to/dsh-deep-research

dsh --profile <profile>    # 重启生效
```

包内声明了 `dsh.bundle.patch`（`cordis.patch.yml`）：只要出现在 `dsh.profile.bundles` 中，
就会自动插入**恰好一行**根级插件行，无需手工接线。

## 使用

工具由模型按描述自动触发，自然语言即可：

- 「深度调研一下 MCP 生态现状，重点对比几家主流实现，出一份带引用的报告」
- 「按这份问题清单做研究：1. … 2. …」（已有清单 → 跳过自动拆解）
- 「调研 A/B 方案，purpose 是决定我们选哪个」（用途越明确，答案空间越准）
- 更严谨传 `depth: 3`；需要引用纠错与覆盖度审计传 `review: true`。

| 参数 | 必填 | 说明 |
|---|---|---|
| `topic` | 是 | 研究主题 |
| `purpose` | 否 | 研究用途（要支撑的判断/决策），用于定义答案空间 |
| `questions` | 否 | 已有问题清单（每行一个，支持 `1.`/`1、`/`- ` 标记）；提供后跳过自动拆解 |
| `depth` | 否 | 1=初步（≤2 轮），2=深入（默认，≤3 轮），3=穷尽（≤4 轮） |
| `synthesize` | 否 | 是否让综合子代理写最终报告（默认 true；false 只返回三态证据） |
| `review` | 否 | 是否做对抗性审查（默认 false） |

输出字段：`ok`、`report`、`review?`、`rounds`、`subquestions`、`completed`、`failed`、`skipped`。

## 配置

全部可选，在 profile 的插件行上覆盖：

```yaml
# profile cordis.patch.yml
- id: dsh-deep-research
  config:
    maxParallel: 6
    researcherModel: deepseek-chat
```

| Key | 默认 | 说明 |
|---|---|---|
| `childProvider` | `spawn` | 子代理 provider |
| `maxParallel` | `4` | 每轮研究并发上限 |
| `maxTotalAgents` | `32` | 单次工具调用的子代理总数上限（综合/审查预留） |
| `plannerModel` / `researcherModel` / `synthesizerModel` / `reviewerModel` | 继承父路由 | 模型分级（`reviewerModel` 缺省回退 `synthesizerModel`） |

## 目录结构

```
dsh-deep-research/
├── package.json          # 插件清单：engines.dsh、dsh.manifestVersion、dsh.bundle.patch、
│                         # 导出 . / cordis.patch.yml / locale/*.json / icon，files、author
├── cordis.patch.yml      # bundle 补丁：插入 id=dsh-deep-research 一行
├── src/index.js          # Cordis 插件（纯 ESM，零构建）
├── types/index.d.ts      # 插件接口类型声明
├── locale/en.json        # 插件显示元数据（meta.title / meta.description）
├── locale/zh.json        # 中文显示元数据
├── assets/icon.svg       # 插件图标（manifest `icon`）
├── test/                 # 离线 node --test 套件（真实 defineTool + 脚本化 async seam）
├── scripts/verify-profile.mjs  # 真实 DSH profile 组合/加载验证
├── docs/                 # CONTRACT.md、COMPAT.md、VERIFICATION.md
├── CHANGELOG.md
└── LICENSE
```

## 符合的 DSH 插件规范

本包遵循 DSH `0.2.1-rc.3` 官方包使用的约定：

- **清单**：`engines.dsh` 声明兼容的 DSH 版本；`dsh.manifestVersion: 1` 与 `dsh.bundle.patch` 声明
  loader 集成；`exports` 覆盖 `.`、`./cordis.patch.yml`、`./locale/*.json`、`./icon`；`files`
  白名单声明发布面；作用域包使用 `publishConfig.access: public`。
- **显示元数据**：`locale/en.json` 与 `locale/zh.json` 提供 `meta.title` / `meta.description`，
  由 DSH 的插件元数据读取器（`readPluginMeta`）在不执行插件代码的前提下解析。
- **图标**：`package.json.icon` 指向 `assets/icon.svg`（SVG，< 256 KiB），同时导出为 `./icon`。
- **组合行**：`cordis.patch.yml` 插入 loader 挂载的唯一一行；用户按相同 `id` 覆盖 `config`。
- **类型声明**：`types/index.d.ts` 描述 `name`、`inject`、`Config`、`apply`。

## 验证

全部验证离线完成（不调用模型、不联网、不修改 `~/.dsh`）：

```bash
npm test                  # node --test test/  → 20/20 PASS
npm run verify:profile    # 真实 DSH profile    → 9/9 PASS
```

- **单元/契约测试**（`test/`）：用安装版真实 `defineTool` 编译工具定义并校验注册；显式问题清单路径；
  自适应 gap 闭环；规划 + 盲区侦察；并发高水位；预算核算；两条取消路径；错误隔离；参数/配置校验；
  配置透传。
- **真实 profile 验证**（`scripts/verify-profile.mjs`）：一次性 `DSH_HOME` + 官方 `web` 模板；
  `--dump-config` 显示 bundle patch 插入**恰好一行**；`--dump-config-schema` 真实 import 并投影
  Config schema；`dsh web` 启动冒烟；故意非法配置的激活对照 + 一次性插桩副本证明 `apply()` 真实执行、
  `deep_research` 已注册；官方 `readPluginMeta` 解析 en/zh 显示元数据与图标；`npm pack --dry-run`
  确认 14 文件发布面；并已走通真实 `dsh plugin add link:` 安装路径。
- **独立 API 审计**（[docs/COMPAT.md](docs/COMPAT.md)）：代码审计 OK 36 / RISK 11（1 项已关闭）/
  BUG 1（发现、修复、复验）；规范化打包审计 55 项 → OK 50 / RISK 5 / BUG 0，唯一必须修复项
  （原项目 MIT 版权声明）已修复关闭。
- 完整报告：[docs/VERIFICATION.md](docs/VERIFICATION.md)。

## 开发

```bash
npm test                  # 离线单元/契约测试
npm run verify:profile    # profile 级验证（工作区内 _verify/ scratch DSH_HOME）
```

`test/` 与 `scripts/` 属于仓库 checkout：它们有意不进入 npm 发布包（`files` 白名单），请从 git clone 运行。

需要 Node `>= 22.19`（或 `>= 24`），无构建步骤；profile 验证需要本机 `dsh` 与已安装的
`@deepseek-ai/*` 包，且不会修改 `~/.dsh`。

## 许可

MIT，见 [LICENSE](LICENSE)。

变更历史见 [CHANGELOG.md](CHANGELOG.md)。

## 致谢

- 原始插件与设计：**`@dsh-external/dsh-deep-research`**（MIT，Copyright (c) 2026 `dsh2026`） —
  <https://github.com/omdsh-dev/dsh-deep-research>。
- DeepSeek Harness 及其插件平台：<https://github.com/deepseek-ai/deepseek-harness>。
