#!/usr/bin/env node
/**
 * Profile-level install/load verification for @shmming/dsh-deep-research
 * against the CURRENT DeepSeek Harness runtime (0.2.1-rc.3).
 *
 * What this proves, in a throwaway DSH home inside the workspace:
 *   0. Preconditions: runtime version, plugin manifest, patch row identity,
 *      module export markers.
 *   1. `dsh --from-default-profile web --dump-config` initializes a scratch
 *      profile (nothing outside the workspace is touched).
 *   2. The plugin is "installed" without pnpm/network: a node_modules symlink
 *      plus a manifest bundle selection and a `link:` dependency.
 *   3. `--dump-config` composes the plugin's bundle patch: exactly one active
 *      root row id `dsh-deep-research` with the expected package name, while
 *      the base web composition (workflow-ptc, tool-web) remains intact.
 *   4. `--dump-config-schema` imports every composed plugin module and
 *      projects its Config. Our row must reach status `schema` with the
 *      contract's Config fields (a real module-load proof).
 *   5. Web boot smoke: `dsh --profile dr --port <free> --no-open` serves the
 *      authenticated UI, the loader settles with no diagnostic naming the
 *      plugin, and SIGTERM shuts the process down.
 *   6. Activation control (intentional failure): the same profile booted with
 *      an invalid plugin config must print a loader diagnostic naming the
 *      plugin and containing the plugin's own validation error. This proves
 *      the module is imported AND apply() runs at profile boot, and that the
 *      absence of a diagnostic in step 5 is meaningful.
 *   7. Apply/registration at real boot: a throwaway *instrumented copy* of the
 *      module (deliverable sha256-verified untouched) traces apply() entry and
 *      the resolved `deep_research` tool right after registration, in a real
 *      composed profile boot. `ctx.logger.info` is not surfaced by the web
 *      boot logger, so this is the positive proof that the module loaded, the
 *      injected services were present, Config defaults were applied and the
 *      tool is resolvable from `ctx.tools`.
 *   8. Display metadata + publish surface: the installed official
 *      `readPluginMeta`/`resolvePluginResource` (imported from the DSH
 *      installation, resolved from the scratch profile) must return the
 *      locale en/zh title+description and the SVG icon data URL, and every
 *      exported resource must stay inside the package root. `npm pack
 *      --dry-run --json` must ship exactly the declared `files` whitelist, the
 *      manifest must declare `dsh.manifestVersion: 1`, its `engines.dsh` range
 *      must accept this runtime, and the patch row name must equal the package
 *      name.
 *
 * No model API calls, no credentials, no network. Every dsh invocation sets
 * DSH_HOME explicitly to a directory inside this workspace; the real ~/.dsh is
 * never read or written.
 *
 * Usage:  node scripts/verify-profile.mjs
 * Output: _verify/profile-report.json (machine readable)
 *         _verify/profile-report.md   (human readable)
 *         plus logs/artifacts under _verify/
 * Exit:   0 when every check passes, 1 otherwise.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { fileURLToPath, pathToFileURL } from 'node:url'
import process from 'node:process'

// ── Layout ──────────────────────────────────────────────────────────────────
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const WORKSPACE = path.resolve(SCRIPT_DIR, '..')
const VERIFY_DIR = path.join(WORKSPACE, '_verify')
const DSH_HOME = path.join(VERIFY_DIR, 'home')
const BASELINE_HOME = path.join(VERIFY_DIR, 'baseline-home')

const DSH_BIN = '/usr/bin/dsh'
const PLUGIN_NAME = '@shmming/dsh-deep-research'
const PLUGIN_ID = 'dsh-deep-research'
const EXPECTED_DSH = '0.2.1-rc.3'
const BOOT_START_PORT = 3098

/** Installed (out-of-tree) official plugin-metadata reader; not a workspace dep. */
const APP_BOOT_PACKAGE = '/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-app-boot/package.json'
const APP_BOOT_ENTRY = '/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js'
/** Localized display titles the plugin must declare in locale/*.json. */
const DISPLAY_TITLE = { en: 'Deep Research', zh: '深度研究' }
/** npm cache/log dir kept inside the writable workspace (the real home is read-only). */
const NPM_CACHE_DIR = path.join(VERIFY_DIR, 'npm-cache')
const NPM_PACK_TIMEOUT_MS = 180_000
const PACK_REQUIRED_FILES = [
  'package.json',
  'src/index.js',
  'types/index.d.ts',
  'assets/icon.svg',
  'locale/en.json',
  'locale/zh.json',
  'cordis.patch.yml',
  'README.md',
  'README.zh.md',
  'CHANGELOG.md',
  'LICENSE',
]
const PACK_FORBIDDEN_PREFIXES = ['node_modules/', '_verify/', '_ref/', '_leadcheck/', '_scratch/', '_testhome/', 'test/', 'scripts/']
const BOOT_TIMEOUT_MS = 90_000
const STOP_TIMEOUT_MS = 15_000
const REQUIRED_CONFIG_FIELDS = [
  'childProvider',
  'maxParallel',
  'maxTotalAgents',
  'plannerModel',
  'researcherModel',
  'synthesizerModel',
  'reviewerModel',
]

const INSTRUMENTED_PROFILE = 'dri'
const INSTRUMENTED_DIR = path.join(VERIFY_DIR, 'instrumented')
const INSTRUMENTED_TRACE = path.join(VERIFY_DIR, 'instrumented-trace.jsonl')
const INSTRUMENTED_LOG = path.join(VERIFY_DIR, 'web-boot-instrumented.log')

const ARTIFACTS = {
  initDump: path.join(VERIFY_DIR, 'init-dump.yml'),
  composedConfig: path.join(VERIFY_DIR, 'composed-config.yml'),
  profilePackage: path.join(VERIFY_DIR, 'profile-package.json'),
  schemaJson: path.join(VERIFY_DIR, 'config-schema.json'),
  schemaErr: path.join(VERIFY_DIR, 'config-schema.err'),
  baselineSchemaJson: path.join(VERIFY_DIR, 'baseline-config-schema.json'),
  baselineSchemaErr: path.join(VERIFY_DIR, 'baseline-config-schema.err'),
  bootLog: path.join(VERIFY_DIR, 'web-boot.log'),
  controlLog: path.join(VERIFY_DIR, 'web-boot-control.log'),
  controlPatch: path.join(VERIFY_DIR, 'control-invalid-config.patch.yml'),
  instrumentedDir: INSTRUMENTED_DIR,
  instrumentedTrace: INSTRUMENTED_TRACE,
  instrumentedLog: INSTRUMENTED_LOG,
  npmPackJson: path.join(VERIFY_DIR, 'npm-pack.json'),
  npmPackErr: path.join(VERIFY_DIR, 'npm-pack.err'),
  reportJson: path.join(VERIFY_DIR, 'profile-report.json'),
  reportMd: path.join(VERIFY_DIR, 'profile-report.md'),
}

// ── Small utilities ─────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function ensure(condition, message) {
  if (!condition) throw new Error(message)
}

function readText(file) {
  return fs.readFileSync(file, 'utf8')
}

function existsFile(file) {
  try {
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

function firstLines(text, count = 3) {
  const lines = String(text ?? '').trim().split(/\r?\n/).filter(Boolean)
  const head = lines.slice(0, count).map((line) => line.slice(0, 300))
  return head.length > 0 ? head.join(' | ') : '(empty)'
}

function clip(text, max = 600) {
  const value = String(text ?? '')
  return value.length > max ? `${value.slice(0, max)}…` : value
}

/** One-line process state for boot-failure diagnostics (pid, cpu, rss, state). */
function processSnapshot(pid) {
  if (pid === undefined || pid === null) return 'no pid'
  try {
    const rows = execFileSync('ps', ['-o', 'pid=,etime=,pcpu=,rss=,stat=', '-p', String(pid)], { encoding: 'utf8' }).trim()
    return rows.length > 0 ? rows.replace(/\s+/g, ' ') : 'process not running'
  } catch {
    return 'process not running'
  }
}

/** Wrap a readiness wait so a timeout reports the boot log and process state. */
async function waitForHttpOrExplain(port, server, timeoutMs = BOOT_TIMEOUT_MS) {
  try {
    return await waitForHttp(port, timeoutMs)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`${message}; boot log: ${firstLines(server.getLog(), 4)}; process: ${processSnapshot(server.child.pid)}`)
  }
}

/** Guard every destructive operation: only this workspace may be touched. */
function assertSafeDir(dir) {
  const resolved = path.resolve(dir)
  ensure(resolved === WORKSPACE || resolved.startsWith(WORKSPACE + path.sep), `refusing to touch ${resolved}: outside workspace ${WORKSPACE}`)
  ensure(resolved !== path.resolve(os.homedir(), '.dsh'), 'refusing to touch the real ~/.dsh')
  ensure(resolved !== path.resolve(os.homedir()), 'refusing to touch the home directory itself')
  ensure(resolved !== WORKSPACE, 'refusing to remove the workspace root')
}

// ── Process helpers ─────────────────────────────────────────────────────────
/** Run a command to completion, capturing stdout/stderr and enforcing a timeout. */
function runCommand(command, args, { env, cwd, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now()
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let child
    try {
      child = spawn(command, args, {
        cwd: cwd ?? WORKSPACE,
        env: env ?? process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolve({ ok: false, code: null, signal: null, stdout, stderr: String(error), timedOut, durationMs: Date.now() - startedAt })
      return
    }
    const timer = setTimeout(() => {
      timedOut = true
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
    }, timeoutMs)
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ ok: !timedOut && code === 0, code, signal, stdout, stderr, timedOut, durationMs: Date.now() - startedAt })
    })
  })
}

/** Run the dsh launcher with an explicit scratch DSH_HOME (never the real one). */
function runDsh(args, { home = DSH_HOME, timeoutMs = 120_000 } = {}) {
  return runCommand(DSH_BIN, args, {
    cwd: WORKSPACE,
    timeoutMs,
    env: { ...process.env, DSH_HOME: home },
  })
}

/** Children started by the boot smoke; always reaped at exit. */
const runningChildren = new Set()

/**
 * Start a dsh web process, mirroring stdout+stderr into a log file.
 * @returns {{child: import('node:child_process').ChildProcess, exited: Promise<{code: number|null, signal: string|null}>, getLog: () => string}}
 */
