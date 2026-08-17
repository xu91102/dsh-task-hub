/**
 * Patch the installed ui-sidebar client to render a `sidebar.action.top` slot
 * between the New Session button and the workspace browser region.
 *
 * Why a patch: the sidebar shell (published @deepseek-ai package) owns the
 * column's layout and declares the slots other plugins may fill. The
 * orchestrator wants a "New taskboard" button directly below New Session, and
 * that spot has no slot — this patch adds one (a `list`, so it is additive and
 * other plugins may join it later).
 *
 * Everything here is idempotent: the marker (`sidebar.action.top` in the
 * children table) makes a second run a no-op, and each replacement anchors on
 * literal text that appears exactly once.
 *
 * Targets, in order:
 *   1. every root passed on the command line (a directory containing
 *      node_modules/@deepseek-ai/...);
 *   2. this package's own node_modules copy (dev/type-resolution copy);
 *   3. the CLI install's copy under ~/.nvm (the one `dsh` actually serves to
 *      browsers) — globbed, not hardcoded, so version bumps keep working.
 *
 * Usage: node scripts/patch-ui-sidebar-client.mjs [roots...]
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const relative = join('node_modules', '@deepseek-ai', 'dsh-client-ui-sidebar', 'lib', 'client.js')

/** Every candidate target file that exists. */
const targets = new Set(
  [
    join(repoRoot, 'node_modules', '@deepseek-ai', 'dsh-client-ui-sidebar', 'lib', 'client.js'),
    // CLI install copies: one per node version that has the dsh CLI installed.
    join(homedir(), '.nvm', 'versions', 'node'),
  ].map(candidate => resolve(candidate)),
)

// The nvm parent is a directory to glob, not a file: drop it and expand.
targets.delete(join(homedir(), '.nvm', 'versions', 'node'))
const nvmDir = join(homedir(), '.nvm', 'versions', 'node')
if (existsSync(nvmDir)) {
  for (const entry of readdirSafe(nvmDir)) {
    targets.add(
      resolve(
        nvmDir,
        entry,
        'lib',
        'node_modules',
        '@deepseek-ai',
        'dsh',
        'node_modules',
        '@deepseek-ai',
        'dsh-client-ui-sidebar',
        'lib',
        'client.js',
      ),
    )
  }
}
for (const root of process.argv.slice(2)) targets.add(resolve(root, relative))

function readdirSafe(dir) {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

const MARKER = '"sidebar.action.top"'

/** One idempotent string replacement. */
function patchOnce(text, from, to, label) {
  if (text.includes(to)) {
    // Already applied.
    return { text, applied: false, label }
  }
  if (!text.includes(from)) {
    throw new Error(
      `patch-ui-sidebar-client: anchor for "${label}" not found — the package version likely changed; re-derive the anchors`,
    )
  }
  return { text: text.replace(from, to), applied: true, label }
}

/** Apply every replacement to one target file. */
function patchFile(path) {
  let text = readFileSync(path, 'utf8')
  if (text.includes(MARKER)) return 'already patched'

  // 1. The JSX render site: render the new slot between the New Session
  //    button and the workspace browser region.
  ;({ text } = patchOnce(
    text,
    [
      '\t\t\t\t\t}),\n',
      '\t\t\t\t\t(0, react_jsx_runtime.jsx)("div", {\n',
      '\t\t\t\t\t\tclassName: SidebarRoot_module_css_default.regionArea,',
    ].join(''),
    [
      '\t\t\t\t\t}),\n',
      '\t\t\t\t\t(0, react_jsx_runtime.jsx)("div", {\n',
      '\t\t\t\t\t\tclassName: SidebarRoot_module_css_default.actionTop,\n',
      '\t\t\t\t\t\tchildren: renderSlot("sidebar.action.top", {\n',
      '\t\t\t\t\t\t\twide,\n',
      '\t\t\t\t\t\t\texpandSidebar: () => {\n',
      '\t\t\t\t\t\t\t\tif (collapsed) toggleSidebar();\n',
      '\t\t\t\t\t\t\t}\n',
      '\t\t\t\t\t\t})\n',
      '\t\t\t\t\t}),\n',
      '\t\t\t\t\t(0, react_jsx_runtime.jsx)("div", {\n',
      '\t\t\t\t\t\tclassName: SidebarRoot_module_css_default.regionArea,',
    ].join(''),
    'jsx render site',
  ))

  // 2. The children declaration (declaring is claiming — without it the
  //    render call is unauthorized).
  ;({ text } = patchOnce(
    text,
    [
      '\t\t\t\tchildren: {\n',
      '\t\t\t\t\t"sidebar.workspaces": {\n',
      '\t\t\t\t\t\tkind: "single",\n',
      '\t\t\t\t\t\tscope: "root"\n',
      '\t\t\t\t\t},',
    ].join(''),
    [
      '\t\t\t\tchildren: {\n',
      '\t\t\t\t\t"sidebar.workspaces": {\n',
      '\t\t\t\t\t\tkind: "single",\n',
      '\t\t\t\t\t\tscope: "root"\n',
      '\t\t\t\t\t},\n',
      '\t\t\t\t\t"sidebar.action.top": {\n',
      '\t\t\t\t\t\tkind: "list",\n',
      '\t\t\t\t\t\tscope: "root"\n',
      '\t\t\t\t\t},',
    ].join(''),
    'children declaration',
  ))

  // 3. The CSS-module class map entry.
  ;({ text } = patchOnce(
    text,
    '"newSessionLabel": "hHd-Xa_newSessionLabel"',
    '"newSessionLabel": "hHd-Xa_newSessionLabel", "actionTop": "hHd-Xa_actionTop"',
    'css class map',
  ))

  // 4. The stylesheet rules (anchored on the final reduced-motion block).
  ;({ text } = patchOnce(
    text,
    '@media (prefers-reduced-motion:reduce){.hHd-Xa_wide,.hHd-Xa_fading>*,.hHd-Xa_railIn .hHd-Xa_iconButton,.hHd-Xa_railIn .hHd-Xa_newSession,.hHd-Xa_railIn .hHd-Xa_footArea,.hHd-Xa_railIn .hHd-Xa_regionArea{transition:none;animation:none}}',
    [
      '.hHd-Xa_actionTop{flex:none;flex-direction:column;display:flex}.hHd-Xa_actionTop:empty{display:none}.hHd-Xa_collapsed .hHd-Xa_actionTop{align-items:center;padding:0 10px}.hHd-Xa_railIn .hHd-Xa_actionTop{animation:hHd-Xa_rail-in .15s var(--ds-ease-in-out) backwards}',
      '@media (prefers-reduced-motion:reduce){.hHd-Xa_wide,.hHd-Xa_fading>*,.hHd-Xa_railIn .hHd-Xa_iconButton,.hHd-Xa_railIn .hHd-Xa_newSession,.hHd-Xa_railIn .hHd-Xa_footArea,.hHd-Xa_railIn .hHd-Xa_regionArea,.hHd-Xa_railIn .hHd-Xa_actionTop{transition:none;animation:none}}',
    ].join(''),
    'css rules',
  ))

  writeFileSync(path, text)
  return 'patched'
}

let patched = 0
for (const target of targets) {
  if (!existsSync(target)) continue
  const result = patchFile(target)
  if (result === 'patched') patched += 1
  console.log(`[patch-ui-sidebar-client] ${target}: ${result}`)
}
console.log(
  `[patch-ui-sidebar-client] done — ${patched} file(s) patched, ${targets.size} candidate(s)`,
)
