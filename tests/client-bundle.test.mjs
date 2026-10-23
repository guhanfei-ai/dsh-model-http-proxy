/**
 * Exercise the actual browser bundle through the DSH module/slot boundary.
 * Settings and the model catalog are entirely local doubles: no real RPC,
 * settings document, model call, transport, or browser service is touched.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, it } from 'node:test'
import vm from 'node:vm'
import { BUILTIN_DIRECT_HOSTS, BUILTIN_PROXY_GROUPS, BUILTIN_PROXY_HOSTS } from '../lib/index.js'

const require = createRequire(import.meta.url)
// Values created by the VM belong to another realm; compare their data only.
const plain = value => JSON.parse(JSON.stringify(value))
const proxy = (id, patch = {}) => ({
  id, name: `Proxy ${id}`, enabled: true, proxy: 'http://127.0.0.1:7890', proxyHosts: [], ...patch,
})
const fields = (proxies = [], excludeHosts = []) => ({ proxies, excludeHosts })
const backendReloadCode = 'MODEL_PROXY_BACKEND_RELOAD_REQUIRED'
const backendSchemaError = 'Config field "proxies" is not volatile'
const isBackendReloadError = error => {
  assert.equal(error.code, backendReloadCode)
  assert.match(error.message, /后端/u)
  assert.match(error.message, /重载/u)
  assert.match(error.message, /仅刷新网页无效/u)
  return true
}
const builtinSuggestions = [
  ...BUILTIN_DIRECT_HOSTS.map(host => ({ host, kind: 'builtin', providers: ['DeepSeek'] })),
  ...BUILTIN_PROXY_GROUPS.flatMap(group => group.hosts.map(host => ({ host, kind: 'builtin', providers: [group.name] }))),
].sort((left, right) => left.host.localeCompare(right.host))
function assertBuiltinSuggestions(suggestions) {
  assert.deepEqual(plain(suggestions.filter(row => row.kind === 'builtin')), builtinSuggestions,
    'all and only the ten declared author rules are builtin candidates with company labels')
}
async function withinDeadline(promise, message) {
  let timeout
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timeout = setTimeout(() => { reject(new Error(message)) }, 500)
    })])
  } finally { clearTimeout(timeout) }
}

/** Load the CJS bundle the way the DSH web shell's module loader does. */
function loadClientBundle(overrides = {}) {
  let entry
  vm.runInNewContext(readFileSync('lib/client.js', 'utf8'), {
    window: { __ModuleLoader__: { load: value => { entry = value } } },
    // The host resolves styles; only a truthy stylesheet element is needed.
    document: { querySelector: () => ({}) },
    URL, console, setTimeout, clearTimeout,
    ...overrides,
  })
  assert.ok(entry, 'the bundle registers itself with the module loader')
  return entry.factory(require)
}

function createFace({ settings, session, connection, bundle = loadClientBundle() } = {}) {
  let face
  bundle.apply({
    slots: {
      inject: (_name, callback) => callback(),
      register: options => { face = options.inject().proxyFace },
    },
    get: name => name === 'remote.settings' ? settings : name === 'remote.session' ? session : name === 'connection' ? connection : undefined,
  })
  assert.ok(face, 'the settings section injects its IO face')
  return face
}

function rowsOf(value, revision = 7, providers = {}) {
  return [
    { ns: 'model-proxy', revision, value },
    { ns: 'llm-pi-ai', value: { providers } },
  ]
}

function settingsOf(value, revision = 7, providers = {}) {
  return { describe: async () => ({ ok: true, value: rowsOf(value, revision, providers) }) }
}

function rowsWithSchema(value, revision, schema) {
  const rows = rowsOf(value, revision)
  rows[0].schema = schema
  return rows
}

