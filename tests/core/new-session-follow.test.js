import test from 'node:test'
import assert from 'node:assert/strict'
import { newSessionFollow, pendingFollowStillValid } from '../../src/core/new-session-follow.js'

const pending = { groupId: 'g1', trackedSessionId: 's1', workspaceId: 'w1' }
const rows = {
  s1: { id: 's1', blank: true },
  s2: { id: 's2', blank: true },
  s3: { id: 's3', blank: true },
  used: { id: 'used', blank: false },
  agent: { id: 'agent', blank: true, origin: 'subagent' },
}

test('newSessionFollow moves the active blank from another workspace', () => {
  assert.deepEqual(newSessionFollow(pending, 's2', rows, true, true), {
    targetGroupId: 'g1',
    previousSessionId: 's1',
    removePrevious: true,
  })
})

test('newSessionFollow follows a second workspace switch after the first move', () => {
  const afterFirst = { ...pending, trackedSessionId: 's2', workspaceId: 'w2' }
  assert.deepEqual(newSessionFollow(afterFirst, 's3', rows, true, true), {
    targetGroupId: 'g1',
    previousSessionId: 's2',
    removePrevious: true,
  })
})

test('newSessionFollow ignores same-workspace navigation, tracked id, nonblank and subagents', () => {
  assert.equal(newSessionFollow(pending, 's2', rows, true, false), null)
  assert.equal(newSessionFollow(pending, 's1', rows, true, true), null)
  assert.equal(newSessionFollow(pending, 'used', rows, true, true), null)
  assert.equal(newSessionFollow(pending, 'agent', rows, true, true), null)
})

test('newSessionFollow requires a live target group', () => {
  assert.equal(newSessionFollow(pending, 's2', rows, false, true), null)
})

test('newSessionFollow keeps an unconfirmed previous session', () => {
  assert.equal(
    newSessionFollow(pending, 's2', { s2: { id: 's2', blank: true } }, true, true).removePrevious,
    false,
  )
  assert.equal(
    newSessionFollow(pending, 's2', { ...rows, s1: { id: 's1', blank: false } }, true, true).removePrevious,
    false,
  )
})

test('pendingFollowStillValid closes the intent after a manual move or group deletion', () => {
  const doc = { groups: [{ id: 'g1', sessionIds: ['s1'] }] }
  assert.equal(pendingFollowStillValid(doc, pending), true)
  assert.equal(
    pendingFollowStillValid({ groups: [{ id: 'g1', sessionIds: [] }] }, pending),
    false,
  )
  assert.equal(
    pendingFollowStillValid({ groups: [{ id: 'g1', sessionIds: ['s2'] }] }, pending),
    false,
  )
  assert.equal(pendingFollowStillValid({ groups: [] }, pending), false)
})
