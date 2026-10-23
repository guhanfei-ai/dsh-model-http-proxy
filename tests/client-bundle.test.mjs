/**
 * The built browser bundle, exercised headlessly: it must register the settings
 * section and answer `read()` from the settings document alone, even when the
 * chat model catalog never answers. That hang used to leave the page on
 * "正在读取设置…" forever.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, it } from 'node:test'
import vm from 'node:vm'

const require = createRequire(import.meta.url)

/** Load the CJS bundle the way the DSH web shell's module loader does. */
function loadClientBundle() {
  let entry
  const sandbox = {
    window: { __ModuleLoader__: { load: value => { entry = value } } },
    // The stylesheet import is resolved by the host bundler; the bundle only
    // needs a truthy object for its class map.
    document: { querySelector: () => ({}) },
    URL,
    console,
    setTimeout,
    clearTimeout,
  }
  vm.runInNewContext(readFileSync('lib/client.js', 'utf8'), sandbox)
  assert.ok(entry, 'the bundle registers itself with the module loader')
  return entry.factory(require)
}

describe('client bundle', () => {
  it('registers the M-H-Proxy settings section', () => {
    const client = loadClientBundle()
    const registrations = []
    const slots = {
      inject: (name, callback) => callback(),
      register: (options, component) => { registrations.push({ options, component }) },
    }
    client.apply({ slots, get: () => undefined })
    assert.equal(registrations.length, 1)
    assert.equal(registrations[0].options.name, 'settings.section')
    assert.equal(registrations[0].options.label, 'M-H-Proxy')
  })

  it('reads settings without waiting for a hung model catalog', async () => {
    const client = loadClientBundle()
    let injected
    const settings = {
      describe: async () => ({
        ok: true,
        value: [
          { ns: 'model-proxy', revision: 7, value: { proxy: '', proxyHosts: ['api.openai.com'], excludeHosts: [] } },
          { ns: 'llm-pi-ai', value: { providers: { 'kimi-coding': {} } } },
        ],
      }),
    }
    const session = { modelCatalog: () => new Promise(() => {}) }
    const ctx = {
      slots: {
        inject: (name, callback) => callback(),
        register: (options) => { injected = options.inject() },
      },
      get: name => (name === 'remote.settings' ? settings : name === 'remote.session' ? session : undefined),
    }
    client.apply(ctx)
    const face = injected.proxyFace
    // The read must settle even though modelCatalog never resolves.
    const snapshot = await Promise.race([
      face.read(),
      new Promise((_, reject) => setTimeout(() => { reject(new Error('read() blocked on the model catalog')) }, 500)),
    ])
    assert.equal(snapshot.proxy, '')
    assert.deepEqual(snapshot.proxyHosts, ['api.openai.com'])
    // Immediately available rows are the clearly labelled fallback kind.
    assert.ok(snapshot.suggestions.length > 0)
    assert.ok(snapshot.suggestions.every(row => row.kind !== 'routable'))
    // And the enrichment itself is bounded too, instead of hanging forever.
    const enriched = await face.refreshSuggestions(snapshot)
    assert.ok(Array.isArray(enriched))
  })

  it('marks chat-selectable hosts as routable when the catalog answers', async () => {
    const client = loadClientBundle()
    let injected
    const settings = {
      describe: async () => ({
        ok: true,
        value: [
          { ns: 'model-proxy', revision: 1, value: { proxy: '', proxyHosts: [], excludeHosts: [] } },
          { ns: 'llm-pi-ai', value: { providers: {} } },
        ],
      }),
    }
    const session = {
      modelCatalog: async () => ({
        ok: true,
        value: { routableProviders: ['openai-codex'], groups: [{ id: 'openai-codex', name: 'Codex 订阅', models: [] }] },
      }),
    }
    const ctx = {
      slots: { inject: (name, callback) => callback(), register: () => { /* captured below */ } },
      get: name => (name === 'remote.settings' ? settings : name === 'remote.session' ? session : undefined),
    }
    // Capture the face through the registration, as the host does.
    ctx.slots.register = (options) => { injected = options.inject() }
    client.apply(ctx)
    const snapshot = await injected.proxyFace.read()
    const enriched = await injected.proxyFace.refreshSuggestions(snapshot)
    const codex = enriched.find(row => row.host === 'chatgpt.com')
    assert.ok(codex, 'the Codex host is suggested')
    assert.equal(codex.kind, 'routable')
    // The bundle runs in its own realm, so spread before a strict compare.
    assert.deepEqual([...codex.providers], ['Codex 订阅'])
    // A configured-but-not-selectable provider must not masquerade as routable.
    assert.ok(enriched.every(row => row.kind !== 'configured'))
  })
  it('seeds missing lists once; deleting all rules persists and does not revive builtin hosts', async () => {
    const client = loadClientBundle()
    let face
    let value = { proxy: 'http://127.0.0.1:7890', excludeHosts: [] }
    let revision = 1
    const settings = {
      describe: async () => ({ ok: true, value: [{ ns: 'model-proxy', revision, value }] }),
      mutate: async (_ns, ops, expected) => {
        assert.equal(expected, revision)
        for (const op of ops) value[op.path[0]] = op.value
        return { ok: true, value: { revision: ++revision } }
      },
    }
    client.apply({
      slots: { inject: (_name, fn) => fn(), register: opts => { face = opts.inject().proxyFace } },
      get: name => name === 'remote.settings' ? settings : undefined,
    })
    const initial = await face.read()
    assert.deepEqual([...initial.proxyHosts], ['auth.openai.com'])
    const builtin = initial.suggestions.find(row => row.host === 'auth.openai.com')
    assert.equal(builtin.kind, 'builtin')
    await face.save({ proxy: value.proxy, proxyHosts: [], excludeHosts: [] })
    const reloaded = await face.read()
    assert.deepEqual([...reloaded.proxyHosts], [])
    // Still available in the picker, but not inserted back into active rules.
    assert.ok(reloaded.suggestions.some(row => row.host === 'auth.openai.com'))
    assert.deepEqual(value.proxyHosts, [])
    await face.save({ proxy: value.proxy, proxyHosts: ['*.openai.com'], excludeHosts: ['api.openai.com'] })
    const overlap = await face.read()
    assert.deepEqual([...overlap.proxyHosts], ['*.openai.com'])
    assert.deepEqual([...overlap.excludeHosts], ['api.openai.com'])
  })

})