describe('client bundle', () => {
  it('registers the M-H-Proxy settings section', () => {
    const registrations = []
    loadClientBundle().apply({
      slots: {
        inject: (_name, callback) => callback(),
        register: (options, component) => { registrations.push({ options, component }) },
      },
      get: () => undefined,
    })
    assert.equal(registrations.length, 1)
    assert.equal(registrations[0].options.name, 'settings.section')
    assert.equal(registrations[0].options.label, 'M-H-Proxy')
    assert.equal(typeof registrations[0].component, 'function')
  })

  it('reads settings immediately and bounds enrichment when the catalog never answers', async () => {
    const timers = [], cleared = []
    const bundle = loadClientBundle({
      setTimeout: (callback, delay) => { const timer = { callback, delay }; timers.push(timer); return timer },
      clearTimeout: timer => { cleared.push(timer) },
    })
    let catalogCalls = 0
    const face = createFace({
      bundle,
      settings: settingsOf({ proxy: '', proxyHosts: ['api.openai.com'], excludeHosts: [] }, 7, { 'kimi-coding': {} }),
      session: { modelCatalog: () => { catalogCalls++; return new Promise(() => {}) } },
    })
    // No timeout needs to fire, and no catalog call is made, to read settings.
    const snapshot = await withinDeadline(face.read(), 'read() blocked on the model catalog')
    assert.deepEqual(plain(snapshot.proxies), [proxy('legacy', { name: '代理1', enabled: false, proxy: '', proxyHosts: ['api.openai.com'] })])
    assert.equal(catalogCalls, 0)
    assert.ok(snapshot.suggestions.length > 0)
    assert.ok(snapshot.suggestions.every(row => row.kind !== 'routable'))
    const enrichment = face.refreshSuggestions(snapshot)
    assert.equal(catalogCalls, 1)
    assert.equal(timers.length, 1)
    assert.ok(timers[0].delay > 0 && timers[0].delay <= 1500, 'catalog fallback has a finite, short deadline')
    timers[0].callback()
    const enriched = await withinDeadline(enrichment, 'catalog timeout did not settle enrichment')
    assert.ok(Array.isArray(enriched))
    assert.ok(enriched.some(row => row.host === 'api.deepseek.com' && row.kind === 'fallback'))
    assert.deepEqual(cleared, timers, 'the deadline is cleared after the race settles')
  })

  it('marks only chat-selectable hosts as routable and uses actual configured endpoints', async () => {
    const face = createFace({
      settings: settingsOf(fields(), 1, {
        'openai-codex': { displayName: 'Codex 订阅' },
        openai: { baseURL: 'https://gateway.example.com/v1', displayName: 'Gateway A' },
        anthropic: { baseURL: 'https://gateway.example.com/anthropic' },
        unused: { baseURL: 'https://not-selectable.example.com/v1' },
      }),
      session: { modelCatalog: async () => ({ ok: true, value: {
        routableProviders: ['openai-codex', 'openai', 'anthropic'],
        groups: [{ id: 'anthropic', name: 'Gateway B', models: [] }],
      } }) },
    })
    const snapshot = await face.read()
    const enriched = await face.refreshSuggestions(snapshot)
    const codex = enriched.find(row => row.host === 'chatgpt.com')
    assert.equal(codex?.kind, 'routable')
    assert.deepEqual(plain(codex.providers), ['Codex 订阅'])
    const gateway = enriched.find(row => row.host === 'gateway.example.com')
    assert.equal(gateway?.kind, 'routable')
    assert.deepEqual(plain(gateway.providers), ['Gateway A', 'Gateway B'])
    assert.ok(enriched.every(row => row.kind !== 'configured'))
    assert.ok(!enriched.some(row => row.host === 'not-selectable.example.com'))
    assertBuiltinSuggestions(enriched)
    assert.ok(!enriched.some(row => row.host === 'auth.openai.com'), 'auth is covered at runtime, not separately seeded as a candidate')
  })

  it('treats an empty successful catalog as authoritative, not as a failure', async () => {
    const face = createFace({
      settings: settingsOf(fields(), 1, { openai: { baseURL: 'https://configured.example.com' } }),
      session: { modelCatalog: async () => ({ ok: true, value: { routableProviders: [], groups: [] } }) },
    })
    const enriched = await face.refreshSuggestions(await face.read())
    assert.deepEqual(plain(enriched), builtinSuggestions)
  })

  it('labels configured and builtin fallback sources when the catalog is unavailable or malformed', async () => {
    const sessions = [
      undefined,
      { modelCatalog: async () => { throw new Error('local catalog double failed') } },
      { modelCatalog: async () => ({ ok: false }) },
      { modelCatalog: async () => ({ ok: true, value: { groups: [] } }) },
    ]
    for (const session of sessions) {
      const face = createFace({ settings: settingsOf(fields(), 1, { openai: { baseURL: 'https://configured.example.com/v1', displayName: 'Local Gateway' } }), session })
      const enriched = await face.refreshSuggestions(await face.read())
      assert.deepEqual(plain(enriched.find(row => row.host === 'configured.example.com')), { host: 'configured.example.com', kind: 'configured', providers: ['Local Gateway'] })
      assert.equal(enriched.find(row => row.host === 'api.deepseek.com')?.kind, 'fallback')
      assertBuiltinSuggestions(enriched)
      assert.ok(!enriched.some(row => row.host === 'auth.openai.com'))
    }
  })

  it('aggregates saved suggestions from all cards, including disabled cards, and global exclusions', async () => {
    const saved = fields([
      proxy('a', { proxyHosts: ['https://Active.Example.com.:443/v1'] }),
      proxy('b', { enabled: false, proxy: '', proxyHosts: ['disabled.example.com', 'active.example.com'] }),
    ], ['*.direct.example.com'])
    const face = createFace({
      settings: settingsOf(saved),
      session: { modelCatalog: async () => ({ ok: true, value: { routableProviders: [] } }) },
    })
    const snapshot = await face.read()
    for (const suggestions of [snapshot.suggestions, await face.refreshSuggestions(snapshot)]) {
      for (const host of ['active.example.com', 'disabled.example.com', '*.direct.example.com']) {
        const matches = suggestions.filter(row => row.host === host)
        assert.equal(matches.length, 1, `${host} is normalized and deduplicated`)
        assert.equal(matches[0].kind, 'saved')
      }
    }
    assert.deepEqual(plain(snapshot.proxies), saved.proxies, 'suggestions never rewrite or append active rules')
  })

  it('retains live catalog endpoints as candidates without appending them to fresh author defaults or autosaving', async () => {
    const value = {}, calls = []
    const face = createFace({
      settings: {
        ...settingsOf(value, 1, { openai: { baseURL: 'https://custom.gateway.test/v1', displayName: 'Custom Gateway' } }),
        mutate: (...args) => { calls.push(['mutate', args]) },
        update: (...args) => { calls.push(['update', args]) },
      },
      session: { modelCatalog: async () => ({ ok: true, value: {
        routableProviders: ['openai', 'anthropic', 'google', 'xai', 'deepseek', 'openai-codex'],
        groups: [
          { id: 'anthropic', name: 'Claude models' }, { id: 'google', name: 'Gemini models' },
          { id: 'xai', name: 'Grok models' }, { id: 'deepseek', name: 'DeepSeek models' },
          { id: 'openai-codex', name: 'Codex subscription' },
        ],
      } }) },
    })
    const snapshot = await face.read()
    const before = plain(snapshot)
    assertBuiltinSuggestions(snapshot.suggestions)
    const enriched = await face.refreshSuggestions(snapshot)
    assertBuiltinSuggestions(enriched)
    for (const [host, label] of [
      ['custom.gateway.test', 'Custom Gateway'], ['api.anthropic.com', 'Claude models'],
      ['generativelanguage.googleapis.com', 'Gemini models'], ['api.x.ai', 'Grok models'],
      ['api.deepseek.com', 'DeepSeek models'], ['chatgpt.com', 'Codex subscription'],
    ]) {
      assert.deepEqual(plain(enriched.find(row => row.host === host)), { host, kind: 'routable', providers: [label] })
    }
    assert.deepEqual(plain(snapshot), before, 'catalog enrichment must not mutate the read snapshot')
    assert.deepEqual(plain(snapshot.proxies), [proxy('legacy', {
      name: '代理1', enabled: false, proxy: '', proxyHosts: [...BUILTIN_PROXY_HOSTS],
    })])
    assert.deepEqual(plain(snapshot.excludeHosts), [...BUILTIN_DIRECT_HOSTS])
    assert.deepEqual(value, {}, 'merely reading does not persist schema/default migration')
    assert.deepEqual(calls, [], 'neither reading nor catalog enrichment writes settings')
  })

  it('keeps explicitly saved auth and concrete subhosts without giving them builtin source labels', async () => {
    const value = {
      proxy: 'http://127.0.0.1:7890',
      proxyHosts: ['auth.openai.com', 'https://API.OpenAI.com.:443/v1', 'chatgpt.com'],
      excludeHosts: ['api.deepseek.com'],
    }
    const before = plain(value), writes = []
    const face = createFace({
      settings: { ...settingsOf(value), mutate: (...args) => { writes.push(args) } },
      session: { modelCatalog: async () => ({ ok: true, value: { routableProviders: [] } }) },
    })
    const snapshot = await face.read()
    for (const suggestions of [snapshot.suggestions, await face.refreshSuggestions(snapshot)]) {
      assertBuiltinSuggestions(suggestions)
      for (const host of ['auth.openai.com', 'api.openai.com', 'chatgpt.com']) {
        assert.deepEqual(plain(suggestions.find(row => row.host === host)), { host, kind: 'saved', providers: [] })
      }
      assert.notEqual(suggestions.find(row => row.host === 'api.deepseek.com')?.kind, 'builtin')
    }
    assert.deepEqual(plain(snapshot.proxies[0].proxyHosts), value.proxyHosts, 'old auth rule is preserved, not replaced by the wildcard')
    assert.deepEqual(plain(snapshot.excludeHosts), value.excludeHosts)
    assert.deepEqual(value, before)
    assert.deepEqual(writes, [])
  })

  it('migrates legacy settings in memory with stable identity and seeds only a missing rule list', async () => {
    for (const [value, hosts, enabled] of [
      [{ proxy: 'http://127.0.0.1:7890', excludeHosts: ['direct.example.com'] }, [...BUILTIN_PROXY_HOSTS], true],
      [{ proxy: 'http://127.0.0.1:7890', proxyHosts: [], excludeHosts: [] }, [], true],
      [{ proxy: '', proxyHosts: ['custom.example.com'], excludeHosts: [] }, ['custom.example.com'], false],
      [{ proxy: 'http://127.0.0.1:7890', proxyHosts: ['auth.openai.com'], excludeHosts: [] }, ['auth.openai.com'], true],
      [{ proxyHosts: ['*.OPENAI.COM.', 'https://API.OpenAI.com:443/v1'] }, ['*.OPENAI.COM.', 'https://API.OpenAI.com:443/v1'], false],
      [{}, [...BUILTIN_PROXY_HOSTS], false],
    ]) {
      const before = plain(value), writes = []
      const face = createFace({ settings: { ...settingsOf(value), mutate: (...args) => { writes.push(args) } } })
      const first = await face.read(), second = await face.read()
      assert.equal(first.proxies.length, 1)
      assert.equal(first.proxies[0].id, 'legacy')
      assert.equal(first.proxies[0].id, second.proxies[0].id)
      assert.equal(first.proxies[0].name, '代理1')
      assert.equal(first.proxies[0].enabled, enabled)
      assert.deepEqual(plain(first.proxies[0].proxyHosts), hosts)
      assert.deepEqual(plain(first.excludeHosts), value.excludeHosts ?? [...BUILTIN_DIRECT_HOSTS])
      assertBuiltinSuggestions(first.suggestions)
      assert.equal(first.proxies.some(entry => entry.name === '代理2'), false, 'migration never adds a second default card')
      assert.deepEqual(value, before, 'read never writes the migration back')
      assert.equal(writes.length, 0)
    }
  })

  it('honors authoritative empty lists and does not restore obsolete legacy rules', async () => {
    for (const proxies of [[], [proxy('a', { proxyHosts: [] })]]) {
      const value = { proxies, excludeHosts: [], proxy: 'http://obsolete.example.com:8080', proxyHosts: ['obsolete.example.com'] }
      const face = createFace({ settings: settingsOf(value) })
      const snapshot = await face.read()
      assert.deepEqual(plain(snapshot.proxies), proxies)
      assert.ok(!snapshot.suggestions.some(row => row.host === 'obsolete.example.com'))
      assertBuiltinSuggestions(snapshot.suggestions)
      assert.ok(snapshot.suggestions.some(row => row.host === '*.openai.com'), 'builtin rules remain candidates only')
    }
  })

  it('seeds missing lists once; saved empty rules and an empty card list remain empty after reload', async () => {
    let value = { proxy: 'http://127.0.0.1:7890', excludeHosts: [] }, revision = 1
    const face = createFace({ settings: {
      describe: async () => ({ ok: true, value: rowsOf(value, revision) }),
      mutate: async (_ns, ops, expected) => {
        assert.equal(expected, revision)
        for (const op of ops) value[op.path[0]] = plain(op.value)
        return { ok: true, value: { revision: ++revision } }
      },
    } })
    const initial = await face.read()
    assert.deepEqual(plain(initial.proxies[0].proxyHosts), [...BUILTIN_PROXY_HOSTS])
    await face.save(fields([{ ...plain(initial.proxies[0]), proxyHosts: [] }]))
    assert.deepEqual(plain((await face.read()).proxies[0].proxyHosts), [])
    assert.equal(value.proxy, '')
    assert.deepEqual(value.proxyHosts, [])
    await face.save(fields([proxy('legacy', { name: '代理1', proxyHosts: ['*.openai.com'] })], ['api.openai.com']))
    const overlap = await face.read()
    assert.deepEqual(plain(overlap.proxies[0].proxyHosts), ['*.openai.com'])
    assert.deepEqual(plain(overlap.excludeHosts), ['api.openai.com'])
    await face.save(fields())
    const empty = await face.read()
    assert.deepEqual(plain(empty.proxies), [])
    assertBuiltinSuggestions(empty.suggestions)
    assert.deepEqual(plain(empty.excludeHosts), [])
  })

  it('reads supported describe envelopes and clones nested arrays instead of mutating settings', async () => {
    const value = fields([proxy('a', { enabled: false, proxy: '', proxyHosts: ['saved.example.com'] })], ['direct.example.com'])
    const rows = rowsOf(value)
    for (const envelope of [{ ok: true, value: rows }, rows, { value: rows }, { result: { value: rows } }, { namespaces: rows }, { ok: true, value: { namespaces: rows } }]) {
      const face = createFace({ settings: { describe: async () => envelope } })
      const snapshot = await face.read()
      assert.deepEqual(plain(snapshot.proxies), value.proxies)
      snapshot.proxies[0].proxyHosts.push('local-only.example.com')
      snapshot.excludeHosts.push('local-only.example.com')
      assert.deepEqual(value.proxies[0].proxyHosts, ['saved.example.com'])
      assert.deepEqual(value.excludeHosts, ['direct.example.com'])
    }
  })

  it('does not confuse a missing settings namespace with an authoritative empty document', async () => {
    assert.equal(await createFace().read(), null)
    for (const envelope of [{ ok: true, value: [] }, { ok: false }, { unknown: [] }]) {
      assert.equal(await createFace({ settings: { describe: async () => envelope } }).read(), null)
    }
    for (const proxies of [null, {}, [{ id: 'a' }]]) {
      const face = createFace({ settings: settingsOf({ proxies, proxy: 'http://obsolete.example.com', proxyHosts: ['obsolete.example.com'] }) })
      await assert.rejects(face.read(), /proxies|代理/u, 'malformed new configuration cannot fall back to legacy fields')
    }
  })

  it('writes exactly four atomic set operations and adopts each successful next revision', async () => {
    const calls = []
    const face = createFace({ settings: {
      ...settingsOf(fields(), 7),
      mutate: async (...args) => { calls.push(plain(args)); return { ok: true, value: { revision: 7 + calls.length } } },
      update: () => { throw new Error('remote update must not replace mutate') },
    } })
    await face.read()
    const first = fields([proxy('a', { proxyHosts: ['api.example.com'] }), proxy('b', { enabled: false, proxy: '', proxyHosts: ['saved.example.com'] })], ['direct.example.com'])
    await face.save(first)
    assert.deepEqual(calls[0], ['model-proxy', [
      { op: 'set', path: ['proxies'], value: first.proxies },
      { op: 'set', path: ['excludeHosts'], value: first.excludeHosts },
      { op: 'set', path: ['proxy'], value: '' },
      { op: 'set', path: ['proxyHosts'], value: [] },
    ], 7])
    await face.save(fields())
    assert.equal(calls[1][2], 8)
    await face.save(first)
    assert.equal(calls[2][2], 9)
  })

  it('refuses a known old backend schema without writing or clearing legacy fields, then recovers on a current-schema reread', async () => {
    let value = { proxy: 'http://127.0.0.1:7890', proxyHosts: ['auth.openai.com'], excludeHosts: ['old.direct.example.com'] }
    let revision = 17, reads = 0
    let schema = { type: 'object', dict: { proxy: { type: 'string' }, proxyHosts: { type: 'array' }, excludeHosts: { type: 'array' } } }
    const before = plain(value), calls = [], updates = []
    const face = createFace({ settings: {
      describe: async () => {
        reads++
        const rows = rowsWithSchema(value, revision, schema)
        rows[1].schema = { type: 'object', dict: { proxies: { type: 'array' } } }
        return { ok: true, value: rows }
      },
      mutate: async (...args) => {
        calls.push(plain(args))
        for (const op of args[1]) value[op.path[0]] = plain(op.value)
        return { ok: true, value: { revision: ++revision } }
      },
      update: async (...args) => { updates.push(args) },
    } })
    const snapshot = await face.read()
    assert.deepEqual(Object.keys(snapshot).sort(), ['excludeHosts', 'proxies', 'suggestions'], 'schema support remains private IO state, not new snapshot/UI fields')
    assert.deepEqual(plain(snapshot.proxies[0].proxyHosts), ['auth.openai.com'])
    const next = fields([proxy('a', { proxyHosts: ['*.openai.com'] }), proxy('b', { enabled: false, proxy: '' })], ['*.deepseek.com'])
    await assert.rejects(face.save(next), isBackendReloadError)
    await assert.rejects(face.save(next), isBackendReloadError)
    assert.deepEqual(calls, [], 'authoritative schema without proxies prevents even a mutate request')
    assert.deepEqual(updates, [], 'the guard never downgrades to legacy update')
    assert.deepEqual(value, before, 'blocked saves cannot clear the working legacy proxy or rules')
    assert.equal(reads, 1, 'save does not reread or adopt an unobserved revision automatically')

    schema = { type: 'object', dict: { proxies: { type: 'array' }, excludeHosts: { type: 'array' } } }
    revision = 23
    await face.read()
    assert.deepEqual(calls, [], 'rereading after backend reload still never saves automatically')
    await face.save(next)
    assert.deepEqual(calls[0], ['model-proxy', [
      { op: 'set', path: ['proxies'], value: next.proxies },
      { op: 'set', path: ['excludeHosts'], value: next.excludeHosts },
      { op: 'set', path: ['proxy'], value: '' },
      { op: 'set', path: ['proxyHosts'], value: [] },
    ], 23], 'a projected proxies schema needs no volatile meta flag and uses the latest described revision')
    assert.equal(value.proxy, '')
    assert.deepEqual(value.proxyHosts, [])
    await face.save(fields())
    assert.equal(calls[1][2], 24, 'only a successful write adopts its returned next revision')
    assert.deepEqual(updates, [])
  })

  it('keeps missing and malformed schema metadata compatible, including after an older unsupported schema was cached', async () => {
    const calls = []
    let schema = { type: 'object', dict: {} }, revision = 7
    const face = createFace({ settings: {
      describe: async () => {
        const rows = rowsWithSchema(fields(), revision, schema)
        rows[1].schema = { type: 'object', dict: {} }
        return { ok: true, value: rows }
      },
      mutate: async (...args) => { calls.push(plain(args)); return { ok: true, value: { revision: revision + 1 } } },
    } })
    await face.read()
    await assert.rejects(face.save(fields()), isBackendReloadError)
    const compatible = [
      undefined, null, {}, [], 'unknown',
      { dict: {} }, { type: 'array', dict: {} }, { type: 'object' },
      { type: 'object', dict: null }, { type: 'object', dict: [] }, { type: 'object', dict: 'unknown' },
      { type: 'object', dict: { proxies: { type: 'array' } } },
    ]
    for (schema of compatible) {
      revision++
      await face.read()
      await face.save(fields())
      assert.equal(calls.at(-1)[2], revision)
      assert.equal(calls.at(-1)[1].length, 4, 'unknown metadata still attempts the normal atomic save rather than silently dropping proxies')
    }
    assert.equal(calls.length, compatible.length, 'no false backend-reload blocks for unknown metadata or another namespace schema')
  })

  it('maps only the exact nonvolatile proxies write failure to a reload error and never adopts failed-write revisions', async () => {
    let value = { proxy: 'http://127.0.0.1:7890', proxyHosts: ['auth.openai.com'], excludeHosts: [] }
    const before = plain(value), calls = [], updates = []
    const outcomes = [
      new Error(backendSchemaError),
      { ok: false, error: { code: 'settings/invalid-field', message: backendSchemaError }, value: { revision: 999 } },
      { ok: true, value: { revision: 8 } },
      { ok: true, value: { revision: 9 } },
    ]
    const face = createFace({ settings: {
      describe: async () => ({ ok: true, value: rowsOf(value, 7) }),
      mutate: async (...args) => {
        calls.push(plain(args))
        const outcome = outcomes.shift()
        if (outcome instanceof Error) throw outcome
        if (outcome.ok) for (const op of args[1]) value[op.path[0]] = plain(op.value)
        return outcome
      },
      update: async (...args) => { updates.push(args) },
    } })
    await face.read()
    const next = fields([proxy('a', { proxyHosts: ['api.openai.com'] })], ['*.deepseek.com'])
    await assert.rejects(face.save(next), isBackendReloadError)
    await assert.rejects(face.save(next), isBackendReloadError)
    assert.deepEqual(value, before, 'failed atomic writes leave legacy routing intact')
    assert.deepEqual(updates, [], 'failed mutate never retries as an old single-proxy update')
    assert.deepEqual(calls.map(args => args[2]), [7, 7])
    await face.save(next)
    await face.save(next)
    assert.deepEqual(calls.map(args => args[2]), [7, 7, 7, 8], 'error envelopes cannot advance the revision, even when they carry a revision value')
    assert.ok(calls.every(args => args[1].length === 4), 'every attempted write retains the complete new-format transaction')
  })

  it('does not reinterpret other config fields, validation failures or revision conflicts as backend reload requirements', async () => {
    const errors = [
      new Error('Config field "excludeHosts" is not volatile'),
      new Error('Config field "proxies" is not found'),
      new Error(`validation failed: ${backendSchemaError}`),
      Object.assign(new Error('revision changed'), { code: 'settings/conflict' }),
    ]
    for (const kind of ['remote', 'connection']) {
      let current, writes = 0
      const settings = {
        ...settingsOf(fields()),
        mutate: async () => { writes++; throw current },
        update: async () => { writes++; throw current },
      }
      const face = createFace(kind === 'remote' ? { settings } : { connection: { api: { settings } } })
      await face.read()
      for (current of errors) {
        await assert.rejects(face.save(fields()), error => error === current && error.code !== backendReloadCode)
      }
      const before = writes
      await assert.rejects(face.save(fields([proxy('a', { proxy: 'socks4://127.0.0.1:1080' })])), error => error.code !== backendReloadCode && /socks4|scheme|协议/iu.test(error.message))
      assert.equal(writes, before, 'ordinary validation still runs before any RPC')
    }
  })

  it('applies the same schema guard and exact-error recovery to connection-era update without legacy-data loss', async () => {
    const value = { proxy: 'http://127.0.0.1:7890', proxyHosts: ['auth.openai.com'], excludeHosts: [] }
    const before = plain(value), calls = []
    let schema = { type: 'object', dict: { proxy: { type: 'string' } } }, failUpdate = true
    const face = createFace({ connection: { api: { settings: {
      describe: async () => ({ result: { value: rowsWithSchema(value, 3, schema) } }),
      update: async payload => {
        calls.push(plain(payload))
        if (failUpdate) throw new Error(backendSchemaError)
      },
    } } } })
    await face.read()
    const next = fields([proxy('a'), proxy('b', { enabled: false, proxy: '' })], ['direct.example.com'])
    await assert.rejects(face.save(next), isBackendReloadError)
    assert.deepEqual(calls, [], 'authoritative old connection schema blocks update before sending anything')
    schema = undefined
    await face.read()
    await assert.rejects(face.save(next), isBackendReloadError)
    assert.equal(calls.length, 1, 'without schema metadata the old connection is still attempted')
    assert.deepEqual(value, before, 'neither guarded nor rejected saves mutate the read legacy document')
    schema = { type: 'object', dict: { proxies: { type: 'array' } } }
    failUpdate = false
    await face.read()
    assert.equal(calls.length, 1, 'successful reread never retries the failed update automatically')
    await face.save(next)
    assert.deepEqual(calls[1], { ns: 'model-proxy', patch: { ...next, proxy: '', proxyHosts: [] } })
  })

  it('keeps the expected-revision argument present when the host supplied no revision', async () => {
    const calls = []
    const face = createFace({ settings: {
      describe: async () => ({ ok: true, value: [{ ns: 'model-proxy', value: fields() }] }),
      mutate: async (...args) => { calls.push(args); return { ok: true } },
    } })
    await face.read()
    await face.save(fields())
    await face.save(fields())
    assert.ok(calls.every(args => args.length === 3 && args[2] === undefined))
  })

  it('rejects failed write envelopes and preserves the last read revision until a write succeeds', async () => {
    const calls = []
    const failures = [
      { ok: false, error: { code: 'settings/conflict', message: 'revision changed' } },
      undefined,
      new Error('local mutate double failed'),
    ]
    const face = createFace({ settings: {
      ...settingsOf(fields(), 4),
      mutate: async (...args) => {
        calls.push(args)
        const result = failures.shift()
        if (result instanceof Error) throw result
        return calls.length <= 3 ? result : { ok: true, value: { revision: 5 } }
      },
    } })
    await face.read()
    await assert.rejects(face.save(fields()), error => error.code === 'settings/conflict' && /revision/u.test(error.message))
    await assert.rejects(face.save(fields()), /settings.mutate failed/u)
    await assert.rejects(face.save(fields()), /local mutate double failed/u)
    await face.save(fields())
    await face.save(fields())
    assert.deepEqual(calls.map(args => args[2]), [4, 4, 4, 4, 5])
  })

  it('rejects invalid or conflicting new fields before issuing a settings RPC', async () => {
    let writes = 0
    const face = createFace({ settings: {
      ...settingsOf(fields()),
      mutate: async () => { writes++; return { ok: true } },
    } })
    await face.read()
    const invalid = [
      fields([proxy('a'), proxy('a')]),
      fields([proxy('')]),
      fields([proxy('a', { name: '   ' })]),
      fields([proxy('a', { proxy: '' })]),
      fields([proxy('a', { proxy: 'socks4://127.0.0.1:1080' })]),
      fields([proxy('a', { proxyHosts: ['.example.com'] })]),
      fields([proxy('a', { enabled: false, proxyHosts: ['api.*.example.com'] })]),
      fields([], ['.example.com']),
      fields([proxy('a', { proxyHosts: ['https://API.Example.com.:443/v1'] }), proxy('b', { proxyHosts: ['api.example.com'] })]),
      fields([proxy('a', { proxyHosts: ['*.EXAMPLE.com.'] }), proxy('b', { proxyHosts: ['*.example.com'] })]),
      { proxies: 'invalid', excludeHosts: [] },
    ]
    for (const draft of invalid) await assert.rejects(face.save(draft))
    assert.equal(writes, 0)
    await face.save(fields([
      proxy('a', { proxyHosts: ['*.example.com'] }),
      proxy('b', { proxyHosts: ['api.example.com'] }),
      proxy('c', { enabled: false, proxy: '', proxyHosts: ['api.example.com'] }),
    ], ['*.example.com']))
    assert.equal(writes, 1, 'exact versus wildcard, a disabled duplicate, and global coverage are valid')
  })

  it('preserves the legacy connection describe/update fallback with the entire new document', async () => {
    const calls = []
    const face = createFace({ connection: { api: { settings: {
      describe: async options => { calls.push(['describe', options]); return { result: { value: rowsOf({ proxy: 'http://127.0.0.1:7890', proxyHosts: [], excludeHosts: [] }) } } },
      update: async payload => { calls.push(['update', plain(payload)]) },
    } } } })
    const snapshot = await face.read()
    const next = fields([plain(snapshot.proxies[0]), proxy('b', { enabled: false, proxy: '' })], ['direct.example.com'])
    await face.save(next)
    assert.deepEqual(plain(calls), [
      ['describe', {}],
      ['update', { ns: 'model-proxy', patch: { ...next, proxy: '', proxyHosts: [] } }],
    ])
  })
})