function startDshApp(args, logPath) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true })
  const stream = fs.createWriteStream(logPath)
  const child = spawn(DSH_BIN, args, {
    cwd: WORKSPACE,
    env: { ...process.env, DSH_HOME },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  runningChildren.add(child)
  const chunks = []
  const forward = (chunk) => {
    chunks.push(chunk)
    stream.write(chunk)
  }
  child.stdout.on('data', forward)
  child.stderr.on('data', forward)
  const exited = new Promise((resolve) => {
    child.on('close', (code, signal) => {
      runningChildren.delete(child)
      stream.end()
      resolve({ code, signal })
    })
  })
  return { child, exited, getLog: () => Buffer.concat(chunks).toString('utf8') }
}

/** SIGTERM a boot child and wait for it; escalate to SIGKILL only if needed. */
async function terminateDsh(handle, { timeoutMs = STOP_TIMEOUT_MS } = {}) {
  const startedAt = Date.now()
  if (handle.child.exitCode !== null || handle.child.signalCode !== null) {
    const result = await Promise.race([handle.exited, sleep(5_000).then(() => null)])
    return { exited: true, alreadyStopped: true, code: result?.code ?? handle.child.exitCode, signal: result?.signal ?? handle.child.signalCode, forced: false, ms: Date.now() - startedAt }
  }
  try {
    handle.child.kill('SIGTERM')
  } catch {
    /* already gone */
  }
  const first = await Promise.race([handle.exited.then((result) => ({ ...result, timedOut: false })), sleep(timeoutMs).then(() => ({ timedOut: true }))])
  if (!first.timedOut) return { exited: true, code: first.code, signal: first.signal, forced: false, ms: Date.now() - startedAt }
  try {
    handle.child.kill('SIGKILL')
  } catch {
    /* already gone */
  }
  const second = await Promise.race([handle.exited.then((result) => ({ ...result, timedOut: false })), sleep(5_000).then(() => ({ timedOut: true }))])
  return { exited: !second.timedOut, code: second.code ?? null, signal: second.signal ?? null, forced: true, ms: Date.now() - startedAt }
}

// ── HTTP helpers ────────────────────────────────────────────────────────────
function httpGet(port, pathname, { cookie, timeoutMs = 3_000 } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        path: pathname,
        method: 'GET',
        timeout: timeoutMs,
        headers: {
          ...(cookie ? { cookie } : {}),
          accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
        },
      },
      (response) => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => {
          if (body.length < 512_000) body += chunk
        })
        response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body }))
      },
    )
    request.on('timeout', () => request.destroy(new Error(`HTTP timeout after ${timeoutMs}ms`)))
    request.on('error', reject)
    request.end()
  })
}

/** Poll until a fresh port accepts a TCP connection (used to pick a free port). */
function probePort(port) {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)))
  })
}

async function findFreePort(start) {
  for (let port = start; port < start + 50; port += 1) {
    if (await probePort(port)) return port
  }
  throw new Error(`no free TCP port found from ${start} to ${start + 49} on 127.0.0.1`)
}

/**
 * Poll `GET /` until the web server answers at all. A 401 says "listening but
 * unauthenticated", which is the expected first answer; the caller then
 * performs the token handshake.
 */
async function waitForHttp(port, timeoutMs = BOOT_TIMEOUT_MS) {
  const startedAt = Date.now()
  let lastError = ''
  let lastStatus = null
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await httpGet(port, '/', { timeoutMs: 1_500 })
      lastStatus = response.status
      // A bare 404 is the host webserver listening before the web app mounted
      // (its auth fence answers 401 until the token handshake, 200 afterwards).
      // Only those two statuses prove the composed app actually came up.
      if (response.status === 401 || response.status === 200) {
        return { ms: Date.now() - startedAt, status: response.status, headers: response.headers, body: response.body }
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await sleep(400)
  }
  throw new Error(`web app on 127.0.0.1:${port} never reached its auth fence within ${timeoutMs}ms (last HTTP status: ${lastStatus ?? 'none'}; last error: ${clip(lastError, 200)})`)
}

/**
 * Remove stale cross-process writer locks and atomic-write temp files from the
 * scratch home before starting a boot.
 *
 * The scratch home belongs exclusively to this script and boots run strictly
 * one at a time (every prior child is reaped before the next starts). DSH
 * serializes writes such as `.credentials.yaml` through `wx` lock siblings
 * that record the holder PID; a lock left behind by a SIGKILLed/aborted boot
 * (or an incomplete record) is waited out instead of taken over, which leaves
 * the loader unsettled: the host webserver listens but answers a bare 404 and
 * never prints its authenticated URL. Clearing these files while no boot is
 * running can never race a live writer and keeps the check deterministic.
 */
function clearScratchStaleState(home) {
  const removed = []
  const walk = (dir, depth) => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      const staleLock = entry.isFile() && (entry.name.endsWith('.lock') || entry.name.includes('.lock.takeover-'))
      const staleTemp = entry.isFile() && entry.name.endsWith('.tmp')
      if (staleLock || staleTemp) {
        try {
          fs.rmSync(full, { force: true })
          removed.push(path.relative(home, full))
        } catch {
          /* best effort */
        }
        continue
      }
      // Symlinks are never directories for Dirent, so the workspace tree
      // reached through profiles/*/node_modules is not traversed.
      if (entry.isDirectory() && depth < 4) walk(full, depth + 1)
    }
  }
  walk(path.join(home), 0)
  return removed
}

/** Poll a boot child's captured log until `predicate` matches (bounded). */
async function waitForLog(server, predicate, timeoutMs = 30_000) {
  const startedAt = Date.now()
  let log = server.getLog()
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate(log)) return { log, ms: Date.now() - startedAt, timedOut: false }
    await sleep(100)
    log = server.getLog()
  }
  return { log, ms: Date.now() - startedAt, timedOut: true }
}

// ── Minimal YAML entry-list inspection (the dump is a flat list of root rows) ─
/**
 * Parse the composed `--dump-config` text into root rows. The dump prints one
 * `- id: <id>` per root entry at column 0; nested entries are indented, bundle
 * headers are `# == <bundle>` comments.
 */
function parseEntryRows(yamlText) {
  const rows = []
  let current = null
  for (const line of String(yamlText ?? '').split(/\r?\n/)) {
    const match = /^- id:\s*(.+?)\s*$/.exec(line)
    if (match) {
      current = { id: match[1].replace(/^['"]|['"]$/g, ''), lines: [] }
      rows.push(current)
      continue
    }
    if (current === null) continue
    if (/^- /.test(line) || /^# ==/.test(line)) {
      current = null
      continue
    }
    current.lines.push(line)
  }
  return rows
}

/** Classify a root row's `disabled:` line. */
function rowDisabled(row) {
  const line = row.lines.find((value) => /^\s+disabled:/.test(value))
  if (line === undefined) return { disabled: false, conditional: false }
  const value = line.replace(/^\s+disabled:\s*/, '').trim()
  if (value === 'true') return { disabled: true, conditional: false, value }
  if (value === 'false') return { disabled: false, conditional: false, value }
  return { disabled: false, conditional: true, value }
}

// ── JSON Schema helpers ─────────────────────────────────────────────────────
/** Collect every property name declared anywhere under a projected schema node. */
function collectPropertyNames(node, accumulator = new Set(), seen = new Set()) {
  if (!node || typeof node !== 'object' || seen.has(node)) return accumulator
  seen.add(node)
  if (Array.isArray(node)) {
    for (const item of node) collectPropertyNames(item, accumulator, seen)
    return accumulator
  }
  if (node.properties && typeof node.properties === 'object') {
    for (const key of Object.keys(node.properties)) accumulator.add(key)
  }
  for (const value of Object.values(node)) collectPropertyNames(value, accumulator, seen)
  return accumulator
}

/** Find the schema node declaring `name` as a property, if any. */
function findProperty(node, name, seen = new Set()) {
  if (!node || typeof node !== 'object' || seen.has(node)) return undefined
  seen.add(node)
  if (node.properties && typeof node.properties === 'object' && Object.hasOwn(node.properties, name)) {
    return node.properties[name]
  }
  for (const value of Object.values(node)) {
    const found = findProperty(value, name, seen)
    if (found !== undefined) return found
  }
  return undefined
}

function diagKey(diagnostic) {
  return `${diagnostic.level}|${diagnostic.path ?? ''}|${diagnostic.message}`
}

function diagSignature(diagnostics) {
  return [...(diagnostics ?? [])].map(diagKey).sort().join('\n')
}

function diagLines(diagnostics) {
  return [...(diagnostics ?? [])].map((diagnostic) => `dsh: ${diagnostic.level}:${diagnostic.path === undefined ? '' : ` [${diagnostic.path}]`} ${diagnostic.message}`)
}

// ── Semver / manifest helpers (no dependencies) ────────────────────────────
/** Parse a semver string into comparable parts (build metadata ignored). */
function parseSemver(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(value).trim())
  if (match === null) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] === undefined ? [] : match[4].split('.'),
  }
}

/** Semver identifier comparison (numeric identifiers sort before alphanumeric). */
function compareIdentifiers(left, right) {
  const leftNumeric = /^\d+$/.test(left)
  const rightNumeric = /^\d+$/.test(right)
  if (leftNumeric && rightNumeric) return Number(left) - Number(right)
  if (leftNumeric) return -1
  if (rightNumeric) return 1
  return left < right ? -1 : left > right ? 1 : 0
}

/** Semver precedence comparison (prereleases sort before the release). */
function compareSemver(left, right) {
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] - right[key]
  }
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0
  if (left.prerelease.length === 0) return 1
  if (right.prerelease.length === 0) return -1
  const length = Math.max(left.prerelease.length, right.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const leftPart = left.prerelease[index]
    const rightPart = right.prerelease[index]
    if (leftPart === undefined) return -1
    if (rightPart === undefined) return 1
    const order = compareIdentifiers(leftPart, rightPart)
    if (order !== 0) return order
  }
  return 0
}

