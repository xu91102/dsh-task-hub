/**
 * Patch the installed workspace browser to expose a navigation slot between
 * its section header and the session list.
 *
 * DeepSeek Harness owns that layout and currently exposes only the whole
 * `sidebar.workspaces` surface. The Task Hub needs the same hierarchy Multica
 * uses: workspace navigation after the Workspace heading, before workspace
 * content. The additive list slot keeps that placement available to plugins
 * without replacing the host's session browser.
 *
 * Usage: node scripts/patch-ui-workspace-client.mjs [roots...]
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const relative = join('node_modules', '@deepseek-ai', 'dsh-client-ui-workspace', 'lib', 'client.js')

const targets = new Set([
  resolve(repoRoot, relative),
  ...process.argv.slice(2).map(root => resolve(root, relative)),
])

const nvmDir = join(homedir(), '.nvm', 'versions', 'node')
if (existsSync(nvmDir)) {
  for (const entry of readdirSafe(nvmDir)) {
    targets.add(resolve(nvmDir, entry, 'lib', 'node_modules', '@deepseek-ai', 'dsh', relative))
  }
}

function readdirSafe(dir) {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

const MARKER = '"sidebar.workspaces.action"'

function patchOnce(text, from, to, label) {
  if (text.includes(to)) return { text, applied: false }
  if (!text.includes(from)) {
    throw new Error(
      `patch-ui-workspace-client: anchor for "${label}" not found — re-derive it for this package version`,
    )
  }
  return { text: text.replace(from, to), applied: true }
}

function patchFile(path) {
  let text = readFileSync(path, 'utf8')
  if (text.includes(MARKER)) return 'already patched'

  ;({ text } = patchOnce(
    text,
    ['\t\t\t\t\t}),\n', '\t\t\t\t\t!wide && (0, react_jsx_runtime.jsx)("div", {'].join(''),
    [
      '\t\t\t\t\t}),\n',
      '\t\t\t\t\t(0, react_jsx_runtime.jsx)("div", {\n',
      '\t\t\t\t\t\tchildren: renderSlot("sidebar.workspaces.action", { wide })\n',
      '\t\t\t\t\t}),\n',
      '\t\t\t\t\t!wide && (0, react_jsx_runtime.jsx)("div", {',
    ].join(''),
    'workspace navigation render site',
  ))

  ;({ text } = patchOnce(
    text,
    [
      'children: { "sidebar.workspaces.directoryFlow": {\n',
      '\t\t\t\t\tkind: "single",\n',
      '\t\t\t\t\tscope: "root"\n',
      '\t\t\t\t} },',
    ].join(''),
    [
      'children: {\n',
      '\t\t\t\t"sidebar.workspaces.directoryFlow": {\n',
      '\t\t\t\t\tkind: "single",\n',
      '\t\t\t\t\tscope: "root"\n',
      '\t\t\t\t},\n',
      '\t\t\t\t"sidebar.workspaces.action": {\n',
      '\t\t\t\t\tkind: "list",\n',
      '\t\t\t\t\tscope: "root"\n',
      '\t\t\t\t}\n',
      '\t\t\t},',
    ].join(''),
    'workspace child-slot declaration',
  ))

  writeFileSync(path, text)
  return 'patched'
}

let patched = 0
for (const target of targets) {
  if (!existsSync(target)) continue
  const result = patchFile(target)
  if (result === 'patched') patched += 1
  console.log(`[patch-ui-workspace-client] ${target}: ${result}`)
}
console.log(
  `[patch-ui-workspace-client] done — ${patched} file(s) patched, ${targets.size} candidate(s)`,
)
