// tests/integration/host-entry.test.js
//
// V1 host integration - the Cordis entry (`src/index.js`) must:
//   * be a plugin whose apply() returns void (Cordis 4.0.5 constraint, CONTRACTS §6.5);
//   * register both routes inside ctx.effect so disposal removes them;
//   * fail soft (no throw) when webServer is unavailable.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LOAD_PATH, COMMIT_PATH, REPO_ROOT, skipReason } from './helpers.js';

const entryPath = join(REPO_ROOT, 'src', 'index.js');
const skip = existsSync(entryPath) ? false : skipReason('src/index.js');

/**
 * Isolate the Cordis entry from the real Harness home.
 *
 * `apply()` writes the control token (and later profile data) under the
 * resolved storage directory. This suite must never touch the user's
 * `~/.dsh`; a per-test temporary `storageDir` is the narrowest seam that keeps
 * the production resolution path exercised while pinning every artifact to a
 * scratch directory.
 */
function makeIsolatedHome(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsg-host-entry-it-'));
  t.after(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort scratch cleanup */
    }
  });
  return { dir, storageDir: join(dir, 'storages') };
}

async function importEntry() {
  return await import(new URL('../../src/index.js', import.meta.url).href);
}

function fakeCtx({ withWebServer = true } = {}) {
  const routes = new Map();
  const effects = [];
  const ctx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    connection: { requestRejection: () => undefined },
    effect(factory) {
      const disposer = typeof factory === 'function' ? factory() : factory;
      effects.push(disposer);
      return () => { if (typeof disposer === 'function') disposer(); };
    },
  };
  if (withWebServer) {
    ctx.webServer = {
      register({ kind, path, handler }) {
        if (kind !== 'exact') throw new Error(`unexpected kind ${kind}`);
        routes.set(path, handler);
        return () => routes.delete(path);
      },
    };
  }
  return { ctx, routes, effects };
}

function pickApply(module) {
  if (typeof module.default === 'function') return module.default;
  if (typeof module.apply === 'function') return module.apply;
  if (typeof module.default?.apply === 'function') return module.default.apply.bind(module.default);
  return null;
}

test('entry: apply() registers load+commit inside ctx.effect and returns void', { skip }, async (t) => {
  const module = await importEntry();
  const apply = pickApply(module);
  assert.equal(typeof apply, 'function', 'src/index.js must export an apply function (default or named)');

  const { ctx, routes, effects } = fakeCtx();
  const home = makeIsolatedHome(t);
  const result = apply(ctx, { storageDir: home.storageDir });
  assert.equal(result, undefined, 'apply() must return void (CONTRACTS §6.5: non-void breaks Cordis effects)');
  // apply may be async; wait a microtask for any awaited registration to flush.
  await Promise.resolve();
  assert.equal(routes.has(LOAD_PATH), true, `GET ${LOAD_PATH} not registered`);
  assert.equal(routes.has(COMMIT_PATH), true, `POST ${COMMIT_PATH} not registered`);
  assert.ok(effects.length >= 1, 'route registrations must be owned by ctx.effect');
  t.diagnostic(`registered routes: ${[...routes.keys()].join(', ')}`);
});

test('entry: disposal removes both routes', { skip }, async (t) => {
  const module = await importEntry();
  const apply = pickApply(module);
  const { ctx, routes, effects } = fakeCtx();
  const home = makeIsolatedHome(t);
  await apply(ctx, { storageDir: home.storageDir });
  for (const disposer of effects) {
    if (typeof disposer === 'function') disposer();
  }
  assert.equal(routes.size, 0, 'after effect disposal no group route may remain mounted');
});

test('entry: missing webServer fails soft (no throw)', { skip }, async (t) => {
  const module = await importEntry();
  const apply = pickApply(module);
  const { ctx } = fakeCtx({ withWebServer: false });
  const home = makeIsolatedHome(t);
  await assert.doesNotReject(
    async () => { await apply(ctx, { storageDir: home.storageDir }); },
    'plugin must not throw when webServer is unavailable',
  );
});