function satisfiesComparator(version, comparator) {
  const match = /^(>=|<=|>|<|=|\^|~)?\s*(.+)$/.exec(comparator)
  ensure(match !== null, `cannot parse semver comparator ${JSON.stringify(comparator)}`)
  const operator = match[1] ?? '='
  const target = parseSemver(match[2])
  ensure(target !== null, `cannot parse semver comparator target ${JSON.stringify(comparator)}`)
  const order = compareSemver(version, target)
  switch (operator) {
    case '>=':
      return order >= 0
    case '>':
      return order > 0
    case '<=':
      return order <= 0
    case '<':
      return order < 0
    case '=':
      return order === 0
    case '^': {
      if (order < 0) return false
      const upper = target.major > 0
        ? { major: target.major + 1, minor: 0, patch: 0, prerelease: [] }
        : target.minor > 0
          ? { major: 0, minor: target.minor + 1, patch: 0, prerelease: [] }
          : { major: 0, minor: 0, patch: target.patch + 1, prerelease: [] }
      return compareSemver(version, upper) < 0
    }
    case '~': {
      if (order < 0) return false
      return compareSemver(version, { major: target.major, minor: target.minor + 1, patch: 0, prerelease: [] }) < 0
    }
    default:
      return false
  }
}

/** Evaluate a simple npm/semver range (`||` alternatives, whitespace-joined comparators). */
function satisfiesRange(version, range) {
  const parsed = parseSemver(version)
  ensure(parsed !== null, `cannot parse runtime version ${JSON.stringify(version)}`)
  return String(range)
    .split('||')
    .some((alternative) => {
      const comparators = alternative.trim().split(/\s+/).filter(Boolean)
      return comparators.length > 0 && comparators.every((comparator) => satisfiesComparator(parsed, comparator))
    })
}

/** Extract the `name:` of the patch row that inserts `dsh-deep-research`. */
function patchRowName(patchText) {
  const lines = String(patchText).split(/\r?\n/)
  const start = lines.findIndex((line) => /^\s*-\s+id:\s*dsh-deep-research\s*$/.test(line))
  ensure(start >= 0, `cordis.patch.yml does not insert a row with id ${PLUGIN_ID}`)
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\s*-\s+/.test(lines[index])) break
    const match = /^\s+name:\s*(.+?)\s*$/.exec(lines[index])
    if (match !== null) return match[1].replace(/^['"]|['"]$/g, '')
  }
  throw new Error(`cordis.patch.yml row ${PLUGIN_ID} has no name field`)
}

/** Import the installed official plugin-metadata reader once. */
let appBootModulePromise = null
function loadInstalledAppBoot() {
  appBootModulePromise ??= import(pathToFileURL(APP_BOOT_ENTRY).href)
  return appBootModulePromise
}

// ── Instrumented throwaway copy (apply/registration proof) ──────────────────
function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

/**
 * Build a throwaway instrumented copy of the plugin under `_verify/instrumented`.
 *
 * `ctx.logger.info` is not observable from a web boot (the base composition
 * registers no console logger exporter and boot only collects warn/error
 * startup diagnostics), so "no warning" alone cannot prove apply() ran. This
 * copy appends a small wrapper to the *copy* of `src/index.js` that appends
 * JSON trace events to a file: one at apply() entry and one immediately after
 * the tool registration returns, resolved back through `ctx.tools.get`.
 * The deliverable itself is never modified (the caller hash-checks it).
 */
function buildInstrumentedCopy() {
  assertSafeDir(INSTRUMENTED_DIR)
  fs.rmSync(INSTRUMENTED_DIR, { recursive: true, force: true })
  fs.mkdirSync(path.join(INSTRUMENTED_DIR, 'src'), { recursive: true })
  fs.copyFileSync(path.join(WORKSPACE, 'package.json'), path.join(INSTRUMENTED_DIR, 'package.json'))
  fs.copyFileSync(path.join(WORKSPACE, 'cordis.patch.yml'), path.join(INSTRUMENTED_DIR, 'cordis.patch.yml'))

  const source = readText(path.join(WORKSPACE, 'src', 'index.js'))
  const traceLiteral = JSON.stringify(INSTRUMENTED_TRACE)
  // Appending at module top level keeps the wrapper independent of apply()'s
  // internals: the exported mutable `apply` binding is replaced by a wrapper.
  const instrumentation = `
// ── verification instrumentation: throwaway copy, the deliverable is untouched ──
const __TRACE_PATH = ${traceLiteral}
const __trace = (event) => {
  try {
    const { appendFileSync } = process.getBuiltinModule('node:fs')
    appendFileSync(__TRACE_PATH, JSON.stringify({ ...event, ts: Date.now() }) + '\\n')
  } catch { /* tracing must never break the plugin */ }
}
const __originalApply = apply
apply = (ctx, config = {}) => {
  __trace({ event: 'apply', tools: typeof ctx.tools, subagents: typeof ctx.subagents, config })
  __originalApply(ctx, config)
  const tool = ctx.tools.get?.('deep_research')
  __trace({ event: 'registered', tool: tool?.name ?? null, hasOutputSchema: Boolean(tool?.output?.schema) })
}
`
  fs.writeFileSync(path.join(INSTRUMENTED_DIR, 'src', 'index.js'), source + instrumentation)
  fs.rmSync(INSTRUMENTED_TRACE, { force: true })
  return { instrumentedDir: INSTRUMENTED_DIR, tracePath: INSTRUMENTED_TRACE }
}

/** Read the JSONL trace file, waiting until it contains the requested events. */
async function waitForTraceEvents(tracePath, predicate, timeoutMs = 20_000) {
  const startedAt = Date.now()
  let events = []
  while (Date.now() - startedAt < timeoutMs) {
    events = []
    try {
      events = readText(tracePath)
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0)
        .map((line) => {
          try {
            return JSON.parse(line)
          } catch {
            return { event: 'unparseable', raw: line }
          }
        })
    } catch {
      events = []
    }
    if (predicate(events)) return events
    await sleep(250)
  }
  return events
}

