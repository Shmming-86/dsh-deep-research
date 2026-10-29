/**
 * Offline unit tests for `@shmming/dsh-deep-research` on DSH 0.2.1-rc.3.
 *
 * Run: cd /data/code/dsh-plugin && node --test test/
 *
 * The tool definition is compiled by the *real* `defineTool` from the installed
 * `@deepseek-ai/dsh-tools` package (see helpers/link-deps.mjs), and children are
 * served by a scripted fake `ctx.subagents.startActivation` (helpers/fake-context.mjs).
 * Zero network / model API calls; no test may hang (blocking awaits are wrapped).
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  DEFER,
  createFakeContext,
  delay,
  errorResult,
  makeExec,
  runTool,
  structuredResult,
  textResult,
  waitFor,
  withTimeout,
} from './helpers/fake-context.mjs'
import { loadPlugin } from './helpers/load-plugin.mjs'

const { plugin, dshTools, versions } = await loadPlugin()
const { validateJsonSchemaValue } = dshTools

const RESEARCH_LABEL = /^研究·第\d+轮·\d+$/

/** Apply the plugin on a fresh fake context and return the registered tool. */
function setup(config = {}, options = {}) {
  const ctx = createFakeContext(options)
  plugin.apply(ctx, config)
  return ctx
}

/** Planner child result with the contract's structured shape. */
function plannerResult(overrides = {}) {
  return structuredResult({
    scope: '测试答案空间',
    dimensions: ['维度一'],
    questions: [{ question: '规划问题一', dimension: '维度一' }],
    coverage_gaps: [],
    ...overrides,
  }, '规划完成')
}

/** Researcher child result with the contract's three-state evidence shape. */
function researcherResult({ confirmed = [], uncertain = [], gaps = [] } = {}) {
  return structuredResult({ confirmed, uncertain, gaps }, '研究完成')
}

/** Contract accounting identity for research questions. */
function assertAccounting(result) {
  assert.equal(
    result.completed + result.failed + result.skipped,
    result.subquestions,
    'completed + failed + skipped must equal subquestions',
  )
}

/** Assert a canonical value satisfies the registered output schema. */
function assertOutputValid(tool, value) {
  const violations = validateJsonSchemaValue(tool.output.schema, value, '')
  assert.deepEqual(violations, [], `output violates the declared schema: ${JSON.stringify(violations)}`)
}

/** Assert every activation recorded the frozen request contract. */
function assertActivationRequests(ctx, exec, provider = 'spawn') {
  for (const record of ctx.activations) {
    assert.equal(record.provider, provider, `${record.label}: provider`)
    assert.equal(record.delivery, 'caller', `${record.label}: delivery`)
    assert.equal(record.signal, exec.signal, `${record.label}: signal must be exec.signal`)
    assert.equal(record.request.parent, exec.agent, `${record.label}: request.parent must be exec.agent`)
    assert.deepEqual(
      record.request.prompt,
      [{ type: 'text', text: record.promptText }],
      `${record.label}: request.prompt must be one text block`,
    )
  }
}

// ── Registration ─────────────────────────────────────────────────────────────

