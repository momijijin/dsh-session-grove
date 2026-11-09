import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const script = fileURLToPath(new URL('../../scripts/session-grove-control.mjs', import.meta.url))
const skillFile = fileURLToPath(new URL('../../skills/session-grove-control/SKILL.md', import.meta.url))

const startServer = async (reply, { authToken = null } = {}) => {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (authToken !== null && url.pathname === '/' && url.searchParams.get('token') === authToken) {
      res.writeHead(303, { location: './', 'set-cookie': 'dsh_session=ok; Path=/' })
      res.end()
      return
    }
    if (authToken !== null && req.headers.cookie !== 'dsh_session=ok') {
      res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('dsh web authentication required; reopen the URL printed by dsh web.\n')
      return
    }
    res.writeHead(reply.status ?? 200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(reply.body))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, port: server.address().port }
}

const runCli = (args, env) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: repoRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('close', (status) => resolve({ status, stdout, stderr }))
  })

/** Route-aware server that records every request the CLI sends. */
const startRoutedServer = async (handler) => {
  const requests = []
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const text = Buffer.concat(chunks).toString('utf8')
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    let body
    if (text.length > 0) {
      try {
        body = JSON.parse(text)
      } catch {
        body = text
      }
    }
    const request = { method: req.method, path: url.pathname, query: url.searchParams, body, headers: req.headers }
    requests.push(request)
    const reply = await handler(request)
    res.writeHead(reply.status ?? 200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(reply.body))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, port: server.address().port, requests }
}

const cliEnv = (home, port) => ({
  ...process.env,
  DSH_HOME: home,
  DSH_WEB_URL: `http://127.0.0.1:${port}`,
  DSH_CONTROL_TOKEN: 'test-token',
  DSH_WEB_COOKIE: 'dsh_session=ok',
})

const bodyFile = async (body) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsg-cli-body-'))
  await writeFile(join(dir, 'body.json'), JSON.stringify(body), 'utf8')
  return join(dir, 'body.json')
}

const closeServer = (server) => new Promise((resolve) => server.close(resolve))


test('control CLI doctor exchanges the web launch token and fetches the read-only report', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsg-cli-'))
  await mkdir(join(home, 'storages'), { recursive: true })
  await writeFile(join(home, 'storages', 'dsh-session-grove.control-token'), 'test-token\n', 'utf8')
  const report = { ok: true, protocol: 1, plugin: { version: 'test' }, gates: { controlApi: true } }
  const { server, port } = await startServer({ body: report }, { authToken: 'web-token' })
  try {
    const result = await runCli(['doctor'], {
      ...process.env,
      DSH_HOME: home,
      DSH_WEB_URL: `http://127.0.0.1:${port}/?token=web-token`,
      DSH_CONTROL_TOKEN: '',
      DSH_WEB_COOKIE: '',
    })
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout), report)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('control CLI doctor exits non-zero and preserves the server error payload', async () => {
  const { server, port } = await startServer({ status: 403, body: { ok: false, code: 'forbidden' } })
  try {
    const result = await runCli(['doctor'], {
      ...process.env,
      DSH_HOME: await mkdtemp(join(tmpdir(), 'dsg-cli-')),
      DSH_WEB_URL: `http://127.0.0.1:${port}`,
      DSH_CONTROL_TOKEN: 'test-token',
    })
    assert.equal(result.status, 1)
    assert.deepEqual(JSON.parse(result.stdout), { ok: false, code: 'forbidden' })
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('control CLI doctor exits non-zero when host compatibility is unsupported', async () => {
  const report = {
    ok: true,
    protocol: 1,
    host: { compatibility: { supported: false, missing: ['webServerRegister'] } },
  }
  const { server, port } = await startServer({ body: report })
  try {
    const result = await runCli(['doctor'], {
      ...process.env,
      DSH_HOME: await mkdtemp(join(tmpdir(), 'dsg-cli-')),
      DSH_WEB_URL: `http://127.0.0.1:${port}`,
      DSH_CONTROL_TOKEN: 'test-token',
    })
    assert.equal(result.status, 1)
    assert.deepEqual(JSON.parse(result.stdout), report)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('control CLI forwards --profile to state, resolve and plan', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'dsg-cli-'))
  const { server, port, requests } = await startRoutedServer(async (request) => {
    if (request.path === '/dsh-session-grove/control/state') {
      return { body: { ok: true, profileId: request.query.get('profileId') } }
    }
    return { body: { ok: true, profileId: request.body?.profileId ?? null } }
  })
  t.after(() => closeServer(server))
  const env = cliEnv(home, port)

  const state = await runCli(['state', '--profile', 'p-work'], env)
  assert.equal(state.status, 0, state.stderr)
  assert.equal(requests.at(-1).path, '/dsh-session-grove/control/state')
  assert.equal(requests.at(-1).method, 'GET')
  assert.equal(requests.at(-1).query.get('profileId'), 'p-work')

  const stateActive = await runCli(['state'], env)
  assert.equal(stateActive.status, 0, stateActive.stderr)
  assert.equal(requests.at(-1).query.has('profileId'), false)

  const resolveBody = await bodyFile({ path: ['Work'] })
  const resolved = await runCli(['resolve', '--profile=p-work', resolveBody], env)
  assert.equal(resolved.status, 0, resolved.stderr)
  assert.equal(requests.at(-1).path, '/dsh-session-grove/control/resolve')
  assert.equal(requests.at(-1).body.profileId, 'p-work')

  const resolvedActive = await runCli(['resolve', resolveBody], env)
  assert.equal(resolvedActive.status, 0, resolvedActive.stderr)
  assert.equal('profileId' in requests.at(-1).body, false)

  const planBody = await bodyFile({ baseRevision: 2, operations: [{ op: 'group.rename', groupId: 'g-1', name: 'X' }] })
  const planned = await runCli(['--profile', 'p-work', 'plan', planBody], env)
  assert.equal(planned.status, 0, planned.stderr)
  assert.equal(requests.at(-1).path, '/dsh-session-grove/control/plan')
  assert.equal(requests.at(-1).body.profileId, 'p-work')
  assert.equal(
    requests.some((request) => request.path === '/dsh-session-grove/profiles'),
    false,
    'an explicit --profile must not need the profile-list preflight',
  )
})

test('control CLI refuses plan/apply without --profile when several profiles exist', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'dsg-cli-'))
  const { server, port, requests } = await startRoutedServer(async (request) => {
    if (request.path === '/dsh-session-grove/profiles') {
      return {
        body: {
          ok: true,
          profiles: [
            { id: 'default', archived: false },
            { id: 'p-work', archived: false },
          ],
        },
      }
    }
    return { status: 500, body: { ok: false, code: 'should-not-be-called' } }
  })
  t.after(() => closeServer(server))
  const env = cliEnv(home, port)
  const file = await bodyFile({ baseRevision: 2, operations: [{ op: 'group.rename', groupId: 'g-1', name: 'X' }] })

  const plan = await runCli(['plan', file], env)
  assert.equal(plan.status, 2)
  assert.equal(JSON.parse(plan.stdout).code, 'profile-required')
  assert.equal(requests.length, 1)
  assert.equal(requests[0].path, '/dsh-session-grove/profiles')

  const apply = await runCli(['apply', file], env)
  assert.equal(apply.status, 2)
  assert.equal(JSON.parse(apply.stdout).code, 'profile-required')
  assert.equal(requests.length, 2)
})

