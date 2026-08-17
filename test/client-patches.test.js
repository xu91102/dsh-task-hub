import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'

const repoRoot = resolve(import.meta.dirname, '..')
const workspaceClientRelative = join(
  'node_modules',
  '@deepseek-ai',
  'dsh-client-ui-workspace',
  'lib',
  'client.js',
)

test('workspace patch exposes a stable navigation slot before the session list', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-task-hub-workspace-patch-'))
  try {
    const source = await readFile(join(repoRoot, workspaceClientRelative), 'utf8')
    const target = join(root, workspaceClientRelative)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, source)

    const run = () =>
      spawnSync(process.execPath, [join(repoRoot, 'scripts/patch-ui-workspace-client.mjs'), root], {
        encoding: 'utf8',
      })

    const first = run()
    assert.equal(first.status, 0, first.stderr || first.stdout)
    const patched = await readFile(target, 'utf8')
    assert.match(patched, /renderSlot\("sidebar\.workspaces\.action", \{ wide \}\)/)
    assert.match(patched, /"sidebar\.workspaces\.action": \{\s*kind: "list",\s*scope: "root"/)
    assert.ok(
      patched.indexOf('renderSlot("sidebar.workspaces.action", { wide })') <
        patched.indexOf('!wide && (0, react_jsx_runtime.jsx)("div"'),
      'navigation must render before the collapsed search and session list',
    )

    const second = run()
    assert.equal(second.status, 0, second.stderr || second.stdout)
    assert.equal(await readFile(target, 'utf8'), patched)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