test('registration: real defineTool compiles the tool and the exports match the contract', () => {
  assert.equal(plugin.name, 'dsh-deep-research')
  assert.deepEqual(plugin.inject, ['tools', 'subagents'])
  assert.equal(typeof plugin.apply, 'function')
  assert.equal(typeof dshTools.defineTool, 'function')
  assert.equal(versions['dsh-tools'], '0.2.1-rc.3', 'tests must compile against the installed 0.2.1-rc.3 dsh-tools')

  // Config is a real schemastery schema carrying the contract defaults.
  assert.equal(typeof plugin.Config, 'function')
  assert.ok(plugin.Config['~standard'] !== undefined, 'Config must be a schemastery schema')
  const defaults = plugin.Config({})
  assert.equal(defaults.childProvider, 'spawn')
  assert.equal(defaults.maxParallel, 4)
  assert.equal(defaults.maxTotalAgents, 32)

  const ctx = setup()
  assert.equal(ctx.registrations.length, 1, 'apply must register exactly one tool')
  const tool = ctx.tool
  assert.equal(tool.name, 'deep_research')

  // Parameters were compiled by the real defineTool: topic is the only required one.
  assert.equal(tool.parameters.type, 'object')
  assert.deepEqual(tool.parameters.required, ['topic'])
  assert.deepEqual(
    Object.keys(tool.parameters.properties).sort(),
    ['depth', 'purpose', 'questions', 'review', 'synthesize', 'topic'],
  )
  assert.equal(tool.parameters.properties.topic.type, 'string')
  assert.equal(tool.parameters.properties.depth.type, 'number')
  assert.equal(tool.parameters.properties.synthesize.type, 'boolean')
  assert.equal(tool.parameters.properties.review.type, 'boolean')

  // Output schema: object-rooted, closed, exactly the contract fields.
  const schema = tool.output.schema
  assert.equal(schema.type, 'object')
  assert.equal(schema.additionalProperties, false)
  assert.deepEqual(
    Object.keys(schema.properties).sort(),
    ['completed', 'failed', 'ok', 'report', 'review', 'rounds', 'skipped', 'subquestions'],
  )
  assert.deepEqual([...schema.required].sort(), ['ok', 'report'])
  assert.equal(schema.properties.ok.type, 'boolean')
  assert.equal(schema.properties.report.type, 'string')
  for (const key of ['rounds', 'subquestions', 'completed', 'failed', 'skipped']) {
    assert.equal(schema.properties[key].type, 'number', `${key} must be a number`)
  }

  // A canonical contract value validates; an unknown field does not.
  const canonical = { ok: true, report: 'r', rounds: 1, subquestions: 1, completed: 1, failed: 0, skipped: 0 }
  assertOutputValid(tool, canonical)
  assert.deepEqual(validateJsonSchemaValue(schema, canonical, ''), [])
  assert.ok(validateJsonSchemaValue(schema, { ok: true, report: 'r', unknownField: 1 }, '').length > 0)

  // render(): report, plus review when present; failure text names the tool.
  assert.deepEqual(tool.output.render({ topic: 't' }, { ok: true, report: 'REPORT' }), [
    { type: 'text', text: 'REPORT' },
  ])
  assert.deepEqual(tool.output.render({ topic: 't' }, { ok: true, report: 'REPORT', review: 'REVIEW' }), [
    { type: 'text', text: 'REPORT\n\nREVIEW' },
  ])
  assert.match(tool.output.render({ topic: 't' }, { ok: false, report: 'boom' })[0].text, /deep_research/)

  // The old workflows API must not be touched, and a logger-less ctx is fine.
  assert.equal(ctx.accessed.workflows, 0, 'plugin must not use ctx.workflows')
})

// ── Execute with an explicit question list ───────────────────────────────────

