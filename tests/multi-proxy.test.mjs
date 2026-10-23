/** All sockets stay on loopback; .test names resolve only through a local agent. */
import assert from 'node:assert/strict'
import http from 'node:http'
import { after, before, describe, it } from 'node:test'
import { Agent, Dispatcher, getGlobalDispatcher, setGlobalDispatcher } from 'undici'
import {
  BUILTIN_DIRECT_HOSTS,
  BUILTIN_PROXY_HOSTS,
  Config,
  apply,
  assertValid,
  collectRules,
  configProblem,
  createMultiProxyFetch,
  createProxyDispatcher,
  proxyConflicts,
  routingFieldsOf,
  selectProxy,
} from '../lib/index.js'

const card = (id, proxyHosts = [], patch = {}) => ({
  id, name: `代理 ${id}`, enabled: true, proxy: 'http://127.0.0.1:7890', proxyHosts, ...patch,
})
const fields = (...proxies) => ({ proxies, excludeHosts: [] })

/** A minimal Cordis/settings host that can replace the live raw document. */
function makeContext(section) {
  const state = { section, warnings: [], handlers: {}, dispose: undefined }
  const ctx = {
    get: () => ({ describe: () => [{ ns: 'model-proxy', value: state.section }] }),
    on: (name, handler) => { state.handlers[name] = handler },
    effect: (callback) => { state.dispose = callback() },
    logger: { warn: (...args) => { state.warnings.push(args) } },
  }
  return { ctx, state, update: next => {
    state.section = next
    state.handlers['settings/document-updated']('model-proxy')
  } }
}

