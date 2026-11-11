#!/usr/bin/env node
/**
 * Local CLI for the opt-in dsh-session-grove AI control API.
 *
 * It reads the per-run bearer token written under DSH_HOME/storages and talks
 * only to the local DSH web server. It never reads or writes the group JSON
 * directly; every mutation goes through state -> plan -> apply.
 *
 * Multi-profile (SPEC 6.1): `--profile <id>` scopes state/resolve/plan/apply.
 * state/resolve may omit it (active profile). plan/apply require it when more
 * than one profile is unarchived; this CLI checks `/profiles` first so the user
 * gets the `profile-required` hint without sending a doomed plan. There is no
 * activate/switch command and doctor never takes a profile id.
 *
 * Operations (including 0.4.0-beta.62 `group.archive`) travel unchanged inside
 * the plan/apply body; the CLI is a transport and does not rewrite them.
 * Archive conflicts come back as the server's 409 body
 * (`code`, `groupId`, `field`, `operationIndex`) and are printed as-is with a
 * non-zero exit code, exactly like other control failures.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const TOKEN_FILE = 'dsh-session-grove.control-token'
const configuredUrl = new URL(process.env.DSH_WEB_URL ?? `http://127.0.0.1:${process.env.DSH_WEB_PORT ?? '43120'}`)
const webToken = configuredUrl.searchParams.get('token')
configuredUrl.searchParams.delete('token')
const BASE = configuredUrl.href.replace(/\/$/, '')
const HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const TOKEN = process.env.DSH_CONTROL_TOKEN?.trim() || readToken()

function readToken() {
  try {
    const value = readFileSync(join(HOME, 'storages', TOKEN_FILE), 'utf8').trim()
    return value.length > 0 ? value : null
  } catch {
    return null
  }
}

const print = (value, status = 0) => {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
  process.exitCode = status
}

const die = (value, status = 1) => {
  print(value, status)
  process.exit(status)
}

const commands = ['state', 'doctor', 'resolve', 'plan', 'apply', 'session-inspect', 'session-rename', 'session-archive']
const bodyCommands = new Set(['resolve', 'plan', 'apply', 'session-inspect', 'session-rename', 'session-archive'])
const profileCommands = new Set(['state', 'resolve', 'plan', 'apply'])

const usage = () => {
  die(
    {
      ok: false,
      code: 'usage',
      message:
        'usage: session-grove-control.mjs [--profile <id>] state | doctor\n' +
        '       | [--profile <id>] resolve <body.json> | plan <body.json> | apply <body.json>\n' +
        '       | session-inspect <body.json> | session-rename <body.json> | session-archive <body.json>\n' +
        'body.json: { path?, baseRevision, operations?, planHash?, idempotencyKey?, sessionId?, title?, archived? }\n' +
        'state/resolve default to the active profile; plan/apply need --profile when multiple profiles exist;\n' +
        'doctor and session actions are host-scoped and take no --profile.',
    },
    2,
  )
}

const argv = process.argv.slice(2)
const positional = []
let profile = null
for (let index = 0; index < argv.length; index += 1) {
  const argument = argv[index]
  if (argument === '--profile') {
    const value = argv[index + 1]
    if (value === undefined || value.length === 0 || value.startsWith('--')) usage()
    profile = value
    index += 1
  } else if (argument.startsWith('--profile=')) {
    profile = argument.slice('--profile='.length)
    if (profile.length === 0) usage()
  } else {
    positional.push(argument)
  }
}

const command = positional[0]
if (!commands.includes(command) || positional.length > 2) usage()
if (profile !== null && !profileCommands.has(command)) {
  die(
    {
      ok: false,
      code: 'usage',
      message: `--profile is not valid for ${command}; doctor and session actions are host-scoped`,
    },
    2,
  )
}

let body
if (bodyCommands.has(command)) {
  const file = positional[1]
  if (!file) usage()
  try {
    body = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    die({ ok: false, code: 'body-read-failed', message: error instanceof Error ? error.message : String(error) }, 2)
  }
} else if (positional.length > 1) {
  usage()
}

if (!TOKEN) {
  die(
    {
      ok: false,
      code: 'control-token-missing',
      message: 'controlApi is off or the plugin has not written its local control token',
    },
    1,
  )
}

const controlPath = command.startsWith('session-') ? command.slice(8) : command
let path = `/dsh-session-grove/control/${command.startsWith('session-') ? `session/${controlPath}` : controlPath}`

const webCookie = async () => {
  const supplied = process.env.DSH_WEB_COOKIE?.trim()
  if (supplied) return supplied
  if (!webToken) return null
  const root = new URL('/', configuredUrl)
  root.searchParams.set('token', webToken)
  const response = await fetch(root.href, { redirect: 'manual', headers: { accept: 'text/html' } }).catch((error) => {
    die({ ok: false, code: 'web-auth-failed', message: error instanceof Error ? error.message : String(error) }, 1)
  })
  const setCookies = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter(Boolean)
  const cookie = setCookies[0]?.split(';')[0]?.trim()
  if (!cookie) {
    die(
      {
        ok: false,
        code: 'web-auth-required',
        message: 'DSH web authentication rejected the launch token; reopen the URL printed by dsh web.',
      },
      1,
    )
  }
  return cookie
}

const cookie = await webCookie()
const authHeaders = () => ({
  authorization: `Bearer ${TOKEN}`,
  ...(cookie === null ? {} : { cookie }),
})

// SPEC 6.1/6.2: when several profiles are unarchived the server will reject a
// plan/apply without profileId. Ask the read-only profile list first so the
// caller gets the actionable error before any write attempt. Any failure here
// (old host, fence) falls through to the control route's own policy.
const needsExplicitProfile = async () => {
  if (command !== 'plan' && command !== 'apply') return false
  if (profile !== null) return false
  if (body !== null && typeof body === 'object' && typeof body.profileId === 'string' && body.profileId.length > 0) {
    return false
  }
  const response = await fetch(`${BASE}/dsh-session-grove/profiles`, {
    headers: authHeaders(),
  }).catch(() => null)
  if (response === null || response.ok !== true) return false
  const listing = await response.json().catch(() => null)
  const profiles = Array.isArray(listing?.profiles) ? listing.profiles : []
  return listing?.ok === true && profiles.filter((entry) => entry?.archived !== true).length > 1
}

if (await needsExplicitProfile()) {
  die(
    {
      ok: false,
      code: 'profile-required',
      message: 'multiple profiles exist; pass --profile <id>',
    },
    2,
  )
}

if (command === 'state') {
  if (profile !== null) path += `?profileId=${encodeURIComponent(profile)}`
} else if (body !== null && typeof body === 'object' && !Array.isArray(body) && profile !== null) {
  // resolve/plan/apply: the target profile travels in the JSON body exactly as
  // the HTTP control contract expects.
  body = { ...body, profileId: profile }
}

const response = await fetch(`${BASE}${path}`, {
  method: command === 'state' || command === 'doctor' ? 'GET' : 'POST',
  headers: {
    ...authHeaders(),
    ...(body === undefined ? {} : { 'content-type': 'application/json' }),
  },
  body: body === undefined ? undefined : JSON.stringify(body),
}).catch((error) => {
  die({ ok: false, code: 'request-failed', message: error instanceof Error ? error.message : String(error) }, 1)
})

const text = await response.text()
let parsed
try {
  parsed = JSON.parse(text)
} catch {
  parsed = { ok: false, code: 'invalid-response', message: text.slice(0, 500) }
}
const compatibilityFailed = command === 'doctor' && parsed?.host?.compatibility?.supported === false
print(parsed, response.ok && !compatibilityFailed ? 0 : 1)
