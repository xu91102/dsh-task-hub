import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const scenario = new URL('./snapshots/builder-session/', import.meta.url)
const example = new URL('../examples/builder-session-replay.mjs', import.meta.url)

test('the runnable Builder example matches its durable keyless transcript', async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [example.pathname])
  assert.equal(stderr, '')

  const expected = JSON.parse(await readFile(new URL('session.expected.json', scenario), 'utf8'))
  assert.deepEqual(JSON.parse(stdout), expected)
})
