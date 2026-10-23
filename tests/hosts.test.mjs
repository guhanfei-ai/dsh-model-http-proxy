/**
 * Domain matching and rule precedence. These are the behaviours the settings
 * page promises, and the ones that were wrong before: an exclude ignored by an
 * include suffix, and a suffix matching hosts it never named.
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import { after, before, describe, it } from 'node:test'
import {
  DEFAULT_MODEL_HOSTS,
  DEFAULT_MODEL_HOST_SUFFIXES,
  emptyRules,
  hostMatches,
  isRoutedHost,
  normalizeHostEntry,
  shouldProxy,
} from '../lib/index.js'
import { assertValid, configProblem, redactProxyUrl } from '../lib/index.js'

describe('normalizeHostEntry', () => {
  it('accepts the shapes the settings page allows', () => {
    const cases = [
      ['api.openai.com', 'api.openai.com'],
      ['API.OPENAI.COM', 'api.openai.com'],
      ['https://API.OPENAI.COM:443/v1/models', 'api.openai.com'],
      ['api.openai.com:8443', 'api.openai.com'],
      ['  api.openai.com  ', 'api.openai.com'],
      ['api.openai.com.', 'api.openai.com'],
      ['*.example.com', '*.example.com'],
      ['[::1]', '[::1]'],
    ]
    for (const [input, expected] of cases) {
      assert.equal(normalizeHostEntry(input), expected, input)
    }
  })

  it('canonicalizes internationalized names to the punycode routing compares', () => {
    assert.equal(normalizeHostEntry('例子.测试'), 'xn--fsqu00a.xn--0zwm56d')
    assert.equal(hostMatches('xn--fsqu00a.xn--0zwm56d', normalizeHostEntry('例子.测试')), true)
  })

  it('refuses entries that are not hostnames instead of guessing', () => {
    for (const input of ['', '   ', 'https://', 'bad host name', '/just/a/path', '.', 'a..b.com', '.example.com', '*-example.com', 'https://*.example.com', '*.127.0.0.1']) {
      assert.equal(normalizeHostEntry(input), undefined, JSON.stringify(input))
    }
  })
})

describe('hostMatches', () => {
  it('matches exact entries exactly', () => {
    assert.equal(hostMatches('api.openai.com', 'api.openai.com'), true)
    assert.equal(hostMatches('api.openai.com.evil.invalid', 'api.openai.com'), false)
    assert.equal(hostMatches('other.openai.com', 'api.openai.com'), false)
  })

  it('matches suffix entries on the bare domain and real subdomains only', () => {
    assert.equal(hostMatches('example.com', '*.example.com'), true)
    assert.equal(hostMatches('api.example.com', '*.example.com'), true)
    assert.equal(hostMatches('a.b.example.com', '*.example.com'), true)
    // The hyphen heuristic is gone: this is a different registrable domain.
    assert.equal(hostMatches('other-example.com', '*.example.com'), false)
  })

  it('only accepts the explicit *.domain suffix format, including root and deep children', () => {
    assert.equal(hostMatches('openai.com', 'openai.com'), true)
    assert.equal(hostMatches('api.openai.com', 'openai.com'), false)
    for (const host of ['openai.com', 'api.openai.com', 'a.b.openai.com', 'API.OPENAI.COM.']) {
      assert.equal(hostMatches(host, '*.openai.com'), true, host)
    }
    for (const host of ['fake-openai.com', 'openai.com.evil.com']) {
      assert.equal(hostMatches(host, '*.openai.com'), false, host)
    }
    assert.equal(normalizeHostEntry('.openai.com'), undefined)
    assert.equal(hostMatches('openai.com', '.openai.com'), false)
    assert.equal(normalizeHostEntry('*-example.com'), undefined)
  })
})

describe('isRoutedHost precedence', () => {
  it('lets an exact exclusion override an include suffix', () => {
    const includes = new Set(['*.example.com'])
    const excludes = new Set(['api.example.com'])
    assert.equal(isRoutedHost('www.example.com', includes, excludes), true)
    assert.equal(isRoutedHost('api.example.com', includes, excludes), false)
  })

  it('lets a suffix exclusion override an exact include', () => {
    const includes = new Set(['api.example.com'])
    const excludes = new Set(['*.example.com'])
    assert.equal(isRoutedHost('api.example.com', includes, excludes), false)
  })

  it('routes nothing when a host matches both lists', () => {
    const includes = new Set(['api.example.com'])
    const excludes = new Set(['api.example.com'])
    assert.equal(isRoutedHost('api.example.com', includes, excludes), false)
  })
})

describe('shouldProxy', () => {
  it('keeps malformed URLs direct', () => {
    assert.equal(shouldProxy('not a url', new Set(['*.example.com'])), false)
  })

  it('is the (includes, excludes) pair the dispatcher uses', () => {
    assert.equal(shouldProxy('https://chatgpt.com/backend-api/x', new Set(['chatgpt.com']), new Set()), true)
  })
})

describe('catalog metadata (not implicit active rules)', () => {
  it('covers every endpoint the settings page can suggest', () => {
    // The exact drift that made `meta` suggest api.meta.ai while auto mode
    // never proxied it.
    assert.ok(DEFAULT_MODEL_HOSTS.includes('api.meta.ai'))
    assert.ok(DEFAULT_MODEL_HOSTS.includes('chatgpt.com'))
  })

  it('covers both hosts the ChatGPT-subscription adapter talks to', () => {
    // chatgpt.com carries the model API and quota; auth.openai.com carries the
    // OAuth token refresh. Missing the latter breaks Codex with a misleading
    // "authorization failed" while the proxy itself is fine.
    assert.ok(DEFAULT_MODEL_HOSTS.includes('chatgpt.com'))
    assert.ok(DEFAULT_MODEL_HOSTS.includes('auth.openai.com'))
  })

  it('covers the templated families through explicit globs', () => {
    const includes = new Set(DEFAULT_MODEL_HOST_SUFFIXES)
    assert.equal(isRoutedHost('us-central1-aiplatform.googleapis.com', includes, new Set()), false)
    assert.equal(isRoutedHost('myresource.openai.azure.com', includes, new Set()), true)
  })

  it('emptyRules starts empty', () => {
    const rules = emptyRules()
    assert.equal(rules.includes.size, 0)
    assert.equal(rules.excludes.size, 0)
  })
})

describe('assertValid', () => {
  it('accepts the supported schemes', () => {
    for (const scheme of ['http', 'https', 'socks5', 'socks5h']) {
      assert.doesNotThrow(() => assertValid({ proxy: `${scheme}://127.0.0.1:7890`, proxyHosts: [], excludeHosts: [] }))
    }
  })

  it('refuses the SOCKS4 schemes the transport cannot serve', () => {
    for (const scheme of ['socks4', 'socks4a']) {
      assert.throws(
        () => assertValid({ proxy: `${scheme}://127.0.0.1:7890`, proxyHosts: [], excludeHosts: [] }),
        /socks4/,
      )
    }
  })

  it('refuses malformed host entries instead of silently dropping them', () => {
    assert.throws(
      () => assertValid({ proxy: '', proxyHosts: ['bad host name'], excludeHosts: [] }),
      /代理域名/u,
    )
    assert.throws(
      () => assertValid({ proxy: '', proxyHosts: [], excludeHosts: ['https://'] }),
      /直连域名/u,
    )
  })
})

describe('configProblem (the message the settings page shows)', () => {
  it('accepts a usable configuration', () => {
    assert.equal(configProblem({ proxy: 'socks5://127.0.0.1:1080', proxyHosts: ['api.openai.com'], excludeHosts: [] }), null)
  })

  it('explains a rejected configuration instead of saving it', () => {
    assert.match(configProblem({ proxy: 'socks4://127.0.0.1:1', proxyHosts: [], excludeHosts: [] }), /socks4/u)
    assert.match(configProblem({ proxy: 'not a url', proxyHosts: [], excludeHosts: [] }), /代理地址无效/u)
    assert.match(configProblem({ proxy: '', proxyHosts: ['bad host'], excludeHosts: [] }), /代理域名/u)
    assert.match(configProblem({ proxy: '', proxyHosts: [], excludeHosts: ['https://'] }), /直连域名/u)
  })
})

describe('credential redaction', () => {
  it('keeps credentials out of the displayed message', () => {
    const shown = redactProxyUrl('socks5://alice:s3cret@proxy.local:1080')
    assert.doesNotMatch(shown, /alice|s3cret/u)
    assert.match(shown, /proxy\.local:1080/u)
  })

  it('keeps credentials out of validation messages', () => {
    assert.throws(
      () => assertValid({ proxy: 'ftp://alice:s3cret@proxy.local:21', proxyHosts: [], excludeHosts: [] }),
      (error) => {
        assert.match(error.message, /不受支持/u)
        assert.doesNotMatch(error.message, /s3cret/)
        assert.doesNotMatch(error.message, /alice/)
        return true
      },
    )
  })
})

describe('loopback fetch wiring', () => {
  let server
  let base
  before(async () => {
    server = http.createServer((request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('direct')
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${server.address().port}`
  })
  after(() => new Promise(resolve => server.close(resolve)))

  it('leaves the platform fetch untouched when no proxy is configured', async () => {
    const response = await fetch(`${base}/`)
    assert.equal(await response.text(), 'direct')
  })
})