/** Link a package directory into a scratch profile and select it as a bundle. */
function linkPackageIntoProfile(profileDir, packageDir) {
  const linkPath = path.join(profileDir, 'node_modules', ...PLUGIN_NAME.split('/'))
  fs.mkdirSync(path.dirname(linkPath), { recursive: true })
  try {
    const stats = fs.lstatSync(linkPath)
    if (stats.isSymbolicLink() || stats.isDirectory()) fs.rmSync(linkPath, { recursive: true, force: true })
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  fs.symlinkSync(packageDir, linkPath, 'dir')

  const manifestPath = path.join(profileDir, 'package.json')
  const manifest = JSON.parse(readText(manifestPath))
  manifest.dependencies = manifest.dependencies ?? {}
  manifest.dependencies[PLUGIN_NAME] = `link:${packageDir}`
  manifest.dsh = manifest.dsh ?? {}
  manifest.dsh.profile = manifest.dsh.profile ?? {}
  const bundles = manifest.dsh.profile.bundles ?? []
  ensure(Array.isArray(bundles), 'profile manifest bundles is not an array')
  if (!bundles.includes(PLUGIN_NAME)) bundles.push(PLUGIN_NAME)
  manifest.dsh.profile.bundles = bundles
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

  const stats = fs.lstatSync(linkPath)
  ensure(stats.isSymbolicLink(), `${linkPath} is not a symlink`)
  ensure(path.resolve(fs.readlinkSync(linkPath)) === path.resolve(packageDir), `symlink target is ${fs.readlinkSync(linkPath)}, expected ${packageDir}`)
  return { linkPath, manifest: JSON.parse(readText(manifestPath)) }
}

// ── Report state ────────────────────────────────────────────────────────────
const checks = []
const state = {}

async function check(id, title, run) {
  const startedAt = Date.now()
  try {
    const result = await run()
    checks.push({ id, title, status: 'PASS', evidence: result.evidence, detail: result.detail, ms: Date.now() - startedAt })
    console.log(`PASS  ${id}  ${title}`)
    console.log(`      ${result.evidence}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    checks.push({ id, title, status: 'FAIL', evidence: message, ms: Date.now() - startedAt })
    console.log(`FAIL  ${id}  ${title}`)
    console.log(`      ${message}`)
  }
}

// ── Checks ──────────────────────────────────────────────────────────────────
async function check1Preconditions() {
  await check('1', 'preconditions: runtime, manifest, patch row identity, module exports', async () => {
    const versionRun = await runCommand(DSH_BIN, ['--version'], { cwd: WORKSPACE, env: { ...process.env, DSH_HOME } })
    ensure(versionRun.code === 0, `dsh --version exited ${versionRun.code}: ${firstLines(versionRun.stderr)}`)
    const version = versionRun.stdout.trim()
    ensure(version.startsWith('0.2.1'), `expected a 0.2.1 DSH runtime (target ${EXPECTED_DSH}), got ${JSON.stringify(version)}`)

    const packagePath = path.join(WORKSPACE, 'package.json')
    ensure(existsFile(packagePath), `missing ${packagePath}`)
    const pkg = JSON.parse(readText(packagePath))
    ensure(pkg.name === PLUGIN_NAME, `package name is ${JSON.stringify(pkg.name)}, expected ${JSON.stringify(PLUGIN_NAME)}`)
    ensure(pkg.type === 'module', `package type is ${JSON.stringify(pkg.type)}, expected "module"`)

    const mainRelative = typeof pkg.main === 'string' ? pkg.main : pkg.exports?.['.']
    ensure(typeof mainRelative === 'string' && mainRelative.length > 0, 'package.json declares no main entry (main / exports["."])')
    const mainPath = path.resolve(WORKSPACE, mainRelative)
    ensure(existsFile(mainPath), `main entry ${mainRelative} does not exist`)
    ensure(mainPath.startsWith(WORKSPACE + path.sep), `main entry resolves outside the workspace: ${mainPath}`)

    const declaredPatch = pkg.dsh?.bundle?.patch
    ensure(declaredPatch === './cordis.patch.yml', `dsh.bundle.patch is ${JSON.stringify(declaredPatch)}, expected "./cordis.patch.yml"`)
    const patchPath = path.resolve(WORKSPACE, declaredPatch)
    ensure(existsFile(patchPath), `declared bundle patch ${declaredPatch} does not exist`)

    const patchText = readText(patchPath)
    ensure(new RegExp(`(^|\\n)\\s*-\\s+id:\\s*${PLUGIN_ID}\\s*$`, 'm').test(patchText), `bundle patch does not insert a row with id ${PLUGIN_ID}`)
    const nameForms = [`'${PLUGIN_NAME}'`, `"${PLUGIN_NAME}"`, PLUGIN_NAME]
    ensure(nameForms.some((form) => patchText.includes(form)), `bundle patch row does not name ${PLUGIN_NAME}`)

    const sourceText = readText(mainPath)
    for (const marker of ['export const name', 'export const inject', 'export const Config', 'export function apply']) {
      ensure(sourceText.includes(marker), `${mainRelative} is missing "${marker}"`)
    }
    const injectMatch = /export const inject\s*=\s*\[([^\]]*)\]/.exec(sourceText)
    ensure(injectMatch !== null && injectMatch[1].includes('tools') && injectMatch[1].includes('subagents'), 'inject does not declare tools + subagents')

    return {
      evidence: `dsh ${version}; ${pkg.name}@${pkg.version}; main=${mainRelative} (${sourceText.length} bytes, exports name/inject/Config/apply, inject=[tools, subagents]); patch ${declaredPatch} inserts id ${PLUGIN_ID} -> ${PLUGIN_NAME}; engines.dsh=${JSON.stringify(pkg.engines?.dsh ?? null)}`,
      detail: { version, packageVersion: pkg.version, mainRelative, engines: pkg.engines?.dsh ?? null },
    }
  })
}

async function check2ScratchHome() {
  await check('2', 'fresh scratch DSH_HOME + profile "dr" initialized from the shipped web template', async () => {
    assertSafeDir(DSH_HOME)
    fs.rmSync(DSH_HOME, { recursive: true, force: true })

    const run = await runDsh(['--profile', 'dr', '--from-default-profile', 'web', '--dump-config'])
    fs.writeFileSync(ARTIFACTS.initDump, run.stdout)
    ensure(run.code === 0, `profile init exited ${run.code}: ${firstLines(run.stderr)}`)

    const profileDir = path.join(DSH_HOME, 'profiles', 'dr')
    for (const file of ['package.json', 'cordis.yml', 'cordis.patch.yml']) {
      ensure(existsFile(path.join(profileDir, file)), `initialized profile is missing ${file}`)
    }
    const manifest = JSON.parse(readText(path.join(profileDir, 'package.json')))
    const bundles = manifest.dsh?.profile?.bundles
    ensure(Array.isArray(bundles), 'initialized profile has no dsh.profile.bundles array')
    ensure(bundles.includes('@deepseek-ai/dsh-base'), `template bundles lack dsh-base: ${JSON.stringify(bundles)}`)
    ensure(bundles.includes('@deepseek-ai/dsh-web-app'), `template bundles lack dsh-web-app: ${JSON.stringify(bundles)}`)
    ensure(!bundles.includes(PLUGIN_NAME), 'plugin unexpectedly already selected by the shipped template')

    state.profileDir = profileDir
    state.initDump = run.stdout
    return {
      evidence: `created ${path.relative(WORKSPACE, DSH_HOME)} (inside workspace); profiles/dr bundles=${JSON.stringify(bundles)}; init dump ${run.stdout.split(/\r?\n/).length} lines`,
      detail: { dshHome: DSH_HOME, profileDir, bundles },
    }
  })
}

async function check3LinkPlugin() {
  await check('3', 'install/link plugin into profile node_modules + bundle manifest (no pnpm, no network)', async () => {
    ensure(state.profileDir !== undefined, 'profile not initialized (check 2 failed)')
    const profileDir = state.profileDir
    const { linkPath, manifest: written } = linkPackageIntoProfile(profileDir, WORKSPACE)
    fs.copyFileSync(path.join(profileDir, 'package.json'), ARTIFACTS.profilePackage)

    const linkedPackage = JSON.parse(readText(path.join(linkPath, 'package.json')))
    ensure(linkedPackage.name === PLUGIN_NAME, `linked package name is ${JSON.stringify(linkedPackage.name)}`)
    ensure(written.dsh.profile.bundles.at(-1) === PLUGIN_NAME, `plugin is not the last bundle: ${JSON.stringify(written.dsh.profile.bundles)}`)
    ensure(typeof written.dependencies[PLUGIN_NAME] === 'string' && written.dependencies[PLUGIN_NAME].startsWith('link:'), 'dependencies entry is not a link: spec')
    ensure(written.dependencies[PLUGIN_NAME] === `link:${WORKSPACE}`, `link: spec is ${written.dependencies[PLUGIN_NAME]}, expected link:${WORKSPACE}`)

    return {
      evidence: `node_modules/@shmming/dsh-deep-research -> ${WORKSPACE} (symlink; package ${linkedPackage.name}@${linkedPackage.version}); bundles += ${PLUGIN_NAME}; dependencies["${PLUGIN_NAME}"]="link:${WORKSPACE}"`,
      detail: { linkPath, target: fs.readlinkSync(linkPath), bundles: written.dsh.profile.bundles, dependency: written.dependencies[PLUGIN_NAME] },
    }
  })
}

async function check4ComposedConfig() {
  await check('4', '--dump-config composes exactly one active dsh-deep-research row + intact base web composition', async () => {
    ensure(state.profileDir !== undefined, 'profile not installed (check 3 failed)')
    const run = await runDsh(['--profile', 'dr', '--dump-config'])
    fs.writeFileSync(ARTIFACTS.composedConfig, run.stdout)
    ensure(run.code === 0, `--dump-config exited ${run.code}: ${firstLines(run.stderr)}`)
    ensure(!new RegExp(`skipped|incompatible`, 'i').test(run.stderr) || !run.stderr.includes(PLUGIN_NAME), `profile reported the bundle as skipped: ${firstLines(run.stderr)}`)

    const rows = parseEntryRows(run.stdout)
    ensure(rows.length > 100, `composed config has only ${rows.length} root rows — composition looks broken`)
    const ours = rows.filter((row) => row.id === PLUGIN_ID)
    ensure(ours.length === 1, `expected exactly one root row id ${PLUGIN_ID}, found ${ours.length}`)

    const row = ours[0]
    const nameLine = row.lines.find((line) => /^\s+name:/.test(line))
    ensure(nameLine !== undefined, `row ${PLUGIN_ID} has no name field`)
    ensure(nameLine.includes(PLUGIN_NAME), `row name is ${JSON.stringify(nameLine.trim())}, expected ${PLUGIN_NAME}`)
    const disabled = rowDisabled(row)
    ensure(!disabled.disabled, `row ${PLUGIN_ID} is disabled (${disabled.value ?? 'true'})`)
    ensure(!disabled.conditional, `row ${PLUGIN_ID} has a conditional disabled expression (${disabled.value})`)

    const ids = new Set(rows.map((row) => row.id))
    ensure(ids.has('workflow-ptc'), 'base composition is missing workflow-ptc (web profile did not compose)')
    ensure(ids.has('tool-web'), 'base composition is missing tool-web (web profile did not compose)')

    const initRows = parseEntryRows(state.initDump ?? '')
    ensure(initRows.length > 0, 'init dump from check 2 is unavailable; cannot prove the row came from the bundle patch')
    ensure(!initRows.some((row) => row.id === PLUGIN_ID), `row ${PLUGIN_ID} already existed before installing the plugin — insertion did not come from the bundle patch`)

    const baseRows = initRows.length
    return {
      evidence: `row id=${PLUGIN_ID} name=${PLUGIN_NAME} at root (single occurrence, no disabled); base rows workflow-ptc + tool-web present; ${rows.length} root rows after install vs ${baseRows} before (row inserted by the bundle patch); --dump-config exit 0`,
      detail: { rowId: PLUGIN_ID, rowName: nameLine.trim(), disabled, rootRows: rows.length, beforeRows: baseRows, composedConfig: ARTIFACTS.composedConfig },
    }
  })
}

async function check5ConfigSchema() {
  await check('5', '--dump-config-schema imports the plugin module and projects its Config schema', async () => {
    ensure(state.profileDir !== undefined, 'profile not installed (check 3 failed)')
    const run = await runDsh(['--profile', 'dr', '--dump-config-schema'], { timeoutMs: 180_000 })
    fs.writeFileSync(ARTIFACTS.schemaJson, run.stdout)
    fs.writeFileSync(ARTIFACTS.schemaErr, run.stderr)

    let document
    try {
      document = JSON.parse(run.stdout)
    } catch {
      throw new Error(`schema dump output is not JSON (exit ${run.code}): ${firstLines(run.stderr)}`)
    }
    const cordis = document['x-cordis'] ?? {}
    const entries = cordis.entries ?? []
    const entry = entries.find((candidate) => candidate.id === PLUGIN_ID)
    ensure(entry !== undefined, `no schema entry for ${PLUGIN_ID} — the composed plugin module did not import (exit ${run.code}; stderr: ${firstLines(run.stderr)})`)
    ensure(entry.name === PLUGIN_NAME, `schema entry name is ${JSON.stringify(entry.name)}`)
    ensure(entry.status === 'schema' || entry.status === 'partial', `schema entry status=${JSON.stringify(entry.status)} (configRef=${JSON.stringify(entry.configRef)}): module import or Config projection failed; errors: ${diagLines(cordis.diagnostics).filter((line) => line.includes(PLUGIN_ID) || line.includes(PLUGIN_NAME)).join(' | ') || '(none naming the plugin)'}`)
    ensure(typeof entry.configRef === 'string' && entry.configRef.startsWith('#/$defs/'), `row has no projected Config schema reference (configRef=${JSON.stringify(entry.configRef)})`)
    const definitionName = entry.configRef.slice('#/$defs/'.length)
    const definition = document.$defs?.[definitionName]
    ensure(definition !== undefined, `schema document is missing ${entry.configRef}`)
    const properties = collectPropertyNames(definition)
    const missing = REQUIRED_CONFIG_FIELDS.filter((field) => !properties.has(field))
    ensure(missing.length === 0, `projected Config schema is missing fields: ${missing.join(', ')} (found: ${[...properties].sort().join(', ')})`)

    const defaults = {
      maxParallel: findProperty(definition, 'maxParallel')?.default,
      maxTotalAgents: findProperty(definition, 'maxTotalAgents')?.default,
      childProvider: findProperty(definition, 'childProvider')?.default,
    }
    ensure(defaults.maxParallel === 4, `maxParallel default is ${JSON.stringify(defaults.maxParallel)}, expected 4`)
    ensure(defaults.maxTotalAgents === 32, `maxTotalAgents default is ${JSON.stringify(defaults.maxTotalAgents)}, expected 32`)
    ensure(defaults.childProvider === 'spawn', `childProvider default is ${JSON.stringify(defaults.childProvider)}, expected "spawn"`)

    const diagnostics = cordis.diagnostics ?? []
    const pluginDiagnostics = diagnostics.filter((diagnostic) => diagnostic.path === entry.path || String(diagnostic.message).includes(PLUGIN_ID) || String(diagnostic.message).includes(PLUGIN_NAME))
    ensure(!pluginDiagnostics.some((diagnostic) => diagnostic.level === 'error'), `plugin-attributable schema errors: ${diagLines(pluginDiagnostics).join(' | ')}`)

    // DSH 0.2.1-rc.3 cannot schema-dump the shipped web template cleanly (exit 1,
    // four upstream "unrecognized Loader tree carrier" errors at /187-/190). Run the
    // pristine template through the same command to separate upstream noise from
    // plugin-attributable problems instead of asserting an exit code the runtime
    // cannot deliver even without our plugin.
    assertSafeDir(BASELINE_HOME)
    fs.rmSync(BASELINE_HOME, { recursive: true, force: true })
    const baseline = await runDsh(['--profile', 'web', '--dump-config-schema'], { home: BASELINE_HOME, timeoutMs: 180_000 })
    fs.writeFileSync(ARTIFACTS.baselineSchemaJson, baseline.stdout)
    fs.writeFileSync(ARTIFACTS.baselineSchemaErr, baseline.stderr)
    let baselineDocument = null
    try {
      baselineDocument = JSON.parse(baseline.stdout)
    } catch {
      baselineDocument = null
    }
    const baselineDiagnostics = baselineDocument?.['x-cordis']?.diagnostics ?? []
    const baselineKeys = new Set(baselineDiagnostics.map(diagKey))
    const extraErrors = diagnostics.filter((diagnostic) => diagnostic.level === 'error' && !baselineKeys.has(diagKey(diagnostic)))
    ensure(extraErrors.length === 0, `schema errors not present on the pristine web template: ${diagLines(extraErrors).join(' | ')}`)
    if (run.code !== 0) {
      ensure(baseline.code !== 0, `schema dump exited ${run.code} although the pristine web template exits ${baseline.code}`)
      ensure(diagSignature(diagnostics) === diagSignature(baselineDiagnostics), `schema diagnostics differ from the pristine web template: ours=${clip(diagSignature(diagnostics), 300)} baseline=${clip(diagSignature(baselineDiagnostics), 300)}`)
    }

    const exitNote = run.code === 0
      ? 'schema dump exit 0'
      : `schema dump exit ${run.code} — identical to the pristine web template (exit ${baseline.code}; ${baselineDiagnostics.length} upstream diagnostics, byte-identical), i.e. not attributable to the plugin`
    return {
      evidence: `entry ${entry.path} id=${PLUGIN_ID} name=${PLUGIN_NAME} status=${entry.status} configRef=${entry.configRef}; projected Config fields=[${[...properties].sort().join(', ')}]; defaults maxParallel=${defaults.maxParallel}, maxTotalAgents=${defaults.maxTotalAgents}, childProvider=${JSON.stringify(defaults.childProvider)}; ${exitNote}`,
      detail: {
        exitCode: run.code,
        baselineExitCode: baseline.code,
        entry,
        properties: [...properties].sort(),
        defaults,
        upstreamDiagnostics: diagLines(baselineDiagnostics),
        pluginDiagnostics: diagLines(pluginDiagnostics),
        schemaPath: ARTIFACTS.schemaJson,
        baselineSchemaPath: ARTIFACTS.baselineSchemaJson,
      },
    }
  })
}

/** The authenticated browser URL is printed as `dsh web: <url>?token=<token>`. */
function extractToken(logText) {
  const match = /[?&]token=([A-Za-z0-9_-]+)/.exec(logText)
  return match === null ? null : match[1]
}

function firstCookie(headers) {
  const raw = headers['set-cookie']
  const first = Array.isArray(raw) ? raw[0] : typeof raw === 'string' ? raw : undefined
  return first === undefined ? null : first.split(';')[0]
}

async function check6aBootSmoke() {
  await check('6a', 'web boot smoke: composed profile serves with no loader diagnostic naming the plugin', async () => {
    ensure(state.profileDir !== undefined, 'profile not installed (check 3 failed)')
    const port = await findFreePort(BOOT_START_PORT)
    state.clearedLocks = [...new Set([...(state.clearedLocks ?? []), ...clearScratchStaleState(DSH_HOME)])]
    const args = ['--profile', 'dr', '--port', String(port), '--no-open']
    const server = startDshApp(args, ARTIFACTS.bootLog)
    state.bootHandle = server
    try {
      const ready = await waitForHttpOrExplain(port, server)
      ensure(server.child.exitCode === null, `web process exited during boot (code ${server.child.exitCode}); log: ${firstLines(server.getLog(), 3)}`)
      // The host webserver starts listening before the loader audit settles; the
      // web app prints its authenticated URL only after that. Wait for it.
      const boot = await waitForLog(server, (text) => /[?&]token=[A-Za-z0-9_-]+/.test(text))
      const log = boot.log
      const token = extractToken(log)
      ensure(!boot.timedOut && token !== null, `boot log never printed the authenticated URL/token within ${boot.ms}ms: ${firstLines(log, 3)}; process: ${processSnapshot(server.child.pid)}`)

      const tokenResponse = await httpGet(port, `/?token=${encodeURIComponent(token)}`)
      ensure([200, 301, 302, 303].includes(tokenResponse.status), `token URL returned HTTP ${tokenResponse.status}`)
      const cookie = firstCookie(tokenResponse.headers)
      const uiResponse = cookie === null ? tokenResponse : await httpGet(port, '/', { cookie })
      ensure(uiResponse.status === 200, `authenticated UI request returned HTTP ${uiResponse.status}`)
      ensure(/<!doctype html/i.test(uiResponse.body), 'authenticated UI response is not an HTML document')
      ensure(server.child.exitCode === null, 'web process died after serving its first request')

      const logLines = log.split(/\r?\n/).filter((line) => line.trim().length > 0)
      const pluginLines = logLines.filter((line) => line.includes(PLUGIN_ID) || line.includes(PLUGIN_NAME))
      const registrationLine = pluginLines.find((line) => /registered deep_research tool/.test(line)) ?? null
      const badPluginLines = pluginLines.filter((line) => /\b(?:error|warn|warning|fail(?:ed|ure)?|did not activate|pending|inactive)\b/i.test(line) && line !== registrationLine)
      ensure(badPluginLines.length === 0, `loader diagnostics name the plugin: ${badPluginLines.join(' | ')}`)
      const hardErrors = logLines.filter((line) => /^dsh: error\b|^error:/.test(line))
      ensure(hardErrors.length === 0, `web boot printed error lines: ${hardErrors.join(' | ')}`)

      const stop = await terminateDsh(server)
      ensure(stop.exited, `web process did not exit within ${STOP_TIMEOUT_MS}ms of SIGTERM (forced=${stop.forced})`)

      state.boot = {
        port,
        argv: args.join(' '),
        startedInMs: ready.ms,
        listeningStatus: ready.status,
        tokenStatus: tokenResponse.status,
        authenticatedStatus: uiResponse.status,
        authenticatedBytes: uiResponse.body.length,
        pluginLogLines: pluginLines,
        registrationLine,
        shutdown: stop,
        logPath: ARTIFACTS.bootLog,
      }
      return {
        evidence: `listened on 127.0.0.1:${port} in ${ready.ms}ms (first answer HTTP ${ready.status} = auth fence); ?token= -> ${tokenResponse.status}; authenticated / -> ${uiResponse.status} (${uiResponse.body.length} bytes HTML); ${pluginLines.length} log line(s) mention the plugin${registrationLine === null ? ' (no info registration line is printed by the web boot logger)' : ` incl. "${clip(registrationLine, 200)}"`}; no loader error/warn/pending names the plugin; SIGTERM -> ${stop.code === null ? `signal ${stop.signal}` : `exit ${stop.code}`} after ${stop.ms}ms`,
        detail: { port, startedInMs: ready.ms, logLines: logLines.length, pluginLogLines: pluginLines, registrationLine, shutdown: stop, logPath: ARTIFACTS.bootLog },
      }
    } finally {
      if (server.child.exitCode === null && server.child.signalCode === null) {
        try {
          server.child.kill('SIGKILL')
        } catch {
          /* already gone */
        }
      }
    }
  })
}

async function check6bActivationControl() {
  await check('6b', 'activation control: apply() executes at profile boot (intentional invalid config)', async () => {
    ensure(state.profileDir !== undefined, 'profile not installed (check 3 failed)')
    // Intentional negative control: an invalid configured value must make the
    // plugin fail *inside apply()*. DSH prints that plugin failure by name, so
    // the expected diagnostic both proves our module is imported and proves
    // apply() really runs in this composed profile. The overlay is argv-only and
    // does not modify the installed profile.
    fs.writeFileSync(ARTIFACTS.controlPatch, `- id: ${PLUGIN_ID}\n  config:\n    maxParallel: 0\n`)
    const startPort = (state.boot?.port ?? BOOT_START_PORT) + 1
    clearScratchStaleState(DSH_HOME)
    const port = await findFreePort(startPort)
    const args = ['--profile', 'dr', '--patch', ARTIFACTS.controlPatch, '--port', String(port), '--no-open']
    const server = startDshApp(args, ARTIFACTS.controlLog)
    try {
      const ready = await waitForHttpOrExplain(port, server)
      ensure(server.child.exitCode === null, 'control boot exited during startup')
      // Same ordering as 6a: the webserver listens before the loader audit logs
      // the failed entry, so wait for the expected diagnostic lines.
      const observed = await waitForLog(server, (text) => /did not activate/.test(text) && /maxParallel must be a positive integer/.test(text))
      const log = observed.log
      ensure(!observed.timedOut, `expected the loader's "did not activate" + validation diagnostic within ${observed.ms}ms; boot log: ${firstLines(log, 4)}; process: ${processSnapshot(server.child.pid)}`)
      ensure(log.includes(PLUGIN_ID) || log.includes(PLUGIN_NAME), `startup diagnostic does not name the plugin: ${firstLines(log, 4)}`)
      ensure(/maxParallel must be a positive integer/.test(log), `plugin's own apply() validation error did not surface: ${firstLines(log, 4)}`)
      ensure(/src\/index\.js|resolveSettings|positiveInt/.test(log), 'diagnostic stack does not point into src/index.js apply/resolveSettings')
      const stop = await terminateDsh(server)
      ensure(stop.exited, `control boot did not exit within ${STOP_TIMEOUT_MS}ms of SIGTERM (forced=${stop.forced})`)

      const diagnosticLines = log.split(/\r?\n/).filter((line) => /did not activate|maxParallel|dsh-deep-research/.test(line))
      state.control = { port, readyMs: ready.ms, diagnosticLines, shutdown: stop, logPath: ARTIFACTS.controlLog }
      return {
        evidence: `intentional config {maxParallel: 0} produced "${clip(diagnosticLines[0] ?? '', 120)}" naming ${PLUGIN_ID} plus "${clip(diagnosticLines.find((line) => line.includes('maxParallel')) ?? '', 140)}" from src/index.js apply/resolveSettings — module import + apply() execution at profile boot proven; web still served on 127.0.0.1:${port} in ${ready.ms}ms`,
        detail: { port, readyMs: ready.ms, diagnostics: diagnosticLines, shutdown: stop, logPath: ARTIFACTS.controlLog },
      }
    } finally {
      if (server.child.exitCode === null && server.child.signalCode === null) {
        try {
          server.child.kill('SIGKILL')
        } catch {
          /* already gone */
        }
      }
    }
  })
}