test('control CLI keeps plan optional with a single default profile', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'dsg-cli-'))
  const { server, port, requests } = await startRoutedServer(async (request) => {
    if (request.path === '/dsh-session-grove/profiles') {
      return { body: { ok: true, profiles: [{ id: 'default', archived: false }] } }
    }
    return { body: { ok: true, revision: 3 } }
  })
  t.after(() => closeServer(server))
  const env = cliEnv(home, port)
  const file = await bodyFile({ baseRevision: 2, operations: [{ op: 'group.rename', groupId: 'g-1', name: 'X' }] })

  const plan = await runCli(['plan', file], env)
  assert.equal(plan.status, 0, plan.stderr)
  assert.equal(requests.length, 2)
  assert.equal(requests[1].path, '/dsh-session-grove/control/plan')
  assert.equal(requests[1].body.profileId, undefined)
})

test('control CLI rejects --profile for doctor and session actions', async () => {
  const env = {
    ...process.env,
    DSH_CONTROL_TOKEN: 'test-token',
    DSH_WEB_URL: 'http://127.0.0.1:1',
    DSH_HOME: await mkdtemp(join(tmpdir(), 'dsg-cli-')),
  }
  const doctor = await runCli(['doctor', '--profile', 'p-work'], env)
  assert.equal(doctor.status, 2)
  assert.equal(JSON.parse(doctor.stdout).code, 'usage')

  const session = await runCli(['session-inspect', '--profile', 'p-work', 'body.json'], env)
  assert.equal(session.status, 2)
  assert.equal(JSON.parse(session.stdout).code, 'usage')
})

test('control skill documents profile scope and exposes no switch action', async () => {
  const text = await readFile(skillFile, 'utf8')
  assert.match(text, /profileId/)
  assert.match(text, /profile-required/)
  assert.match(text, /activeProfile/)
  assert.match(text, /doctor/)
  assert.match(text, /quarantinedTo/)
  assert.match(text, /--profile/)
  assert.equal(/"action"\s*:\s*"activate"/.test(text), false)
  assert.equal(/"action"\s*:\s*"switch"/.test(text), false)
  assert.equal(/\nactivate\b/.test(text), false)
  assert.equal(/\nswitch\b/.test(text), false)
})
