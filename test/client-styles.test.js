import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'

test('the Task Hub workspace suppresses the conversation composer seat', async () => {
  const client = await readFile(resolve(import.meta.dirname, '../lib/client.js'), 'utf8')
  assert.match(
    client,
    /\[data-conversation-scroll\]:has\(\.tb-task-hub-workspace\)\s*>\s*\[data-composer-seat\]\s*\{[^}]*display:\s*none/u,
  )
})
