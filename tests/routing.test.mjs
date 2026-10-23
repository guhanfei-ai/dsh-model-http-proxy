/**
 * End-to-end routing over real loopback sockets: a stand-in forward proxy and
 * stand-in origins. These are the behaviours that used to be wrong — redirects
 * kept the first hop's transport, a native `Request` broke under the undici
 * fetch, and the proxied response was a foreign `Response` class.
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import { after, before, describe, it } from 'node:test'
import { Agent } from 'undici'
import { createProxyFetch, emptyRules } from '../lib/index.js'

/** Start an HTTP server on a free loopback port. */
async function listen(handler) {
  const server = http.createServer(handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { server, origin: `http://127.0.0.1:${server.address().port}` }
}

describe('routing dispatcher', () => {
  /** Every request URL the stand-in proxy received, in order. */
  const proxied = []
  const rules = emptyRules()
  const servers = []
  let proxyPort
  let directOrigin
  let secondOrigin
  let redirectorOrigin
  let runtime

  before(async () => {
    const direct = await listen((request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('direct')
    })
    directOrigin = direct.origin

    const second = await listen((request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('direct-after-redirect')
    })
    secondOrigin = second.origin

    // A stand-in forward proxy: answers absolute-form requests itself, so a
    // request that reaches it proves the routing decision.
    const proxy = await listen((request, response) => {
      proxied.push(request.url)
      if (request.url.includes('/redirect-to-direct')) {
        response.writeHead(302, { location: `${secondOrigin}/final` })
        response.end()
        return
      }
      if (request.url.includes('/stream')) {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.write('data: first\n\n')
        setTimeout(() => { response.end('data: second\n\n') }, 10)
        return
      }
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('via-proxy')
    })
    proxyPort = proxy.server.address().port

    // A direct origin that points the client at a routed hop.
    const redirector = await listen((request, response) => {
      response.writeHead(302, { location: `http://localhost:${proxyPort}/ok` })
      response.end()
    })
    redirectorOrigin = redirector.origin

    servers.push(direct.server, second.server, proxy.server, redirector.server)
    rules.includes.add('localhost')
    runtime = createProxyFetch(globalThis.fetch, `http://127.0.0.1:${proxyPort}`, rules)
  })

  after(async () => {
    await runtime.close()
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))))
  })

  it('sends a routed host through the proxy', async () => {
    proxied.length = 0
    const response = await runtime.fetch(`http://localhost:${proxyPort}/ok`)
    assert.equal(await response.text(), 'via-proxy')
    assert.equal(proxied.length, 1)
  })

  it('keeps a non-routed host direct', async () => {
    proxied.length = 0
    const response = await runtime.fetch(`${directOrigin}/direct`)
    assert.equal(await response.text(), 'direct')
    assert.deepEqual(proxied, [])
  })

  it('returns the platform Response class, not a foreign one', async () => {
    const response = await runtime.fetch(`http://localhost:${proxyPort}/ok`)
    assert.equal(response instanceof Response, true)
    await response.text()
  })

  it('accepts a native Request, including a streaming body', async () => {
    const request = new Request(`http://localhost:${proxyPort}/ok`, {
      method: 'POST',
      body: 'payload',
      duplex: 'half',
    })
    const response = await runtime.fetch(request)
    assert.equal(response.status, 200)
    assert.equal(await response.text(), 'via-proxy')
  })

  it('re-evaluates transport on a redirect that crosses into a routed host', async () => {
    proxied.length = 0
    const response = await runtime.fetch(`${redirectorOrigin}/start`)
    assert.equal(await response.text(), 'via-proxy')
    // The direct first hop never reached the proxy; the redirected one did.
    assert.equal(proxied.length, 1)
    assert.match(proxied[0], /\/ok$/u)
  })

  it('re-evaluates transport on a redirect that leaves the routed host', async () => {
    proxied.length = 0
    const response = await runtime.fetch(`http://localhost:${proxyPort}/redirect-to-direct`)
    assert.equal(await response.text(), 'direct-after-redirect')
    assert.equal(proxied.length, 1)
  })

  it('streams a proxied response body in sequence', async () => {
    const response = await runtime.fetch(`http://localhost:${proxyPort}/stream`)
    assert.equal(await response.text(), 'data: first\n\ndata: second\n\n')
  })

  it('follows live rule changes without rebuilding the transport', async () => {
    proxied.length = 0
    rules.includes.add('127.0.0.1')
    try {
      const response = await runtime.fetch(`${secondOrigin}/now-routed`)
      assert.equal(await response.text(), 'via-proxy')
      assert.equal(proxied.length, 1)
    } finally {
      rules.includes.delete('127.0.0.1')
    }
  })

  it('leaves a caller-supplied dispatcher alone', async () => {
    proxied.length = 0
    const direct = new Agent()
    try {
      // Same URL, but the caller chose its own transport: the request must
      // reach the origin directly instead of the plugin's proxy.
      const response = await runtime.fetch(`http://localhost:${new URL(directOrigin).port}/own-transport`, {
        dispatcher: direct,
      })
      assert.equal(await response.text(), 'direct')
      assert.deepEqual(proxied, [])
    } finally {
      await direct.close()
    }
  })

  it('honours exclusions that the include list would otherwise cover', async () => {
    proxied.length = 0
    rules.includes.add('127.0.0.1')
    rules.excludes.add('127.0.0.1')
    try {
      const response = await runtime.fetch(`${secondOrigin}/excluded`)
      // Direct to the origin, not the stand-in proxy that answers 'via-proxy'.
      assert.equal(await response.text(), 'direct-after-redirect')
      assert.deepEqual(proxied, [])
    } finally {
      rules.includes.delete('127.0.0.1')
      rules.excludes.delete('127.0.0.1')
    }
  })
})
