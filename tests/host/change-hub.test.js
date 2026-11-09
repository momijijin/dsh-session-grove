import test from 'node:test'
import assert from 'node:assert/strict'
import { createChangeHub } from '../../src/host/change-hub.js'

test('change hub broadcasts revision events with profileId and cleans up clients', () => {
  const hub = createChangeHub()
  const writes = []
  const endings = []
  const client = {
    write(value) {
      writes.push(value)
    },
    end() {
      endings.push(true)
    },
  }
  const unsubscribe = hub.subscribe(client)
  assert.equal(hub.size, 1)
  hub.publish(7, 'native-tool')
  assert.equal(writes.length, 1)
  assert.match(writes[0], /event: revision/)
  assert.match(writes[0], /"revision":7/)
  assert.match(writes[0], /"source":"native-tool"/)
  assert.match(writes[0], /"profileId":"default"/, 'legacy publishers default to the default profile')

  unsubscribe()
  assert.equal(hub.size, 0)
  hub.publish(8)
  assert.equal(writes.length, 1)

  hub.subscribe(client)
  hub.close()
  assert.equal(endings.length, 1)
  assert.equal(hub.size, 0)
})

test('change hub scopes revision events by profileId', () => {
  const hub = createChangeHub()
  const writes = []
  const client = { write: (value) => writes.push(value), end() {} }
  hub.subscribe(client)
  hub.publish(3, 'http-commit', 'p-1a2b3c-9f0e')
  assert.equal(writes.length, 1)
  assert.match(writes[0], /"profileId":"p-1a2b3c-9f0e"/)
  assert.match(writes[0], /"source":"http-commit"/)
})

test('change hub announces active switches', () => {
  const hub = createChangeHub()
  const writes = []
  const client = { write: (value) => writes.push(value), end() {} }
  hub.subscribe(client)
  hub.publishActive('p-1a2b3c-9f0e', 4)
  assert.equal(writes.length, 1)
  assert.match(writes[0], /event: active/)
  assert.match(writes[0], /"activeId":"p-1a2b3c-9f0e"/)
  assert.match(writes[0], /"registryRevision":4/)

  hub.publishActive('', 4)
  hub.publishActive('default', -1)
  hub.publishActive(null, 1)
  assert.equal(writes.length, 1, 'malformed active announcements are ignored')
})

test('change hub ignores invalid revisions and post-close publishers', () => {
  const hub = createChangeHub()
  const writes = []
  const client = { write: (value) => writes.push(value), end() {} }
  hub.subscribe(client)
  hub.publish('7')
  hub.publish(-1)
  hub.publish(1)
  assert.equal(writes.length, 1)
  hub.close()
  hub.publish(2)
  hub.publishActive('default', 2)
  assert.equal(writes.length, 1)
})
