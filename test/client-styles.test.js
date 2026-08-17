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

test('opening an execution session switches the selected session back to chat', async () => {
  const client = await readFile(resolve(import.meta.dirname, '../lib/client.js'), 'utf8')
  assert.match(client, /sessions\.open\(id\)[\s\S]{0,160}openConversationView\(ctx, id\)/u)
  assert.match(client, /conversationViewControl\(ctx\)\?\.open\(sessionId, CHAT_VIEW_ID\)/u)
})
