/**
 * Load the plugin under test together with the *real* `defineTool` from the
 * installed DSH packages.
 *
 * Why dynamic imports: ESM resolves every static import (including the plugin's
 * bare `@deepseek-ai/...` specifiers) during the link phase, before any module
 * body runs. The workspace symlinks must therefore exist before the plugin
 * module graph is linked, which means the link step must happen in a helper
 * whose dynamic import is awaited first.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { DSH_INSTALL_ROOT, INSTALL_PACKAGES_ROOT, ensureLinked } from './link-deps.mjs'

/** Resolve the workspace links (idempotent) and read installed package versions. */
function installedVersions() {
  const versions = {}
  for (const name of ['dsh-tools', 'dsh-subagent', 'schemastery', 'cordis']) {
    const manifest = JSON.parse(readFileSync(join(INSTALL_PACKAGES_ROOT, name, 'package.json'), 'utf8'))
    versions[name] = manifest.version
  }
  return versions
}

let pluginPromise

/**
 * Link peer deps, then import the plugin and the real tool machinery.
 * @returns {Promise<{
 *   plugin: Record<string, unknown>,
 *   dshTools: Record<string, unknown>,
 *   schemastery: unknown,
 *   versions: Record<string, string>,
 *   links: { created: string[], existing: string[] },
 *   installRoot: string,
 * }>}
 */
export async function loadPlugin() {
  const links = ensureLinked()
  pluginPromise ??= (async () => {
    const plugin = await import('../../src/index.js')
    const dshTools = await import('@deepseek-ai/dsh-tools')
    const schemasteryModule = await import('@deepseek-ai/schemastery')
    return {
      plugin,
      dshTools,
      schemastery: schemasteryModule.default ?? schemasteryModule,
      versions: installedVersions(),
      links,
      installRoot: DSH_INSTALL_ROOT,
    }
  })()
  return pluginPromise
}

/** Absolute path of the plugin entry under test. */
export const PLUGIN_ENTRY = new URL('../../src/index.js', import.meta.url).href