async function check6cApplyRegistration() {
  await check('6c', 'apply/registration at real boot (instrumented throwaway copy)', async () => {
    ensure(state.profileDir !== undefined, 'profile not installed (check 3 failed)')
    const deliverableSource = path.join(WORKSPACE, 'src', 'index.js')
    const deliverableHashBefore = sha256(deliverableSource)
    const built = buildInstrumentedCopy()
    ensure(sha256(deliverableSource) === deliverableHashBefore, 'the deliverable src/index.js changed while building the instrumented copy')
    ensure(!readText(path.join(WORKSPACE, 'src', 'index.js')).includes('__trace'), 'the deliverable unexpectedly contains instrumentation')

    // A separate scratch profile (same scratch home) links the throwaway copy,
    // not the deliverable, so the dump-config/schema checks above stay clean.
    const init = await runDsh(['--profile', INSTRUMENTED_PROFILE, '--from-default-profile', 'web', '--dump-config'])
    ensure(init.code === 0, `instrumented profile init exited ${init.code}: ${firstLines(init.stderr)}`)
    const profileDir = path.join(DSH_HOME, 'profiles', INSTRUMENTED_PROFILE)
    for (const file of ['package.json', 'cordis.yml', 'cordis.patch.yml']) {
      ensure(existsFile(path.join(profileDir, file)), `instrumented profile is missing ${file}`)
    }
    linkPackageIntoProfile(profileDir, built.instrumentedDir)

    clearScratchStaleState(DSH_HOME)
    const port = await findFreePort(BOOT_START_PORT + 20)
    const args = ['--profile', INSTRUMENTED_PROFILE, '--port', String(port), '--no-open']
    const server = startDshApp(args, INSTRUMENTED_LOG)
    try {
      const ready = await waitForHttpOrExplain(port, server)
      ensure(server.child.exitCode === null, `instrumented web process exited during boot (code ${server.child.exitCode}); log: ${firstLines(server.getLog(), 3)}`)
      ensure([200, 401].includes(ready.status), `instrumented web server answered HTTP ${ready.status}`)

      const events = await waitForTraceEvents(
        built.tracePath,
        (values) => values.some((event) => event.event === 'apply') && values.some((event) => event.event === 'registered'),
      )
      const applyEvent = events.find((event) => event.event === 'apply')
      const registeredEvent = events.find((event) => event.event === 'registered')
      ensure(applyEvent !== undefined, `instrumented copy recorded no apply event; trace: ${firstLines(events.map((event) => JSON.stringify(event)).join('\n'), 3)}; boot log: ${firstLines(server.getLog(), 3)}`)
      ensure(applyEvent.tools === 'object' && applyEvent.subagents === 'object', `apply() saw tools=${JSON.stringify(applyEvent.tools)}, subagents=${JSON.stringify(applyEvent.subagents)}: inject services were not provided`)
      const config = applyEvent.config ?? {}
      ensure(config.childProvider === 'spawn', `apply() received childProvider=${JSON.stringify(config.childProvider)}; expected schemastery default "spawn"`)
      ensure(config.maxParallel === 4, `apply() received maxParallel=${JSON.stringify(config.maxParallel)}; expected schemastery default 4`)
      ensure(config.maxTotalAgents === 32, `apply() received maxTotalAgents=${JSON.stringify(config.maxTotalAgents)}; expected schemastery default 32`)

      ensure(registeredEvent !== undefined, 'instrumented copy recorded no registered event after ctx.tools.register()')
      ensure(registeredEvent.tool === 'deep_research', `ctx.tools.get('deep_research') resolved to ${JSON.stringify(registeredEvent.tool)} after registration`)
      ensure(registeredEvent.hasOutputSchema === true, 'registered deep_research tool has no output schema')

      const boot = await waitForLog(server, (text) => /[?&]token=[A-Za-z0-9_-]+/.test(text))
      const log = boot.log
      const badLines = log
        .split(/\r?\n/)
        .filter((line) => (line.includes(PLUGIN_ID) || line.includes(PLUGIN_NAME)) && /\b(?:error|warn|warning|fail(?:ed|ure)?|did not activate|pending|inactive)\b/i.test(line))
      ensure(badLines.length === 0, `loader diagnostics name the plugin: ${badLines.join(' | ')}`)

      const stop = await terminateDsh(server)
      ensure(stop.exited, `instrumented web process did not exit within ${STOP_TIMEOUT_MS}ms of SIGTERM (forced=${stop.forced})`)
      ensure(sha256(deliverableSource) === deliverableHashBefore, 'the deliverable src/index.js changed during the instrumented boot')

      state.instrumented = {
        port,
        readyMs: ready.ms,
        profile: INSTRUMENTED_PROFILE,
        argv: args.join(' '),
        events,
        applyEvent,
        registeredEvent,
        shutdown: stop,
        deliverableUntouched: true,
        deliverableSha256: deliverableHashBefore,
        tracePath: built.tracePath,
        logPath: ARTIFACTS.instrumentedLog,
      }
      return {
        evidence: `instrumented copy booted in scratch profile ${INSTRUMENTED_PROFILE} on 127.0.0.1:${port} (ready in ${ready.ms}ms): trace recorded apply {tools:"object", subagents:"object", config:{childProvider:"spawn", maxParallel:4, maxTotalAgents:32}} then registered {tool:"deep_research", hasOutputSchema:true} from ctx.tools.get(); no loader diagnostic names the plugin; deliverable src/index.js sha256 ${deliverableHashBefore.slice(0, 16)}… unchanged`,
        detail: { port, readyMs: ready.ms, applyEvent, registeredEvent, shutdown: stop, tracePath: built.tracePath, logPath: ARTIFACTS.instrumentedLog, deliverableSha256: deliverableHashBefore },
      }
    } finally {
      if (server.child.exitCode === null && server.child.signalCode === null) {
        try {
          server.child.kill('SIGKILL')
        } catch {
          /* already gone */
        }
      }
    }
  })
}

