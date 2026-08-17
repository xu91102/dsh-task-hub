/**
 * Patch the installed ui-conversation client to publish a public
 * conversation-view switcher (`ctx.conversationViewControl`).
 *
 * Why a patch: the active view of a session lives in the conversation shell's
 * private per-session chat store, and only its own tab row writes it. The
 * orchestrator's sidebar entry needs to make the Taskboard tab current from
 * outside — so this patch records each session's bound store actions as they
 * are injected and exposes `open(sessionId, viewId)`, which writes the cell
 * immediately or queues the write until that session's view seat mounts
 * (whichever happens first).
 *
 * Idempotent: the marker (`conversationViewControl`) makes a second run a
 * no-op. When the patch is absent the orchestrator degrades gracefully —
 * its sidebar entry still opens the session, and the user picks the tab.
 *
 * Targets: same convention as patch-ui-sidebar-client.mjs (CLI args, then
 * this package's node_modules copy, then the CLI install under ~/.nvm).
 *
 * Usage: node scripts/patch-ui-conversation-client.mjs [roots...]
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const relative = join(
  'node_modules',
  '@deepseek-ai',
  'dsh-client-ui-conversation',
  'lib',
  'client.js',
)

const targets = new Set([
  join(repoRoot, 'node_modules', '@deepseek-ai', 'dsh-client-ui-conversation', 'lib', 'client.js'),
])
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
        'dsh-client-ui-conversation',
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

const MARKER = 'conversationViewControl'

/** One idempotent string replacement. */
function patchOnce(text, from, to, label) {
  if (text.includes(to)) return { text, applied: false, label }
  if (!text.includes(from)) {
    throw new Error(
      `patch-ui-conversation-client: anchor for "${label}" not found — the package version likely changed; re-derive the anchors`,
    )
  }
  return { text: text.replace(from, to), applied: true, label }
}

/** Apply every replacement to one target file. */
function patchFile(path) {
  let text = readFileSync(path, 'utf8')
  if (text.includes(MARKER)) return 'already patched'

  // 1. The per-session action ledger + pending write queue, in apply() scope
  //    right after the shared chat store handle is created.
  ;({ text } = patchOnce(
    text,
    '\t\t\tconst chatStore = createChatStore();',
    [
      '\t\t\tconst chatStore = createChatStore();',
      '\t\t\t// dsh-task-hub patch: per-session bound actions + pending view writes.',
      '\t\t\tconst viewActions = /* @__PURE__ */ new Map();',
      '\t\t\tconst pendingViews = /* @__PURE__ */ new Map();',
    ].join('\n'),
    'view ledger',
  ))

  // 2. Record the bound actions each time a session's view seat injects them,
  //    and flush any write that arrived before the seat mounted.
  ;({ text } = patchOnce(
    text,
    [
      '\t\t\t\tinject: (sessionId, _actions) => {',
      '\t\t\t\t\tconst conversation = concreteConversation(ctx);',
    ].join('\n'),
    [
      '\t\t\t\tinject: (sessionId, _actions) => {',
      '\t\t\t\t\tviewActions.set(sessionId, _actions);',
      '\t\t\t\t\tconst pending = pendingViews.get(sessionId);',
      '\t\t\t\t\tif (pending !== void 0) {',
      '\t\t\t\t\t\tpendingViews.delete(sessionId);',
      '\t\t\t\t\t\t_actions.setView(pending);',
      '\t\t\t\t\t}',
      '\t\t\t\t\tconst conversation = concreteConversation(ctx);',
    ].join('\n'),
    'inject capture',
  ))

  // 3. Publish the service, next to the registrations that consume it.
  ;({ text } = patchOnce(
    text,
    '\t\t\t}, ConversationSession);',
    [
      '\t\t\t}, ConversationSession);',
      '\t\t\tctx.effect(() => ctx.reflect.provide("conversationViewControl", {',
      '\t\t\t\topen: (sessionId, viewId) => {',
      '\t\t\t\t\tconst actions = viewActions.get(sessionId);',
      '\t\t\t\t\tif (actions !== void 0) actions.setView(viewId);',
      '\t\t\t\t\telse pendingViews.set(sessionId, viewId);',
      '\t\t\t\t}',
      '\t\t\t}), "dsh-task-hub patch: public conversation view control");',
    ].join('\n'),
    'service publish',
  ))

  writeFileSync(path, text)
  return 'patched'
}

let patched = 0
for (const target of targets) {
  if (!existsSync(target)) continue
  const result = patchFile(target)
  if (result === 'patched') patched += 1
  console.log(`[patch-ui-conversation-client] ${target}: ${result}`)
}
console.log(
  `[patch-ui-conversation-client] done — ${patched} file(s) patched, ${targets.size} candidate(s)`,
)