async function listen(handler) {
  const server = http.createServer(handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { server, port: server.address().port, url: `http://127.0.0.1:${server.address().port}` }
}

/** Track the exact host-owned dispatcher and resolve fake domains locally. */
class HostDispatcher extends Dispatcher {
  dispatches = 0
  closes = 0
  agent = new Agent({ connect: { lookup: (_hostname, options, callback) => {
    if (options.all) callback(null, [{ address: '127.0.0.1', family: 4 }])
    else callback(null, '127.0.0.1', 4)
  } } })
  dispatch(options, handler) { this.dispatches += 1; return this.agent.dispatch(options, handler) }
  close() { this.closes += 1; return this.agent.close() }
}

describe('shared multi-proxy migration', () => {
  it('migrates stable identity, env fallback, and defaults only for missing legacy hosts', () => {
    assert.deepEqual(routingFieldsOf({ proxy: 'http://saved:7890', excludeHosts: ['local.test'] }, 'http://env:7890'), {
      proxies: [{ id: 'legacy', name: '代理1', enabled: true, proxy: 'http://saved:7890', proxyHosts: [...BUILTIN_PROXY_HOSTS] }],
      excludeHosts: ['local.test'],
    })
    assert.equal(routingFieldsOf({ proxy: '' }, 'http://env:7890').proxies[0].proxy, 'http://env:7890')
    assert.equal(routingFieldsOf({}).proxies[0].enabled, false)
    assert.deepEqual(routingFieldsOf({ proxyHosts: [] }).proxies[0].proxyHosts, [])
  })

  it('never revives legacy/env cards or builtins after an authoritative empty list', () => {
    assert.deepEqual(routingFieldsOf({ proxies: [], proxy: 'socks4://bad:1', proxyHosts: ['auth.openai.com'] }, 'http://env:7890'), {
      proxies: [], excludeHosts: [...BUILTIN_DIRECT_HOSTS],
    })
    const saved = fields(card('a', []))
    assert.deepEqual(routingFieldsOf(saved).proxies[0].proxyHosts, [])
    const copy = routingFieldsOf(saved)
    copy.proxies[0].proxyHosts.push('changed.test')
    assert.deepEqual(saved.proxies[0].proxyHosts, [], 'migration cannot mutate settings or a draft')
  })

  it('refuses malformed present proxies instead of reverting to legacy', () => {
    for (const proxies of [null, 'bad', {}, [null], Array(1), [card('a', [], { enabled: 'true' })], [card('a', [42])], [card('a', Array(1))], [{ id: 'a' }]]) {
      const raw = { proxies, proxy: 'http://legacy:7890', proxyHosts: ['legacy.test'], excludeHosts: [] }
      assert.throws(() => routingFieldsOf(raw), /代理|proxies/u)
      assert.notEqual(configProblem(raw), null)
    }
    assert.notEqual(configProblem(fields(card('a', [], { proxyHosts: undefined }))), null)
    assert.notEqual(configProblem({ proxies: [], excludeHosts: 'not-an-array' }), null)
  })

  it('does not seed proxies through schema defaults and resolves volatile legacy fields', () => {
    const resolved = Config({ proxy: 'http://127.0.0.1:7890', proxyHosts: [] })
    assert.equal(resolved.proxies.get(), undefined)
    assert.deepEqual(resolved.proxyHosts.get(), [])
    assert.deepEqual(collectRules({ get: () => undefined }, resolved).includes, new Set())
    const modern = Config({ proxies: [card('a', ['a.test'])] })
    assert.deepEqual(modern.proxies.get(), [card('a', ['a.test'])])
    assert.equal(Config({ proxies: [] }).proxies.get().length, 0)
  })
})

describe('shared conflict validation and specificity', () => {
  it('requires unique nonblank ids, names, booleans, addresses, and valid rules', () => {
    for (const config of [
      fields(card(' ')),
      fields(card('a'), card('a')),
      fields(card('a', [], { name: ' ' })),
      fields(card('a', [], { proxy: '' })),
      fields(card('a', ['.example.test'])),
      { proxies: [], excludeHosts: ['bad host'] },
    ]) assert.throws(() => assertValid(config), /model-proxy/u)
    assert.equal(configProblem(fields(card('a', [], { enabled: false, proxy: '' }))), null)
    assert.notEqual(configProblem(fields(card('a', ['bad host'], { enabled: false, proxy: '' }))), null)
  })

  it('preserves unsupported-scheme errors and redacts new-card URL credentials', () => {
    for (const scheme of ['socks4', 'socks4a', 'ftp']) {
      const problem = configProblem(fields(card('a', [], { proxy: `${scheme}://alice:demo-secret@127.0.0.1:99` })))
      assert.match(problem, /不受支持/u)
      assert.doesNotMatch(problem, /alice|demo-secret/u)
    }
    const malformed = configProblem(fields(card('a', [], { proxy: 'http://alice:demo-secret@bad host:99' })))
    assert.match(malformed, /代理地址无效/u)
    assert.doesNotMatch(malformed, /alice|demo-secret/u)
    const encoding = configProblem(fields(card('a', [], { proxy: 'http://alice:%GG-secret@127.0.0.1:7890' })))
    assert.match(encoding, /认证信息编码无效/u)
    assert.doesNotMatch(encoding, /alice|GG-secret/u)
  })

  it('constructs all supported transports offline, including the socks5h alias', async () => {
    for (const scheme of ['http', 'https', 'socks5', 'socks5h', 'socks']) {
      const dispatcher = createProxyDispatcher(`${scheme}://127.0.0.1:7890`)
      await dispatcher.close()
    }
  })

  it('finds normalized identical rules across enabled cards, not overlaps or within-card duplicates', () => {
    const config = fields(
      card('a', ['https://API.Example.test:443/path', 'api.example.test.', '*.TEAM.example.test']),
      card('b', ['api.example.test', '*.team.example.test.']),
      card('disabled', ['api.example.test'], { enabled: false, proxy: '' }),
    )
    assert.deepEqual(proxyConflicts(config), [
      { host: '*.team.example.test', proxyIds: ['a', 'b'], proxyNames: ['代理 a', '代理 b'] },
      { host: 'api.example.test', proxyIds: ['a', 'b'], proxyNames: ['代理 a', '代理 b'] },
    ])
    assert.match(configProblem(config), /冲突/u)
    assert.equal(configProblem(fields(card('a', ['api.test', 'https://API.TEST/path']))), null)
    assert.equal(configProblem(fields(card('a', ['*.example.test']), card('b', ['api.example.test']))), null)
    assert.equal(configProblem({ proxies: [card('a', ['api.test'])], excludeHosts: ['api.test'] }), null, 'global exclusion is not an error')
  })

  it('selects exact then deeper wildcard independent of card order, and ignores disabled cards', () => {
    const proxies = [
      card('wide', ['*.example.test']),
      card('deep', ['*.team.example.test']),
      card('exact', ['api.team.example.test']),
      card('disabled', ['other.team.example.test'], { enabled: false, proxy: '' }),
    ]
    for (const ordered of [proxies, [...proxies].reverse(), [proxies[2], proxies[0], proxies[3], proxies[1]]]) {
      const config = fields(...ordered)
      assert.equal(selectProxy('API.TEAM.EXAMPLE.TEST.', config)?.id, 'exact')
      assert.equal(selectProxy('other.team.example.test', config)?.id, 'deep')
      assert.equal(selectProxy('team.example.test', config)?.id, 'deep')
      assert.equal(selectProxy('example.test', config)?.id, 'wide')
      assert.equal(selectProxy('unmatched.test', config), undefined)
      config.excludeHosts = ['*.team.example.test']
      assert.equal(selectProxy('api.team.example.test', config), undefined)
    }
  })
})

describe('offline multiple proxy transports and lifecycle', () => {
  const platformFetch = globalThis.fetch
  const originalDispatcher = getGlobalDispatcher()
  const hostDispatcher = new HostDispatcher()
  const servers = []
  const hits = []
  let proxyA, proxyB, origin
  let heldSeen, releaseHeld
  const entry = (id, rules, proxy = proxyA.url) => card(id, rules, { proxy })

  before(async () => {
    origin = await listen((request, response) => {
      hits.push(`default:${request.url}`)
      if (request.url === '/default-to-b') response.writeHead(302, { location: `http://b.example.test:${origin.port}/final` })
      response.end('host-default')
    })
    proxyA = await listen((request, response) => {
      const path = new URL(request.url).pathname
      hits.push(`A:${path}`)
      if (path === '/held-redirect') {
        releaseHeld = () => {
          if (response.writableEnded) return
          response.writeHead(302, { location: `http://a.example.test:${origin.port}/old-final` })
          response.end()
        }
        heldSeen()
        return
      }
      if (path === '/a-to-b') response.writeHead(302, { location: `http://b.example.test:${origin.port}/final` })
      if (path === '/a-to-default') response.writeHead(302, { location: `http://excluded.example.test:${origin.port}/final` })
      response.end('proxy-A')
    })
    proxyB = await listen((request, response) => {
      const path = new URL(request.url).pathname
      hits.push(`B:${path}`)
      if (path === '/b-to-a') response.writeHead(302, { location: `http://a.example.test:${origin.port}/final` })
      response.end('proxy-B')
    })
    servers.push(origin.server, proxyA.server, proxyB.server)
    setGlobalDispatcher(hostDispatcher)
  })

  after(async () => {
    globalThis.fetch = platformFetch
    setGlobalDispatcher(originalDispatcher)
    assert.equal(hostDispatcher.closes, 0, 'plugin must never close the process dispatcher')
    await hostDispatcher.close()
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))))
  })

  const config = () => ({ proxies: [entry('a', ['*.example.test']), entry('b', ['b.example.test'], proxyB.url)], excludeHosts: ['excluded.example.test'] })
  const url = (host, path = '/ok') => `http://${host}:${origin.port}${path}`

  it('uses distinct proxy transports, native Request/Response, and the exact host default dispatcher', async () => {
    const runtime = createMultiProxyFetch(platformFetch, config())
    hits.length = 0
    try {
      const first = await runtime.fetch(new Request(url('a.example.test'), { method: 'POST', body: 'native', duplex: 'half' }))
      assert.equal(first instanceof Response, true)
      assert.equal(await first.text(), 'proxy-A')
      assert.equal(await (await runtime.fetch(url('b.example.test'))).text(), 'proxy-B')
      const before = hostDispatcher.dispatches
      assert.equal(await (await runtime.fetch(url('excluded.example.test'))).text(), 'host-default')
      assert.equal(await (await runtime.fetch(url('unmatched.test'))).text(), 'host-default')
      assert.equal(hostDispatcher.dispatches - before, 2)
      assert.deepEqual(hits, ['A:/ok', 'B:/ok', 'default:/ok', 'default:/ok'])
    } finally { await runtime.close() }
    assert.equal(hostDispatcher.closes, 0)
  })

  it('reselects every redirect hop from proxy A to B, B to A, A to default, and default to B', async () => {
    const runtime = createMultiProxyFetch(platformFetch, config())
    try {
      for (const [host, path, body, expected] of [
        ['a.example.test', '/a-to-b', 'proxy-B', ['A:/a-to-b', 'B:/final']],
        ['b.example.test', '/b-to-a', 'proxy-A', ['B:/b-to-a', 'A:/final']],
        ['a.example.test', '/a-to-default', 'host-default', ['A:/a-to-default', 'default:/final']],
        ['unmatched.test', '/default-to-b', 'proxy-B', ['default:/default-to-b', 'B:/final']],
      ]) {
        hits.length = 0
        assert.equal(await (await runtime.fetch(url(host, path))).text(), body)
        assert.deepEqual(hits, expected)
      }
    } finally { await runtime.close() }
  })

  it('ignores a disabled blank-address card and honours a caller explicit dispatcher', async () => {
    const runtime = createMultiProxyFetch(platformFetch, fields(
      entry('a', ['a.example.test']),
      card('disabled', ['b.example.test'], { enabled: false, proxy: '' }),
    ))
    const explicit = new HostDispatcher()
    hits.length = 0
    try {
      assert.equal(await (await runtime.fetch(url('b.example.test'))).text(), 'host-default')
      assert.equal(await (await runtime.fetch(url('a.example.test'), { dispatcher: explicit })).text(), 'host-default')
      assert.equal(explicit.dispatches, 1)
      assert.deepEqual(hits, ['default:/ok', 'default:/ok'])
    } finally { await runtime.close(); await explicit.close() }
  })

  it('never falls back to the host or another proxy when the selected proxy fails', async () => {
    const unavailable = await listen((_request, response) => response.end('not used'))
    await new Promise(resolve => unavailable.server.close(resolve))
    const runtime = createMultiProxyFetch(platformFetch, fields(
      entry('wide', ['*.example.test']),
      entry('failed', ['b.example.test'], unavailable.url),
    ))
    hits.length = 0
    const before = hostDispatcher.dispatches
    try {
      await assert.rejects(runtime.fetch(url('b.example.test'), { signal: AbortSignal.timeout(2000) }))
      assert.equal(hostDispatcher.dispatches, before)
      assert.deepEqual(hits, [])
    } finally { await runtime.close() }
  })

  it('reads live new-mode settings and retains the last complete state after invalid edits or construction failure', async () => {
    const host = makeContext(fields(entry('a', ['a.example.test'])))
    apply(host.ctx, host.state.section)
    try {
      assert.equal(await (await globalThis.fetch(url('a.example.test'))).text(), 'proxy-A')
      host.update(fields(entry('a', ['a.example.test'], proxyB.url)))
      assert.equal(await (await globalThis.fetch(url('a.example.test'))).text(), 'proxy-B')
      for (const invalid of [null, 'bad section', [], { proxies: 'malformed', proxy: proxyA.url, proxyHosts: ['a.example.test'], excludeHosts: [] }]) {
        host.update(invalid)
        assert.equal(await (await globalThis.fetch(url('a.example.test'))).text(), 'proxy-B')
      }
      host.update(fields(entry('a', ['a.example.test']), entry('duplicate', ['A.EXAMPLE.TEST.'])))
      assert.equal(await (await globalThis.fetch(url('a.example.test'))).text(), 'proxy-B')
      // Simulate an unexpected constructor/resource failure after validation,
      // without adding transport-injection machinery to the production API.
      const broken = fields(entry('a', ['a.example.test'], 'http://alice:construction-secret@127.0.0.1:7890'))
      assert.equal(configProblem(broken), null)
      const from = Buffer.from
      Buffer.from = function (...args) {
        if (args[0] === 'alice:construction-secret') throw new Error('constructor failed for alice:construction-secret')
        return Reflect.apply(from, this, args)
      }
      try { host.update(broken) } finally { Buffer.from = from }
      assert.equal(await (await globalThis.fetch(url('a.example.test'))).text(), 'proxy-B')
      const warnings = host.state.warnings.flat().join(' ')
      assert.match(warnings, /configuration rejected/u)
      assert.match(warnings, /cannot create proxy dispatchers/u)
      assert.doesNotMatch(warnings, /alice|construction-secret/u)
    } finally { host.state.dispose(); globalThis.fetch = platformFetch }
  })

  it('reports an initial invalid state instead of silently treating it as valid default routing', () => {
    const host = makeContext(fields(card('a', [], { proxy: '' })))
    apply(host.ctx, host.state.section)
    try {
      assert.equal(globalThis.fetch, platformFetch)
      assert.match(host.state.warnings.flat().join(' '), /configuration rejected/u)
    } finally { host.state.dispose() }
  })

  it('retires removed transports without breaking an in-flight redirect or a retained later wrapper', async () => {
    const host = makeContext(fields(entry('a', ['a.example.test'])))
    const oldEnv = process.env.DSH_HTTP_PROXY
    apply(host.ctx, host.state.section)
    const ours = globalThis.fetch
    const later = (...args) => ours(...args)
    globalThis.fetch = later
    let ongoing
    try {
      const seen = new Promise(resolve => { heldSeen = resolve })
      ongoing = globalThis.fetch(url('a.example.test', '/held-redirect'))
      await seen
      host.update(fields(entry('a', ['a.example.test'], proxyB.url)))
      releaseHeld()
      assert.equal(await (await ongoing).text(), 'proxy-A', 'the old redirect chain must keep its live transports')
      assert.equal(await (await globalThis.fetch(url('a.example.test'))).text(), 'proxy-B')
      assert.equal(globalThis.fetch, later)
      process.env.DSH_HTTP_PROXY = proxyA.url
      host.update({ proxies: [], proxy: proxyA.url, proxyHosts: ['a.example.test'], excludeHosts: [] })
      assert.equal(globalThis.fetch, later)
      assert.equal(await (await globalThis.fetch(url('a.example.test'))).text(), 'host-default', 'empty proxies must not revive legacy/env')
      host.state.dispose()
      assert.equal(globalThis.fetch, later)
      assert.equal(await (await later(url('a.example.test'))).text(), 'host-default')
    } finally {
      releaseHeld?.()
      if (ongoing !== undefined) await ongoing.catch(() => {})
      host.state.dispose()
      globalThis.fetch = platformFetch
      if (oldEnv === undefined) delete process.env.DSH_HTTP_PROXY
      else process.env.DSH_HTTP_PROXY = oldEnv
    }
  })
})
