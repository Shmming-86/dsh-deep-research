/**
 * Fake cordis context for offline unit tests of `dsh-deep-research`.
 *
 * It provides exactly the two seams the plugin injects:
 *   - `ctx.tools.register(tool)`  — records the compiled tool definition.
 *   - `ctx.subagents.startActivation(spec)` — scripted child activations.
 *
 * Every activation is matched against registered scripts by child label and/or
 * prompt substring. A script supplies the child's result, either directly, from
 * an async function, or as {@link DEFER} (the result stays pending until the
 * activation is disposed or released manually — needed for cancellation tests).
 *
 * The fake records everything the contract promises about a child call:
 * provider, label, delivery, signal, request.parent, prompt text, the requested
 * output schema, agentOptions/model, plus concurrency high-water (activations
 * whose result has not settled) and per-activation disposal counts.
 *
 * No timers are left behind: deferred activations settle when disposed.
 */

/** Sentinel returned by a script to keep the activation's result pending. */
export const DEFER = Symbol.for('fake-context.defer')

/** Promise-based sleep used to force observable overlap between activations. */
export function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Poll `predicate` until it is truthy or `timeout` elapses.
 * @param {() => boolean | Promise<boolean>} predicate
 * @param {{ timeout?: number, interval?: number, message?: string }} [options]
 */
export async function waitFor(predicate, options = {}) {
  const timeout = options.timeout ?? 1000
  const interval = options.interval ?? 5
  const deadline = Date.now() + timeout
  for (;;) {
    if (await predicate()) return
    if (Date.now() >= deadline) {
      throw new Error(options.message ?? `waitFor timed out after ${timeout}ms`)
    }
    await delay(interval)
  }
}

/**
 * Race a promise against a timeout so a broken implementation fails loudly
 * instead of hanging the test suite.
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} label
 * @returns {Promise<T>}
 */