async function check7DisplayMetadataAndPublish() {
  await check('7', 'plugin display metadata + publish surface', async () => {
    ensure(state.profileDir !== undefined, 'scratch profile not installed (check 3 failed)')
    const packagePath = path.join(WORKSPACE, 'package.json')
    const pkg = JSON.parse(readText(packagePath))
    ensure(pkg.name === PLUGIN_NAME, `package.json name is ${JSON.stringify(pkg.name)}, expected ${JSON.stringify(PLUGIN_NAME)}`)

    // ── (a) official display-metadata reader, resolved from the scratch profile
    const profileManifestUrl = pathToFileURL(path.join(state.profileDir, 'package.json')).href
    let appBoot
    try {
      appBoot = await loadInstalledAppBoot()
    } catch (error) {
      throw new Error(`could not import the installed @deepseek-ai/dsh-app-boot from ${APP_BOOT_ENTRY}: ${error instanceof Error ? error.message : String(error)}`)
    }
    ensure(typeof appBoot.readPluginMeta === 'function', 'installed @deepseek-ai/dsh-app-boot does not export readPluginMeta')
    ensure(typeof appBoot.resolvePluginResource === 'function', 'installed @deepseek-ai/dsh-app-boot does not export resolvePluginResource')
    const appBootVersion = JSON.parse(readText(APP_BOOT_PACKAGE)).version

    const meta = appBoot.readPluginMeta(PLUGIN_NAME, profileManifestUrl)
    ensure(meta !== undefined && typeof meta === 'object', `readPluginMeta(${PLUGIN_NAME}) returned ${JSON.stringify(meta)}`)
    ensure(meta.error === undefined, `readPluginMeta reported an error: ${meta.error}`)

    const locale = {
      en: JSON.parse(readText(path.join(WORKSPACE, 'locale', 'en.json'))).meta,
      zh: JSON.parse(readText(path.join(WORKSPACE, 'locale', 'zh.json'))).meta,
    }
    ensure(meta.title?.en === DISPLAY_TITLE.en, `title.en is ${JSON.stringify(meta.title?.en)}, expected ${JSON.stringify(DISPLAY_TITLE.en)}`)
    ensure(meta.title?.zh === DISPLAY_TITLE.zh, `title.zh is ${JSON.stringify(meta.title?.zh)}, expected ${JSON.stringify(DISPLAY_TITLE.zh)}`)
    for (const language of ['en', 'zh']) {
      const expectedDescription = locale[language]?.description
      ensure(typeof expectedDescription === 'string' && expectedDescription.trim().length > 0, `locale/${language}.json meta.description is empty`)
      ensure(meta.description?.[language] === expectedDescription, `description.${language} mismatch: readPluginMeta=${JSON.stringify(meta.description?.[language])} locale=${JSON.stringify(expectedDescription)}`)
    }

    const iconPath = path.join(WORKSPACE, 'assets', 'icon.svg')
    const iconBytes = fs.readFileSync(iconPath)
    const iconPrefix = 'data:image/svg+xml;base64,'
    ensure(typeof meta.icon === 'string' && meta.icon.startsWith(iconPrefix), `icon is not a ${iconPrefix} data URL: ${clip(String(meta.icon), 80)}`)
    const decodedIcon = Buffer.from(meta.icon.slice(iconPrefix.length), 'base64')
    ensure(decodedIcon.length > 100, `decoded icon is only ${decodedIcon.length} bytes, expected > 100`)
    ensure(decodedIcon.length === iconBytes.length && decodedIcon.equals(iconBytes), `decoded icon (${decodedIcon.length} bytes) does not equal assets/icon.svg (${iconBytes.length} bytes)`)
    ensure(/^<svg[\s>]/i.test(decodedIcon.toString('utf8').trimStart()), 'decoded icon does not start with an <svg> element')

    const resourcePackageRoot = fs.realpathSync(WORKSPACE)
    const resourceChecks = []
    for (const [suffix, expectedRelative] of [['/locale/en.json', 'locale/en.json'], ['/locale/zh.json', 'locale/zh.json'], ['/icon', 'assets/icon.svg'], ['/cordis.patch.yml', 'cordis.patch.yml']]) {
      const resolved = appBoot.resolvePluginResource(PLUGIN_NAME + suffix, profileManifestUrl)
      const real = fs.realpathSync(resolved)
      const expectedReal = fs.realpathSync(path.join(WORKSPACE, expectedRelative))
      ensure(path.isAbsolute(real), `${PLUGIN_NAME}${suffix} resolved to a non-absolute path: ${real}`)
      ensure(real === expectedReal, `${PLUGIN_NAME}${suffix} resolved to ${real}, expected ${expectedReal}`)
      const relative = path.relative(resourcePackageRoot, real)
      ensure(relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), `${PLUGIN_NAME}${suffix} resolves outside the package root: ${real}`)
      resourceChecks.push({ specifier: PLUGIN_NAME + suffix, resolved: real, packageRelative: relative, insidePackage: true })
    }
    for (const subpath of ['./icon', './locale/*.json', './cordis.patch.yml', './package.json']) {
      ensure(pkg.exports?.[subpath] !== undefined, `package.json exports is missing ${subpath} (needed by the official reader)`)
    }

    // ── (b) publish surface: npm pack --dry-run --json (offline, no lifecycle scripts)
    fs.mkdirSync(NPM_CACHE_DIR, { recursive: true })
    const packRun = await runCommand('npm', ['pack', '--dry-run', '--json', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'], {
      cwd: WORKSPACE,
      timeoutMs: NPM_PACK_TIMEOUT_MS,
      env: { ...process.env, npm_config_cache: NPM_CACHE_DIR },
    })
    fs.writeFileSync(ARTIFACTS.npmPackJson, packRun.stdout)
    fs.writeFileSync(ARTIFACTS.npmPackErr, packRun.stderr)
    ensure(!packRun.timedOut, `npm pack --dry-run timed out after ${NPM_PACK_TIMEOUT_MS}ms`)
    ensure(packRun.code === 0, `npm pack --dry-run exited ${packRun.code}: ${firstLines(packRun.stderr)}`)
    let packDocument
    try {
      packDocument = JSON.parse(packRun.stdout)
    } catch {
      throw new Error(`npm pack --json output is not JSON: ${firstLines(packRun.stdout)}`)
    }
    const packEntry = Array.isArray(packDocument) ? packDocument[0] : Object.values(packDocument)[0]
    ensure(packEntry !== undefined && Array.isArray(packEntry.files), 'npm pack JSON has no files[] array')
    const packedFiles = packEntry.files.map((file) => file.path).sort()
    const packedSet = new Set(packedFiles)
    const missingRequired = PACK_REQUIRED_FILES.filter((file) => !packedSet.has(file))
    ensure(missingRequired.length === 0, `npm pack is missing required published files: ${missingRequired.join(', ')}`)
    const docsPacked = packedFiles.filter((file) => file === 'docs' || file.startsWith('docs/'))
    ensure(docsPacked.length > 0, 'npm pack ships no docs/* files although the files whitelist names docs')
    const forbiddenPacked = packedFiles.filter((file) => PACK_FORBIDDEN_PREFIXES.some((prefix) => (prefix.endsWith('/') ? file.startsWith(prefix) : file === prefix)))
    ensure(forbiddenPacked.length === 0, `npm pack ships files outside the files whitelist: ${forbiddenPacked.join(', ')}`)

    // ── (c) manifest version, runtime engine range, patch row identity
    ensure(pkg.dsh?.manifestVersion === 1, `dsh.manifestVersion is ${JSON.stringify(pkg.dsh?.manifestVersion)}, expected 1`)
    ensure(typeof pkg.engines?.dsh === 'string' && pkg.engines.dsh.trim().length > 0, 'engines.dsh is missing')
    const runtimeVersion = state.dshVersion ?? EXPECTED_DSH
    ensure(satisfiesRange(runtimeVersion, pkg.engines.dsh), `engines.dsh ${JSON.stringify(pkg.engines.dsh)} does not accept the installed runtime ${JSON.stringify(runtimeVersion)}`)
    const patchRow = patchRowName(readText(path.join(WORKSPACE, 'cordis.patch.yml')))
    ensure(patchRow === pkg.name, `patch row name ${JSON.stringify(patchRow)} does not equal the package name ${JSON.stringify(pkg.name)}`)

    const displayMetadata = {
      title: meta.title,
      description: meta.description,
      icon: {
        mediaType: meta.icon.slice('data:'.length, meta.icon.indexOf(';')),
        dataUrlLength: meta.icon.length,
        decodedBytes: decodedIcon.length,
        matchesAssetIcon: true,
        svgPrefix: decodedIcon.toString('utf8').trimStart().slice(0, 40),
      },
    }
    const publishSurface = {
      packEntryCount: packedFiles.length,
      files: packedFiles,
      requiredPresent: PACK_REQUIRED_FILES,
      docsPacked,
      forbidden: forbiddenPacked,
      manifestVersion: pkg.dsh.manifestVersion,
      enginesDsh: pkg.engines.dsh,
      runtimeVersion,
      patchRowName: patchRow,
      publishConfigAccess: pkg.publishConfig?.access ?? null,
    }
    state.displayMetadata = displayMetadata
    state.publishSurface = publishSurface
    return {
      evidence: `official readPluginMeta (installed dsh-app-boot ${appBootVersion}, parent URL profiles/dr/package.json): title en=${JSON.stringify(meta.title.en)} zh=${JSON.stringify(meta.title.zh)}; en/zh descriptions match locale files; icon ${iconPrefix}… decodes to assets/icon.svg (${decodedIcon.length} bytes, <svg>); 4/4 resources (/locale/en.json /locale/zh.json /icon /cordis.patch.yml) resolve inside the package root; npm pack --dry-run ships ${packedFiles.length} files (required ${PACK_REQUIRED_FILES.length}/${PACK_REQUIRED_FILES.length} + ${docsPacked.length} docs, zero node_modules/_verify/_ref/test/scripts); dsh.manifestVersion=1; engines.dsh ${JSON.stringify(pkg.engines.dsh)} accepts ${runtimeVersion}; patch row name = ${patchRow}`,
      detail: {
        appBoot: { entry: APP_BOOT_ENTRY, version: appBootVersion },
        parentUrl: profileManifestUrl,
        displayMetadata,
        localeMeta: locale,
        resources: resourceChecks,
        publishSurface: {
          packEntryCount: packedFiles.length,
          files: packedFiles,
          docsPacked,
          forbidden: forbiddenPacked,
          npmPackJson: ARTIFACTS.npmPackJson,
        },
        manifest: { name: pkg.name, version: pkg.version, manifestVersion: pkg.dsh.manifestVersion, enginesDsh: pkg.engines.dsh, runtimeVersion, patchRowName: patchRow, publishConfigAccess: pkg.publishConfig?.access ?? null },
      },
    }
  })
}