test('execute with questions: planner skipped, one researcher per question, synthesizer runs', async () => {
  const ctx = setup()
  ctx.script({ label: RESEARCH_LABEL, respond: () => researcherResult({ confirmed: [{ claim: '证据甲', source: 'https://a.test', confidence: 'high' }] }) })
  ctx.script({ label: '综合', respond: () => textResult('综合报告MARK') })
  const exec = makeExec()

  const result = await runTool(tool(ctx), { topic: '测试主题', questions: '1. 问题甲\n2、问题乙' }, exec)

  assert.equal(result.ok, true)
  assert.equal(result.rounds, 1)
  assert.equal(result.subquestions, 2)
  assert.equal(result.completed, 2)
  assert.equal(result.failed, 0)
  assert.equal(result.skipped, 0)
  assert.equal(result.review, undefined)
  assertAccounting(result)
  assertOutputValid(ctx.tool, result)

  assert.equal(ctx.labelCount('规划'), 0, 'questions given -> planner must be skipped')
  assert.deepEqual(ctx.activationLabels(), ['研究·第1轮·1', '研究·第1轮·2', '综合'])

  assertActivationRequests(ctx, exec)
  const researchers = ctx.activations.filter(record => RESEARCH_LABEL.test(record.label))
  assert.equal(researchers.length, 2, 'exactly one researcher child per question')
  assert.ok(researchers.every(record => record.outputSchema?.type === 'object'), 'researchers request RESEACHER_SCHEMA')
  assert.equal(researchers.filter(record => record.promptText.includes('问题甲')).length, 1)
  assert.equal(researchers.filter(record => record.promptText.includes('问题乙')).length, 1)
  assert.ok(researchers.every(record => !record.promptText.includes('1. 问题甲')))
  assert.ok(researchers.every(record => !record.promptText.includes('2、问题乙')))

  // Report structure from the contract: the synthesized report leads, the raw
  // evidence (with its own header) is appended as an appendix.
  assert.match(result.report, /^综合报告MARK/, 'the synthesized report leads the result')
  assert.match(result.report, /## 附录：原始证据状态/, 'the raw evidence is appended as an appendix')
  assert.ok(
    result.report.includes('# 测试主题 — 深度研究中间结果（证据状态）'),
    'the appendix carries the evidence header',
  )
  assert.match(result.report, /问题甲/)
  assert.match(result.report, /问题乙/)
  assert.match(result.report, /证据甲/)

  // render() must surface the report (no review requested).
  assert.equal(ctx.tool.output.render({ topic: '测试主题' }, result)[0].text, result.report)

  // Every activation is disposed exactly once once execute resolves.
  await waitFor(() => ctx.activations.every(record => record.disposed), { timeout: 500 })
  assert.equal(ctx.disposalCount, ctx.activations.length)
  assert.ok(ctx.activations.every(record => record.disposeCount === 1))
})

// ── Adaptive loop ────────────────────────────────────────────────────────────

test('adaptive loop: a high-priority gap becomes a second-round follow-up child', async () => {
  const ctx = setup()
  ctx.script({
    label: RESEARCH_LABEL,
    respond: record => record.promptText.includes('缺口ALPHA')
      ? researcherResult()
      : researcherResult({ gaps: [{ aspect: '缺口ALPHA', priority: 'high' }] }),
  })
  ctx.script({ label: '综合', respond: () => textResult('综合报告') })
  const exec = makeExec()

  const result = await runTool(tool(ctx), { topic: '测试主题', questions: '问题甲' }, exec)

  assert.equal(result.rounds, 2, 'a high-priority gap must trigger a second research round')
  assert.equal(result.subquestions, 2, 'the follow-up question is a research question')
  assert.equal(result.completed, 2)
  assert.equal(result.failed, 0)
  assert.equal(result.skipped, 0)
  assertAccounting(result)
  assertOutputValid(ctx.tool, result)

  assert.deepEqual(ctx.activationLabels(), ['研究·第1轮·1', '研究·第2轮·1', '综合'])
  const followUp = ctx.activations.find(record => record.label === '研究·第2轮·1')
  assert.match(followUp.promptText, /缺口ALPHA/, 'the follow-up prompt targets the reported gap')
  assert.match(result.report, /缺口ALPHA/, 'the follow-up question appears in the report')

  await waitFor(() => ctx.activations.every(record => record.disposed), { timeout: 500 })
  assert.equal(ctx.disposalCount, ctx.activations.length)
})

// ── Planner path ─────────────────────────────────────────────────────────────

test('planner path: object-rooted planner schema, blind-spot recon, answer space in report', async () => {
  const ctx = setup()
  let plannerSchema
  ctx.script({
    label: '规划',
    respond: record => {
      plannerSchema = record.outputSchema
      return plannerResult({
        scope: 'SCOPE_MARK_答案空间',
        dimensions: ['背景', '技术'],
        questions: [{ question: '规划问题P1', dimension: '背景', keywords: 'kw', acceptance: 'acc' }],
        coverage_gaps: ['盲区G1'],
      })
    },
  })
  ctx.script({ label: RESEARCH_LABEL, respond: () => researcherResult() })
  ctx.script({ label: '综合', respond: () => textResult('综合报告') })
  const exec = makeExec()

  const result = await runTool(tool(ctx), { topic: '规划主题', purpose: '支撑决策PURPOSE' }, exec)

  // The planner child was asked with the object-rooted PLANNER_SCHEMA.
  assert.equal(ctx.labelCount('规划'), 1)
  const plannerRecord = ctx.activations.find(record => record.label === '规划')
  assert.match(plannerRecord.promptText, /规划主题/)
  assert.match(plannerRecord.promptText, /PURPOSE/, 'purpose is part of the answer-space definition')
  assert.equal(plannerSchema.type, 'object')
  assert.equal(plannerSchema.additionalProperties, false)
  assert.deepEqual([...plannerSchema.required].sort(), ['coverage_gaps', 'dimensions', 'questions', 'scope'])
  for (const key of ['scope', 'dimensions', 'questions', 'coverage_gaps']) {
    assert.ok(plannerSchema.properties[key] !== undefined, `planner schema property ${key}`)
  }
  assert.deepEqual(plannerSchema.properties.questions.items.required, ['question', 'dimension'])
  assert.equal(plannerSchema.properties.coverage_gaps.type, 'array')

  // coverage_gaps become blind-spot reconnaissance questions, in the same round.
  const researchers = ctx.activations.filter(record => RESEARCH_LABEL.test(record.label))
  assert.equal(researchers.length, 2, 'planned question + blind-spot recon')
  assert.ok(researchers.some(record => record.promptText.includes('规划问题P1')))
  assert.ok(
    researchers.some(record => record.promptText.includes('盲区G1') && record.promptText.includes('盲区假设')),
    'blind spot must be queued as a recon question, never silently dropped',
  )
  assert.equal(result.rounds, 1)
  assert.equal(result.subquestions, 2)
  assert.equal(result.completed, 2)
  assert.equal(result.skipped, 0)
  assertAccounting(result)
  assertOutputValid(ctx.tool, result)

  // The planner's answer space is preserved in the report.
  assert.match(result.report, /研究答案空间/)
  assert.match(result.report, /SCOPE_MARK_答案空间/)
  assert.match(result.report, /盲区G1/)

  await waitFor(() => ctx.activations.every(record => record.disposed), { timeout: 500 })
  assert.equal(ctx.disposalCount, ctx.activations.length)
})

// ── Concurrency bound ────────────────────────────────────────────────────────

test('maxParallel: 6 questions with maxParallel 2 never exceed 2 concurrent children but all get studied', async () => {
  const ctx = setup({ maxParallel: 2 })
  ctx.script({
    label: RESEARCH_LABEL,
    respond: async () => {
      // Hold the activation open so overlap is observable.
      await delay(10)
      return researcherResult({ confirmed: [{ claim: '结论', source: 'https://x.test', confidence: 'high' }] })
    },
  })
  ctx.script({ label: '综合', respond: () => textResult('综合报告') })
  const questions = ['问题1', '问题2', '问题3', '问题4', '问题5', '问题6'].join('\n')

  const result = await runTool(tool(ctx), { topic: '并行主题', questions }, makeExec())

  assert.ok(ctx.highWater <= 2, `maxParallel violated: high-water was ${ctx.highWater}`)
  assert.equal(ctx.highWater, 2, 'the test must actually observe concurrency (2)')
  const researchers = ctx.activations.filter(record => RESEARCH_LABEL.test(record.label))
  assert.equal(researchers.length, 6, 'every question must be studied across rounds')
  for (const question of ['问题1', '问题2', '问题3', '问题4', '问题5', '问题6']) {
    assert.ok(researchers.some(record => record.promptText.includes(question)), `${question} never researched`)
  }
  assert.equal(result.rounds, 3, '6 questions at 2 per round take 3 rounds (depth 2 allows depth+1=3)')
  assert.equal(result.subquestions, 6)
  assert.equal(result.completed, 6)
  assert.equal(result.failed, 0)
  assert.equal(result.skipped, 0)
  assertAccounting(result)

  await waitFor(() => ctx.activations.every(record => record.disposed), { timeout: 500 })
  assert.equal(ctx.disposalCount, ctx.activations.length)
})

// ── Hard budget cap ──────────────────────────────────────────────────────────

test('maxTotalAgents: hard cap respected, remaining questions reported as skipped', async () => {
  const ctx = setup({ maxTotalAgents: 3 })
  ctx.script({ label: RESEARCH_LABEL, respond: () => researcherResult() })
  ctx.script({ label: '综合', respond: () => textResult('综合报告') })
  const questions = ['问题1', '问题2', '问题3', '问题4', '问题5', '问题6'].join('\n')

  const result = await runTool(tool(ctx), { topic: '预算主题', questions }, makeExec())

  assert.ok(ctx.activations.length <= 3, `maxTotalAgents overrun: ${ctx.activations.length} activations started with cap 3`)
  assert.ok(result.skipped > 0, 'unconsumed questions must be reported as skipped, never silent')
  assert.equal(result.subquestions, 6)
  assert.equal(result.failed, 0)
  assert.equal(result.completed, 6 - result.skipped)
  assertAccounting(result)
  assert.equal(result.ok, true)
  assert.ok(result.report.length > 0)
  assertOutputValid(ctx.tool, result)

  const researchers = ctx.activations.filter(record => RESEARCH_LABEL.test(record.label))
  assert.equal(researchers.length, result.completed + result.failed, 'every started researcher is accounted for')
})

// ── Async seam ───────────────────────────────────────────────────────────────

test('seam: plugin awaits the Promise-returning startActivation and succeeds', async () => {
  // publicationDelayMs makes the helper return the activation only on a later
  // tick, exactly like SubagentRuntime.startActivation's Promise.
  const ctx = setup({}, { publicationDelayMs: 2 })
  ctx.script({ label: '规划', respond: () => plannerResult() })
  ctx.script({ label: RESEARCH_LABEL, respond: () => researcherResult({ confirmed: [{ claim: '证据', source: 'https://s.test', confidence: 'high' }] }) })
  ctx.script({ label: '综合', respond: () => textResult('综合报告') })

  const result = await runTool(tool(ctx), { topic: '异步 seam 主题' }, makeExec())

  assert.equal(result.ok, true, 'the run must succeed when startActivation returns a Promise')
  assert.deepEqual(ctx.activationLabels(), ['规划', '研究·第1轮·1', '综合'])
  assert.equal(ctx.activationCount, 3)
  assert.match(result.report, /综合报告/)
  await waitFor(() => ctx.activations.every(record => record.disposed), { timeout: 500 })
  assert.equal(ctx.disposalCount, ctx.activationCount, 'every activation disposed exactly once')
  assert.ok(ctx.activations.every(record => record.disposeCount === 1))
})

// ── Cancellation ─────────────────────────────────────────────────────────────

test('cancellation: abort mid-run rejects with the abort reason and disposes every activation', async () => {
  const ctx = setup({ maxParallel: 2 })
  ctx.script({ label: RESEARCH_LABEL, respond: () => DEFER })
  const controller = new AbortController()
  const abortReason = new Error('TEST_ABORT_REASON')
  const exec = makeExec({ signal: controller.signal })

  const unhandled = []
  const onUnhandled = error => unhandled.push(error)
  process.on('unhandledRejection', onUnhandled)
  try {
    const promise = runTool(tool(ctx), { topic: '取消主题', questions: '问题1\n问题2' }, exec)
    await waitFor(() => ctx.activations.length >= 1, { timeout: 1000, message: 'no child activation started' })
    assert.ok(ctx.activations.every(record => record.signal === controller.signal), 'signal forwarded to every child')

    controller.abort(abortReason)

    const outcome = await withTimeout(
      promise.then(value => ({ value }), error => ({ error })),
      2000,
      'deep_research did not settle after abort',
    )
    assert.ok(outcome.error !== undefined, 'the tool call must reject on abort, not resolve')
    assert.equal(outcome.error, abortReason, 'the tool call must reject with the abort reason')

    await waitFor(() => ctx.activations.every(record => record.disposed), {
      timeout: 1000,
      message: 'an activation was not disposed after abort',
    })
    assert.equal(ctx.disposalCount, ctx.activations.length)
    assert.ok(ctx.activations.every(record => record.disposeCount === 1), 'dispose() must not be called twice per activation')

    await delay(25) // let any stray unhandled rejection surface
    assert.deepEqual(unhandled, [], 'abort must not produce unhandled rejections')
  } finally {
    process.off('unhandledRejection', onUnhandled)
    ctx.disposeAll()
  }
})

test('cancellation during activation publication rejects with the abort reason', async () => {
  // The seam is still publishing the child when the abort lands: it cannot be
  // observed by an abort listener attached after `await startActivation`.
  const ctx = setup({ maxParallel: 1 }, { publicationDelayMs: 20 })
  ctx.script({ label: RESEARCH_LABEL, respond: () => DEFER })
  const controller = new AbortController()
  const abortReason = new Error('TEST_PUBLICATION_ABORT')
  const exec = makeExec({ signal: controller.signal })
  const abortTimer = setTimeout(() => controller.abort(abortReason), 5)

  const unhandled = []
  const onUnhandled = error => unhandled.push(error)
  process.on('unhandledRejection', onUnhandled)
  try {
    const outcome = await withTimeout(
      runTool(tool(ctx), { topic: '发布期取消', questions: '问题1' }, exec)
        .then(value => ({ value }), error => ({ error })),
      2000,
      'deep_research did not settle after abort-during-publication',
    )
    assert.ok(outcome.error !== undefined, 'abort during publication must reject the tool call')
    assert.equal(outcome.error, abortReason)

    await waitFor(() => ctx.activations.every(record => record.disposed), {
      timeout: 1000,
      message: 'activation published after abort was not disposed',
    })
    assert.equal(ctx.disposalCount, ctx.activationCount)
    assert.ok(ctx.activations.every(record => record.disposeCount === 1))
    await delay(25)
    assert.deepEqual(unhandled, [], 'abort during publication must not produce unhandled rejections')
  } finally {
    clearTimeout(abortTimer)
    process.off('unhandledRejection', onUnhandled)
    ctx.disposeAll()
  }
})

// ── Error isolation ──────────────────────────────────────────────────────────

test('error isolation: a failed researcher is marked failed while the report is still produced', async () => {
  const ctx = setup()
  ctx.script({
    label: RESEARCH_LABEL,
    respond: record => record.promptText.includes('问题ERR')
      ? errorResult('模拟失败')
      : researcherResult({ confirmed: [{ claim: '证据OK', source: 'https://ok.test', confidence: 'high' }] }),
  })
  ctx.script({ label: '综合', respond: () => textResult('综合报告') })

  const result = await runTool(tool(ctx), { topic: '错误主题', questions: '问题OK\n问题ERR' }, makeExec())

  assert.equal(result.ok, true, 'one failed child must not fail the whole tool call')
  assert.equal(result.completed, 1)
  assert.equal(result.failed, 1)
  assert.equal(result.skipped, 0)
  assert.equal(result.rounds, 1)
  assertAccounting(result)
  assertOutputValid(ctx.tool, result)
  assert.match(result.report, /问题ERR/, 'the failed question still gets a section')
  assert.match(result.report, /失败/, 'the section is marked failed')
  assert.match(result.report, /证据OK/, 'successful evidence is preserved')
})

test('planner failure rejects the tool call and starts no research child', async () => {
  const ctx = setup()
  ctx.script({ label: '规划', respond: () => errorResult('planner boom') })

  await assert.rejects(runTool(tool(ctx), { topic: '规划失败主题' }, makeExec()), /规划/)
  assert.equal(ctx.labelCount('规划'), 1)
  assert.equal(ctx.activations.filter(record => RESEARCH_LABEL.test(record.label)).length, 0)
})

test('planner completed without a structured result rejects the tool call', async () => {
  const ctx = setup()
  ctx.script({ label: '规划', respond: () => textResult('不是 JSON') })

  await assert.rejects(runTool(tool(ctx), { topic: '规划无结构' }, makeExec()), /规划/)
  assert.equal(ctx.activations.filter(record => RESEARCH_LABEL.test(record.label)).length, 0)
})

// ── Validation ───────────────────────────────────────────────────────────────

test('validation: blank topic and out-of-range depth are rejected before any activation', async () => {
  const ctx = setup()

  await assert.rejects(runTool(tool(ctx), { topic: '   ' }, makeExec()), /topic/)
  await assert.rejects(runTool(tool(ctx), { topic: 't', depth: 4 }, makeExec()), /dsh-deep-research:/)
  await assert.rejects(runTool(tool(ctx), { topic: 't', depth: 0 }, makeExec()), /dsh-deep-research:/)
  assert.equal(ctx.activations.length, 0, 'validation must happen before any child activation')
})

test('validation: execute without exec.agent rejects before any activation', async () => {
  const ctx = setup()
  const signal = new AbortController().signal

  await assert.rejects(ctx.tool.execute({ topic: 't' }, { signal }), /agent/)
  assert.equal(ctx.activations.length, 0)
})

test('questions parsing: leading "1." / "1、" numbering markers are stripped', async () => {
  const ctx = setup()
  ctx.script({ label: RESEARCH_LABEL, respond: () => researcherResult() })
  ctx.script({ label: '综合', respond: () => textResult('综合报告') })

  await runTool(tool(ctx), { topic: '解析主题', questions: '1. 问题甲\n2、问题乙\n\n   \n' }, makeExec())

  const researchers = ctx.activations.filter(record => RESEARCH_LABEL.test(record.label))
  assert.equal(researchers.length, 2, 'blank lines must not create questions')
  assert.ok(researchers.some(record => record.promptText.includes('问题甲')))
  assert.ok(researchers.some(record => record.promptText.includes('问题乙')))
  assert.ok(researchers.every(record => !record.promptText.includes('1. 问题甲')))
  assert.ok(researchers.every(record => !record.promptText.includes('2、问题乙')))
})

// ── synthesize / review flags ────────────────────────────────────────────────

test('review: true runs the reviewer and returns its text in result.review', async () => {
  const ctx = setup()
  ctx.script({ label: RESEARCH_LABEL, respond: () => researcherResult() })
  ctx.script({ label: '综合', respond: () => textResult('综合报告') })
  ctx.script({ label: '审查', respond: () => textResult('审查意见MARK') })

  const result = await runTool(tool(ctx), { topic: '审查主题', questions: '问题甲', review: true }, makeExec())

  assert.equal(ctx.labelCount('审查'), 1)
  assert.equal(typeof result.review, 'string')
  assert.match(result.review, /审查意见MARK/)
  assertOutputValid(ctx.tool, result)
  assert.equal(
    ctx.tool.output.render({ topic: '审查主题' }, result)[0].text,
    `${result.report}\n\n${result.review}`,
  )
})

test('synthesize: false skips the synthesizer and returns evidence only', async () => {
  const ctx = setup()
  ctx.script({
    label: RESEARCH_LABEL,
    respond: () => researcherResult({ confirmed: [{ claim: '证据甲', source: 'https://a.test', confidence: 'high' }] }),
  })

  const result = await runTool(tool(ctx), { topic: '证据主题', questions: '问题甲', synthesize: false }, makeExec())

  assert.equal(ctx.labelCount('综合'), 0, 'synthesize:false must not start a synthesizer child')
  assert.equal(result.ok, true)
  assert.equal(result.review, undefined)
  // Contract: without synthesis the evidence markdown itself is the report.
  assert.ok(result.report.startsWith('# 证据主题 — 深度研究中间结果（证据状态）'))
  assert.ok(!result.report.includes('## 附录：原始证据状态'), 'no appendix without a synthesized report')
  assert.match(result.report, /问题甲/)
  assert.match(result.report, /证据甲/)
  assertAccounting(result)
  assertOutputValid(ctx.tool, result)
})

// ── Config forwarding + validation ───────────────────────────────────────────

test('config: childProvider and role model overrides are forwarded to activation requests', async () => {
  const ctx = setup({
    childProvider: 'fork',
    plannerModel: 'planner-m',
    researcherModel: 'researcher-m',
    synthesizerModel: 'synth-m',
  })
  ctx.script({ label: '规划', respond: () => plannerResult() })
  ctx.script({ label: RESEARCH_LABEL, respond: () => researcherResult() })
  ctx.script({ label: '综合', respond: () => textResult('综合报告') })
  const exec = makeExec()

  await runTool(tool(ctx), { topic: '配置主题' }, exec)

  assertActivationRequests(ctx, exec, 'fork')
  assert.equal(ctx.activations.find(record => record.label === '规划').model, 'planner-m')
  for (const record of ctx.activations.filter(item => RESEARCH_LABEL.test(item.label))) {
    assert.equal(record.model, 'researcher-m', 'research children use researcherModel')
  }
  assert.equal(ctx.activations.find(record => record.label === '综合').model, 'synth-m')
})

test('config: reviewerModel falls back to synthesizerModel when unset', async () => {
  const ctx = setup({ synthesizerModel: 'synth-m' })
  ctx.script({ label: RESEARCH_LABEL, respond: () => researcherResult() })
  ctx.script({ label: '综合', respond: () => textResult('综合报告') })
  ctx.script({ label: '审查', respond: () => textResult('审查意见') })

  await runTool(tool(ctx), { topic: '回退主题', questions: '问题甲', review: true }, makeExec())

  assert.equal(ctx.activations.find(record => record.label === '审查').model, 'synth-m')
})

test('Config validation: invalid maxParallel / maxTotalAgents are rejected before registration', () => {
  for (const config of [
    { maxParallel: 0 },
    { maxParallel: -1 },
    { maxParallel: 1.5 },
    { maxTotalAgents: 0 },
    { maxTotalAgents: -2 },
  ]) {
    const ctx = createFakeContext()
    assert.throws(
      () => plugin.apply(ctx, config),
      error => error instanceof Error && error.message.startsWith('dsh-deep-research:'),
      `expected a dsh-deep-research: error for ${JSON.stringify(config)}`,
    )
    assert.equal(ctx.registrations.length, 0, 'nothing may be registered when config is invalid')
  }
})

// ── Helper access ───────────────────────────────────────────────────────────

/** The registered tool of a fake context (readable shorthand). */
function tool(ctx) {
  return ctx.tool
}
