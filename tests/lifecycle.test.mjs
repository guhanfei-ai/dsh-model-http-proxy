/**
 * Plugin lifecycle: what happens to `globalThis.fetch` on mount, settings
 * change, invalid configuration, and teardown — and whether another plugin's
 * wrapper survives all of it.
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import { after, before, describe, it } from 'node:test'
import { apply, collectRules } from '../lib/index.js'

/** A minimal cordis-shaped context: only what `apply` actually touches. */
function makeContext(section) {
  const state = { section, warnings: [], handlers: {}, disposed: undefined }
  const ctx = {
    get: (name) => (name === 'settings'
      ? {
          describe: () => [
            { ns: 'model-proxy', value: state.section },
            { ns: 'llm-pi-ai', value: { providers: {} } },
          ],
        }
      : undefined),
    on: (event, handler) => { state.handlers[event] = handler },
    effect: (callback) => { state.disposed = callback() },
    logger: { warn: (...args) => { state.warnings.push(args) } },
  }
  return { ctx, state }
}

describe('apply lifecycle', () => {
  const platformFetch = globalThis.fetch
  const servers = []
  let proxyPort

  before(async () => {
    const proxy = http.createServer((request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('via-proxy')
    })
    await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve))
    proxyPort = proxy.address().port
    servers.push(proxy)
  })

  after(async () => {
    globalThis.fetch = platformFetch
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))))
  })

  it('installs the wrapper only while a proxy is configured', async () => {
    const { ctx, state } = makeContext({ proxy: `http://127.0.0.1:${proxyPort}`, proxyHosts: ['localhost'], excludeHosts: [] })
    const base = globalThis.fetch
    apply(ctx, state.section)
    assert.notEqual(globalThis.fetch, base, 'a configured plugin wraps fetch')
    const response = await globalThis.fetch(`http://localhost:${proxyPort}/ok`)
    assert.equal(await response.text(), 'via-proxy')
    state.disposed()
    assert.equal(globalThis.fetch, base, 'teardown restores the platform fetch')
  })

  it('follows a settings change without a restart', async () => {
    const { ctx, state } = makeContext({ proxy: `http://127.0.0.1:${proxyPort}`, proxyHosts: ['example.invalid'], excludeHosts: [] })
    const base = globalThis.fetch
    apply(ctx, state.section)
    // Not routed yet: the stand-in proxy is reached directly, and answers.
    const direct = await globalThis.fetch(`http://localhost:${proxyPort}/ok`)
    assert.equal(await direct.text(), 'via-proxy')
    // Now route it; the same wrapper must pick the change up.
    state.section = { proxy: `http://127.0.0.1:${proxyPort}`, proxyHosts: ['localhost'], excludeHosts: [] }
    state.handlers['settings/document-updated']('model-proxy')
    const routed = await globalThis.fetch(`http://localhost:${proxyPort}/ok`)
    assert.equal(await routed.text(), 'via-proxy')
    state.disposed()
    assert.equal(globalThis.fetch, base)
  })

  it('keeps the last working routing when a configuration is rejected', async () => {
    const { ctx, state } = makeContext({ proxy: `http://127.0.0.1:${proxyPort}`, proxyHosts: ['localhost'], excludeHosts: [] })
    const base = globalThis.fetch
    apply(ctx, state.section)
    const installed = globalThis.fetch
    state.section = { proxy: 'socks4://user:demo-secret@127.0.0.1:1', proxyHosts: ['localhost'], excludeHosts: [] }
    state.handlers['settings/document-updated']('model-proxy')
    // The wrapper is still installed, so a broken edit cannot silently disable
    // a proxy the user depends on.
    assert.equal(globalThis.fetch, installed)
    const warning = state.warnings.at(-1)?.join(' ') ?? ''
    assert.match(warning, /keeping the previous routing/u)
    assert.doesNotMatch(warning, /demo-secret/u, 'the log line must not carry proxy credentials')
    state.disposed()
    assert.equal(globalThis.fetch, base)
  })

  it('never clobbers a wrapper another plugin installed after it', async () => {
    const { ctx, state } = makeContext({ proxy: `http://127.0.0.1:${proxyPort}`, proxyHosts: ['localhost'], excludeHosts: [] })
    const base = globalThis.fetch
    apply(ctx, state.section)
    const ours = globalThis.fetch
    const later = (...args) => ours(...args)
    globalThis.fetch = later
    // A settings change must not replace the later wrapper with ours.
    state.handlers['settings/document-updated']('model-proxy')
    assert.equal(globalThis.fetch, later)
    // Teardown cannot safely unhook an inner wrapper; it must not reset the
    // process to the pre-plugin fetch either.
    state.disposed()
    assert.equal(globalThis.fetch, later)
    globalThis.fetch = base
  })
})

describe('collectRules', () => {
  const emptyContext = { get: () => undefined }

  it('lists exclusions separately so they can win at match time', () => {
    const rules = collectRules(emptyContext, {
      proxy: '',
      proxyHosts: ['*.example.com'],
      excludeHosts: ['api.example.com'],
    })
    assert.deepEqual([...rules.includes], ['*.example.com'])
    assert.deepEqual([...rules.excludes], ['api.example.com'])
  })

  it('empty means no proxy, even when catalog endpoints and custom gateways exist', () => {
    const ctx = { get: () => ({ describe: () => [{ ns: 'llm-pi-ai', value: { providers: { custom: { baseURL: 'https://custom.example/v1' } } } }] }) }
    const rules = collectRules(ctx, { proxy: 'http://127.0.0.1:7890', proxyHosts: [], excludeHosts: [] })
    assert.equal(rules.includes.size, 0)
    assert.equal(rules.excludes.size, 0)
  })
})
