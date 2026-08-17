import assert from 'node:assert/strict'
import test from 'node:test'
import { deriveTaskDraft } from '../lib/task-create.js'

test('agent-mode task draft uses the first non-empty line as its card title', () => {
  assert.deepEqual(deriveTaskDraft('\n  修复登录失败后的错误提示  \n补充回归测试。'), {
    title: '修复登录失败后的错误提示',
    description: '修复登录失败后的错误提示  \n补充回归测试。',
  })
})

test('agent-mode task draft preserves the request while clipping a long title', () => {
  const prompt =
    '检查并修复用户登录、会话续期、退出登录以及跨标签页状态同步中所有可能导致权限状态不一致的问题，并补充完整回归测试、浏览器兼容性验证、失败恢复说明和可观测性指标'
  const draft = deriveTaskDraft(prompt)
  assert.equal(draft.description, prompt)
  assert.equal(draft.title.length, 72)
  assert.ok(draft.title.endsWith('…'))
})

test('agent-mode task draft rejects whitespace through an empty derived title', () => {
  assert.deepEqual(deriveTaskDraft(' \n\t '), { title: '', description: '' })
})