// ── Reports ─────────────────────────────────────────────────────────────────
function buildReport(extra) {
  const ok = checks.length > 0 && checks.every((entry) => entry.status === 'PASS')
  const failed = checks.filter((entry) => entry.status === 'FAIL')
  return {
    schema: 'dsh-deep-research/profile-verification/1',
    generatedAt: new Date().toISOString(),
    ok,
    reproduce: 'node scripts/verify-profile.mjs',
    workspace: WORKSPACE,
    dsh: { bin: DSH_BIN, expectedVersion: EXPECTED_DSH, version: state.dshVersion ?? null },
    scratchHome: DSH_HOME,
    realHomeTouched: false,
    checks,
    summary: { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
    boot: state.boot ?? null,
    activationControl: state.control ?? null,
    activationProof: state.instrumented ?? null,
    displayMetadata: state.displayMetadata ?? null,
    publishSurface: state.publishSurface ?? null,
    loaderDiagnostics: extra.loaderDiagnostics,
    investigation: extra.investigation,
    notes: extra.notes,
    artifacts: ARTIFACTS,
  }
}

function renderMarkdown(report) {
  const lines = []
  lines.push('# Profile-level verification — `@shmming/dsh-deep-research`')
  lines.push('')
  lines.push(`**Overall verdict: ${report.ok ? 'PASS' : 'FAIL'}** (${report.summary.passed}/${report.summary.total} checks passed)`)
  lines.push('')
  lines.push(`- Generated: ${report.generatedAt}`)
  lines.push(`- DSH: \`${report.dsh.bin}\` version \`${report.dsh.version ?? 'unknown'}\` (target \`${report.dsh.expectedVersion}\`)`)
  lines.push(`- Scratch home: \`${report.scratchHome}\` — inside the workspace; the real \`~/.dsh\` was never touched`)
  lines.push(`- Reproduce: \`${report.reproduce}\` (no model calls, no credentials, no network)`)
  lines.push('')
  lines.push('## Checks')
  lines.push('')
  lines.push('| # | Check | Result | Evidence |')
  lines.push('|---|---|---|---|')
  for (const entry of report.checks) {
    const evidence = String(entry.evidence ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
    lines.push(`| ${entry.id} | ${entry.title} | **${entry.status}** | ${evidence} |`)
  }
  lines.push('')
  lines.push('## Activation proof (instrumented throwaway copy, real boot)')
  lines.push('')
  const proof = report.activationProof
  if (proof === null || proof === undefined) {
    lines.push('Not available — check 6c did not complete.')
  } else {
    lines.push(`Scratch profile \`${proof.profile}\` linked the throwaway instrumented copy under \`${ARTIFACTS.instrumentedDir}\` and booted on 127.0.0.1:${proof.port} (ready in ${proof.readyMs}ms).`)
    lines.push('')
    lines.push(`Trace file: \`${proof.tracePath}\``)
    lines.push('')
    lines.push('```json')
    lines.push(JSON.stringify(proof.applyEvent))
    lines.push(JSON.stringify(proof.registeredEvent))
    lines.push('```')
    lines.push('')
    lines.push(`The deliverable \`src/index.js\` is sha256-verified unchanged (\`${proof.deliverableSha256}\`); the copy is disposable and gitignored.`)
  }
  lines.push('')
  lines.push('## Display metadata + publish surface')
  lines.push('')
  if (report.displayMetadata === null || report.displayMetadata === undefined) {
    lines.push('Not available — check 7 did not complete.')
  } else {
    lines.push('`readPluginMeta` from the installed official `@deepseek-ai/dsh-app-boot`, resolved from the scratch profile:')
    lines.push('')
    lines.push('```json')
    lines.push(JSON.stringify(report.displayMetadata, null, 2))
    lines.push('```')
    lines.push('')
    const surface = report.publishSurface
    lines.push(`- npm pack --dry-run: **${surface.packEntryCount} files**, required ${surface.requiredPresent.length}/${surface.requiredPresent.length} present, ${surface.docsPacked.length} docs file(s), forbidden paths: ${surface.forbidden.length === 0 ? 'none' : `**${surface.forbidden.join(', ')}**`}.`)
    lines.push(`- Manifest: \`dsh.manifestVersion=${surface.manifestVersion}\`; \`engines.dsh=${surface.enginesDsh}\` accepts \`${surface.runtimeVersion}\`; patch row name \`${surface.patchRowName}\`; publishConfig.access \`${surface.publishConfigAccess}\`.`)
    lines.push(`- Resources resolved inside the package root: ${report.checks.find((entry) => entry.id === '7')?.detail?.resources?.map((resource) => `\`${resource.packageRelative}\``).join(', ') ?? '(see JSON)'}.`)
  }
  lines.push('')
  lines.push('## Loader diagnostics')
  lines.push('')
  const loader = report.loaderDiagnostics
  if (loader.schemaDiagnostics.length === 0 && loader.bootLog.length === 0 && loader.controlLog.length === 0) {
    lines.push('None — no `dsh: warning:`/`dsh: error:` line appeared on the valid boot, and the schema dump\'s diagnostics are byte-identical to the untouched web template.')
  } else {
    lines.push('Schema dump (`--dump-config-schema`), identical to the pristine web template:')
    lines.push('')
    for (const line of loader.schemaDiagnostics) lines.push(`- \`${line}\``)
    lines.push('')
    if (loader.bootLog.length > 0) {
      lines.push('Valid boot log diagnostic lines:')
      for (const line of loader.bootLog) lines.push(`- \`${line}\``)
    } else {
      lines.push('Valid boot log: no diagnostic/warning lines at all (only the authenticated `dsh web:` URL).')
    }
    if (loader.controlLog.length > 0) {
      lines.push('')
      lines.push('Intentional activation-control boot (expected failure):')
      for (const line of loader.controlLog) lines.push(`- \`${line}\``)
    }
  }
  lines.push('')
  lines.push('## Investigation: is tool registration observable without a model call?')
  lines.push('')
  for (const line of report.investigation.finding) lines.push(`- ${line}`)
  lines.push('')
  lines.push('## Artifacts')
  lines.push('')
  for (const [key, value] of Object.entries(report.artifacts)) lines.push(`- \`${key}\`: \`${value}\``)
  lines.push('')
  return lines.join('\n')
}