export function withTimeout(promise, ms, label) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: timed out after ${ms}ms`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/** Build a tool execution context (`exec`) with a real AbortSignal. */
export function makeExec(options = {}) {
  const controller = new AbortController()
  const signal = options.signal ?? controller.signal
  return {
    agent: Object.hasOwn(options, 'agent') ? options.agent : { id: 'fake-parent-agent' },
    signal,
    controller: options.signal === undefined ? controller : undefined,
  }
}

/** Invoke a registered tool definition through the real `defineTool` wrapper. */
export function runTool(tool, args, exec = makeExec()) {
  return tool.execute(args, exec)
}

/** Turn a plain string into the ContentBlock[] shape providers return. */
export function textBlocks(text) {
  return [{ type: 'text', text }]
}

/** A successful text child result. */
export function textResult(text) {
  return { stopReason: 'completed', output: textBlocks(text) }
}

/** A successful structured child result. */
export function structuredResult(structured, text = '') {
  return { stopReason: 'completed', output: textBlocks(text), structured }
}

/** A failed child result. */
export function errorResult(diagnostic) {
  return {
    stopReason: 'error',
    output: [],
    ...(diagnostic === undefined ? {} : { diagnostic }),
  }
}

/**
 * Create a fake cordis context.
 * @param {{
 *   logger?: boolean,
 *   defaultText?: string,
 *   publicationDelayMs?: number,
 * }} [options] - `logger: true` adds a recording `ctx.logger`; by default no
 *   logger exists at all, which the implementation must tolerate. The seam is
 *   modelled faithfully as async: `startActivation` resolves after a tick (the
 *   real `SubagentRuntime.startActivation` returns `Promise<SubagentActivation>`).
 */
export function createFakeContext(options = {}) {
  const publicationDelayMs = options.publicationDelayMs ?? 1
  /** @type {Array<Record<string, unknown>>} */
  const registrations = []
  /** @type {any[]} */
  const activations = []
  /** @type {any[]} */
  const scripts = []
  /** @type {any[]} */
  const events = []
  /** @type {any[]} */
  const logs = []
  const accessed = { workflows: 0 }

  let active = 0
  let highWater = 0
  let activationSeq = 0

  const matchScript = (script, record) => {
    if (script.provider !== undefined && script.provider !== record.provider) return false
    if (script.label !== undefined) {
      const matched = typeof script.label === 'string'
        ? script.label === record.label
        : script.label instanceof RegExp && script.label.test(record.label)
      if (!matched) return false
    }
    if (script.promptIncludes !== undefined) {
      const needles = Array.isArray(script.promptIncludes) ? script.promptIncludes : [script.promptIncludes]
      if (!needles.every(needle => record.promptText.includes(needle))) return false
    }
    return true
  }

  /** Default result when no script matches: schema-aware, never hangs the run. */
  const defaultResult = (record) => {
    const properties = record.outputSchema?.properties
    if (properties?.scope !== undefined) {
      return structuredResult(
        {
          scope: '默认答案空间',
          dimensions: ['默认维度'],
          questions: [{ question: '默认问题', dimension: '默认维度' }],
          coverage_gaps: [],
        },
        '规划默认输出',
      )
    }
    if (properties?.confirmed !== undefined) {
      return structuredResult(
        {
          confirmed: [{ claim: '默认结论', source: 'https://example.test/default', confidence: 'high' }],
          uncertain: [],
          gaps: [],
        },
        '研究默认输出',
      )
    }
    return textResult(options.defaultText ?? '默认子代理文本输出')
  }

  const startActivation = async (spec) => {
    if (spec === null || typeof spec !== 'object') {
      throw new TypeError('fake startActivation requires an activation spec')
    }
    if (typeof spec.provider !== 'string') throw new TypeError('fake startActivation: spec.provider must be a string')
    if (typeof spec.label !== 'string') throw new TypeError('fake startActivation: spec.label must be a string')
    // The real seam (SubagentRuntime.startActivation) is async and publishes the
    // child after a tick; a synchronous fake would mask an implementation that
    // forgets to `await`. Always yield a macrotask, even when the delay is 0.
    await delay(publicationDelayMs)
    const request = spec.request ?? {}
    const prompt = Array.isArray(request.prompt) ? request.prompt : []
    const record = {
      id: `fake-child-${++activationSeq}`,
      provider: spec.provider,
      label: spec.label,
      delivery: spec.delivery,
      signal: spec.signal,
      request,
      promptBlocks: prompt,
      promptText: prompt
        .filter(block => block?.type === 'text')
        .map(block => block.text ?? '')
        .join('\n'),
      outputSchema: request.outputSchema,
      agentOptions: request.agentOptions,
      model: request.agentOptions?.model,
      startedAt: Date.now(),
      result: undefined,
      settled: false,
      settledAt: undefined,
      disposed: false,
      disposeCount: 0,
      response: undefined,
      spec,
    }

    let resolveResult
    let rejectResult
    const resultPromise = new Promise((resolve, reject) => {
      resolveResult = resolve
      rejectResult = reject
    })
    record.result = resultPromise
    record.release = (value) => {
      if (record.settled) return
      resolveResult(value)
    }
    record.fail = (error) => {
      if (record.settled) return
      rejectResult(error)
    }

    const settle = (value) => {
      if (record.settled) return false
      record.settled = true
      record.settledAt = Date.now()
      active -= 1
      events.push({ type: 'settle', id: record.id, label: record.label, value })
      return true
    }
    resultPromise.then(
      value => settle(value),
      () => settle(undefined),
    )

    active += 1
    if (active > highWater) highWater = active
    activations.push(record)
    events.push({ type: 'start', id: record.id, label: record.label })

    const matching = scripts.filter(script => matchScript(script, record))
    // Later scripts override earlier ones for the same child.
    const script = matching.length > 0 ? matching[matching.length - 1] : undefined
    const respond = script === undefined ? defaultResult : script.respond

    const settleFromScript = async () => {
      try {
        const outcome = typeof respond === 'function' ? await respond(record) : respond
        if (outcome === DEFER) return
        record.response = outcome
        record.release(outcome ?? defaultResult(record))
      } catch (error) {
        record.response = { stopReason: 'error', output: [], diagnostic: String(error?.message ?? error) }
        record.release(record.response)
      }
    }
    void settleFromScript()

    return {
      childId: record.id,
      result: resultPromise,
      dispose: async () => {
        record.disposeCount += 1
        if (record.disposed) return
        record.disposed = true
        events.push({ type: 'dispose', id: record.id, label: record.label })
        // A real provider's dispose() tears the child down and settles its run
        // (cancelled); the deferred script must do the same or the caller's
        // `await activation.result` could never resume.
        record.release({ stopReason: 'cancelled', output: [], structured: undefined })
        await Promise.resolve()
      },
    }
  }

  const ctx = {
    tools: {
      register(tool) {
        registrations.push(tool)
        events.push({ type: 'register', name: tool?.name })
        return () => {
          const index = registrations.indexOf(tool)
          if (index >= 0) registrations.splice(index, 1)
        }
      },
    },
    subagents: {
      startActivation,
    },
    registrations,
    activations,
    events,
    logs,
    accessed,
    /** Register a scripted child responder. */
    script(matcher, respond) {
      const entry = matcher instanceof RegExp || typeof matcher === 'string'
        ? { label: matcher, respond }
        : { ...matcher }
      if (entry.respond === undefined) throw new TypeError('fake ctx.script requires a respond value or function')
      scripts.push(entry)
      return entry
    },
    /** First (and normally only) registered tool definition. */
    get tool() {
      return registrations[0]
    },
    get highWater() {
      return highWater
    },
    get activeCount() {
      return active
    },
    get activationCount() {
      return activations.length
    },
    get disposalCount() {
      return activations.reduce((sum, record) => sum + record.disposeCount, 0)
    },
    labelCount(label) {
      return activations.filter(record => record.label === label).length
    },
    activationLabels() {
      return activations.map(record => record.label)
    },
    /** Release any still-pending fake result (test cleanup only; not counted). */
    disposeAll() {
      for (const record of activations) {
        if (!record.settled) record.release({ stopReason: 'cancelled', output: [], structured: undefined })
      }
    },
  }

  Object.defineProperty(ctx, 'workflows', {
    configurable: true,
    enumerable: false,
    get() {
      accessed.workflows += 1
      return undefined
    },
  })

  if (options.logger === true) {
    ctx.logger = {
      debug: (...args) => logs.push(['debug', ...args]),
      info: (...args) => logs.push(['info', ...args]),
      warn: (...args) => logs.push(['warn', ...args]),
      error: (...args) => logs.push(['error', ...args]),
    }
  }

  return ctx
}
