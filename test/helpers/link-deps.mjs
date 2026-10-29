/**
 * Link the DSH installation's peer packages into the workspace `node_modules`
 * so the plugin's bare imports resolve when it is loaded outside a DSH profile.
 *
 * The plugin (`src/index.js`) imports `defineTool` from `@deepseek-ai/dsh-tools`
 * and schemastery from `@deepseek-ai/schemastery`. In a real DSH profile the
 * profile's `node_modules` provides them; a plain checkout does not. This helper
 * makes the workspace layout mimic a profile by symlinking the installed
 * packages (never copying them), so tests compile the tool definition against
 * the *actual* installed 0.2.1-rc.3 packages.
 *
 * Idempotent: an existing correct link is left untouched; a stale link is
 * replaced; any real directory/file at the destination is never removed.
 *
 * The created `node_modules/` tree is gitignored and is a runtime artifact, not
 * source.
 */

import { existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Absolute path of the plugin checkout (`test/helpers/` -> repo root). */
export const WORKSPACE_ROOT = fileURLToPath(new URL('../../', import.meta.url))

/** DSH installation root; `DSH_INSTALL_ROOT` overrides it for other installs. */
export const DSH_INSTALL_ROOT = process.env.DSH_INSTALL_ROOT ?? '/usr/lib/node_modules/@deepseek-ai/dsh'

/** Directory holding the published @deepseek-ai packages of the installation. */
export const INSTALL_PACKAGES_ROOT = join(DSH_INSTALL_ROOT, 'node_modules', '@deepseek-ai')

/** Workspace scope directory that receives the links. */
export const WORKSPACE_PACKAGES_ROOT = join(WORKSPACE_ROOT, 'node_modules', '@deepseek-ai')

/** Peer packages the plugin needs at module-load time. */
export const LINKED_PACKAGES = Object.freeze(['dsh-tools', 'dsh-subagent', 'schemastery', 'cordis'])

/**
 * Ensure every required peer package is resolvable from the workspace.
 * @param {{ packages?: readonly string[] }} [options] - package subset override.
 * @returns {{ created: string[], existing: string[] }} what was added vs. already linked.
 */
export function ensureLinked(options = {}) {
  const packages = options.packages ?? LINKED_PACKAGES
  const created = []
  const existing = []

  for (const name of packages) {
    const target = join(INSTALL_PACKAGES_ROOT, name)
    if (!existsSync(join(target, 'package.json'))) {
      throw new Error(
        `dsh-deep-research test helper: DSH package not found: ${target} ` +
          `(set DSH_INSTALL_ROOT to the DSH installation; current: ${DSH_INSTALL_ROOT})`,
      )
    }

    const link = join(WORKSPACE_PACKAGES_ROOT, name)
    mkdirSync(dirname(link), { recursive: true })

    let stat = null
    try {
      stat = lstatSync(link)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }

    if (stat !== null) {
      if (!stat.isSymbolicLink()) {
        throw new Error(
          `dsh-deep-research test helper: refusing to replace non-symlink ${link}; ` +
            'remove it manually if it is a stale copy of the package',
        )
      }
      const current = resolve(dirname(link), readlinkSync(link))
      if (current === resolve(target)) {
        existing.push(link)
        continue
      }
      rmSync(link, { force: true })
    }

    symlinkSync(target, link, 'dir')
    created.push(link)
  }

  return { created, existing }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = ensureLinked()
  console.log(`linked packages: ${result.created.length} created, ${result.existing.length} already present`)
}