function writeReports(extra) {
  const report = buildReport(extra)
  fs.writeFileSync(ARTIFACTS.reportJson, `${JSON.stringify(report, null, 2)}\n`)
  fs.writeFileSync(ARTIFACTS.reportMd, renderMarkdown(report))
  return report
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  fs.mkdirSync(VERIFY_DIR, { recursive: true })
  console.log('dsh-deep-research — profile-level install/load verification')
  console.log(`runtime: ${DSH_BIN}   scratch DSH_HOME: ${DSH_HOME}`)
  console.log('')

  state.dshVersion = (await runCommand(DSH_BIN, ['--version'], { cwd: WORKSPACE, env: { ...process.env, DSH_HOME } })).stdout.trim() || null
  state.dshVersion = state.dshVersion === '' ? null : state.dshVersion

  await check1Preconditions()
  await check2ScratchHome()
  await check3LinkPlugin()
  await check4ComposedConfig()
  await check5ConfigSchema()
  await check6aBootSmoke()
  await check6bActivationControl()
  await check6cApplyRegistration()
  await check7DisplayMetadataAndPublish()

  // Collect diagnostics for the report.
  const bootLogLines = (state.boot?.pluginLogLines ?? []).slice()
  const bootDiagnostics = bootLogLines.filter((line) => /\b(?:error|warn|warning|fail(?:ed|ure)?|did not activate|pending|inactive)\b/i.test(line))
  const controlDiagnostics = (state.control?.diagnosticLines ?? []).slice()
  const schemaDiagnostics = diagLines(state.schemaDiagnostics ?? [])
  const extra = {
    loaderDiagnostics: {
      schemaDiagnostics,
      bootLog: bootDiagnostics,
      controlLog: controlDiagnostics,
    },
    investigation: {
      finding: [
        'The valid web boot log prints only the authenticated `dsh web: <url>?token=…` line. Info-level plugin logs are not surfaced by the web boot logger (boot collects only warn/error startup diagnostics and the base composition registers no console logger exporter), so `ctx.logger.info("... registered deep_research tool ...")` never reaches stdout/stderr. "No warning" alone therefore does not prove apply() ran.',
        'Check 6c resolves this positively: a throwaway instrumented copy of the module (in `_verify/instrumented`, deliverable sha256-verified untouched) appends trace events at apply() entry and immediately after registration. A real profile boot recorded `{"event":"apply","tools":"object","subagents":"object","config":{"childProvider":"spawn","maxParallel":4,"maxTotalAgents":32}}` and `{"event":"registered","tool":"deep_research","hasOutputSchema":true}` — the loader imported the ESM module, satisfied inject [tools, subagents], applied schemastery Config defaults, and `deep_research` is resolvable through `ctx.tools` at boot.',
        'The absence of a diagnostic in the uninstrumented boot is also meaningful because the loader startup audit names failing plugins: the 6b control with an invalid config printed `dsh: warning: 1 entry did not activate` + `dsh-deep-research (@shmming/dsh-deep-research): Error: dsh-deep-research: maxParallel must be a positive integer` from `src/index.js` apply()/resolveSettings.',
        'HTTP: `/` is token/cookie fenced (401 without token; `/?token=…` → 303 + auth cookie; authenticated `/` → 200 HTML). `GET /api/*` returns 404: `/api` is the Typert RPC/WebSocket gateway (`/api/remote.mux`), not a REST surface, so no HTTP endpoint exposes the registered tool registry without a client RPC handshake.',
        'Registration proof therefore is: (a) check 6c traces apply/registration during a real profile boot; (b) check 5 imports the module in the composed profile and projects its Config schema; (c) checks 4/6a prove the composed tree settles with the row active and no diagnostic naming it; (d) unit tests exercise defineTool registration against the real installed package.',
      ],
      httpProbes: [
        'first `GET /` before auth: HTTP 401 (auth fence)',
        '`GET /?token=<printed token>`: HTTP 303 + Set-Cookie auth cookie',
        'authenticated `GET /`: HTTP 200, HTML document (~38 KB)',
        '`GET /api/plugins|/api/tools|/api/health|/api/status|/api/meta|/api/inventory`: HTTP 404 (RPC gateway, no REST tool inventory)',
      ],
    },
    notes: [
      'Boot command is `dsh --profile dr --port <free> --no-open` (a positional `web` after `--profile dr` is treated as an app argument and rejected by the web app with "error: too many arguments. Expected 0 arguments but got 1: web.").',
      'Check 5 does not assert exit code 0: DSH 0.2.1-rc.3 `--dump-config-schema` already exits 1 on the untouched shipped web template (four upstream "unrecognized Loader tree carrier" errors at /187-/190). The plugin run\'s diagnostics are byte-identical to that baseline and our schema entry is status "schema", so the check asserts the plugin-attributable evidence instead.',
      'Check 6b boots the same profile with an intentionally invalid plugin config via a `--patch` argv overlay (never written into the installed profile) solely to prove apply() runs; its "failure" is expected and does not mean the plugin is broken.',
      'Check 6c boots a separate scratch profile (`dri`) that links a throwaway instrumented copy of the module under `_verify/instrumented`; the deliverable `src/index.js` is sha256-verified unchanged before and after.',
      'Check 7 imports the official plugin-metadata reader from the DSH installation itself (`/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js`, imported by absolute file URL) and resolves the plugin from the scratch profile manifest URL `_verify/home/profiles/dr/package.json`, so the display metadata is read exactly as DSH reads it. `npm pack --dry-run --json --ignore-scripts` runs offline with `npm_config_cache` redirected into `_verify/npm-cache` (the real home is read-only); no tarball is written.',
      `Before each boot the script clears stale cross-process writer locks/atomic temp files from its own scratch home (${(state.clearedLocks ?? []).length === 0 ? 'none found this run' : `removed: ${(state.clearedLocks ?? []).join(', ')}`}). DSH records lock-holder PIDs in \`.lock\` siblings; a lock left by an aborted boot is waited out rather than taken over, which leaves the loader unsettled (host webserver listening with a bare 404 and no printed URL). The scratch home has no other writers, so this cannot race anything.`,
    ],
  }
  // Grab the schema diagnostics from the check-5 detail through the recorded checks.
  const schemaCheck = checks.find((entry) => entry.id === '5')
  extra.loaderDiagnostics.schemaDiagnostics = schemaCheck?.detail?.upstreamDiagnostics ?? []

  const report = writeReports(extra)
  report.dsh.version = state.dshVersion

  console.log('')
  console.log('──────────────────────────────────────────────────────────────────────')
  console.log('RESULT')
  console.log('──────────────────────────────────────────────────────────────────────')
  for (const entry of report.checks) {
    console.log(`${entry.status === 'PASS' ? 'PASS' : 'FAIL'}  ${entry.id}  ${entry.title}`)
  }
  console.log('')
  console.log(`checks: ${report.summary.passed}/${report.summary.total} passed`)
  console.log(`report: ${ARTIFACTS.reportJson}`)
  console.log(`report: ${ARTIFACTS.reportMd}`)
  console.log(`boot log: ${ARTIFACTS.bootLog}`)
  console.log('')
  console.log(`OVERALL: ${report.ok ? 'PASS' : 'FAIL'}`)
  return report.ok ? 0 : 1
}

let exitCode = 1
try {
  exitCode = await main()
} catch (error) {
  console.error(`\nverify-profile: unhandled failure: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  exitCode = 1
} finally {
  for (const child of runningChildren) {
    try {
      child.kill('SIGKILL')
    } catch {
      /* already gone */
    }
  }
  process.exit(exitCode)
}
