/**
 * The settings page's cross-field rules, exercised directly. These are the
 * behaviours that used to be wrong: a hostname could be typed into both lists,
 * and a revision conflict had no safe way back to a current document.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  addHostEntries,
  overlappingHosts,
  rebaseProxyFields,
  visibleHostSuggestions,
} from '../lib/index.js'

describe('addHostEntries', () => {
  it('commits several entries at once, de-duplicated', () => {
    const { hosts, conflicts } = addHostEntries(['a.com'], [], 'b.com, c.com，a.com')
    assert.deepEqual(hosts, ['a.com', 'b.com', 'c.com'])
    assert.deepEqual(conflicts, [])
  })

  it('refuses a hostname the opposite list already owns', () => {
    const { hosts, conflicts } = addHostEntries([], ['API.OpenAI.COM'], 'https://api.openai.com/v1')
    assert.deepEqual(hosts, [])
    assert.deepEqual(conflicts, ['https://api.openai.com/v1'])
  })

  it('ignores entries that are not hostnames', () => {
    const { hosts, conflicts } = addHostEntries(['a.com'], [], '   ')
    assert.deepEqual(hosts, ['a.com'])
    assert.deepEqual(conflicts, [])
  })
})

describe('visibleHostSuggestions', () => {
  const suggestions = [
    { host: 'api.openai.com', providers: ['OpenAI'] },
    { host: 'chatgpt.com', providers: ['Codex 订阅'] },
    { host: 'api.kimi.com', providers: ['Kimi'] },
  ]

  it('hides hosts already committed on either side', () => {
    const rows = visibleHostSuggestions(suggestions, ['api.openai.com'], ['api.kimi.com'], '')
    assert.deepEqual(rows.map(row => row.host), ['chatgpt.com'])
  })

  it('matches the provider label the user sees, not just the hostname', () => {
    const rows = visibleHostSuggestions(suggestions, [], [], 'codex')
    assert.deepEqual(rows.map(row => row.host), ['chatgpt.com'])
  })
})

describe('overlappingHosts', () => {
  it('detects the same host written differently', () => {
    const overlap = overlappingHosts({
      proxy: '',
      proxyHosts: ['https://API.OPENAI.COM:443/v1'],
      excludeHosts: ['api.openai.com'],
    })
    assert.deepEqual(overlap, ['api.openai.com'])
  })

  it('reports nothing when the lists are disjoint', () => {
    assert.deepEqual(overlappingHosts({ proxy: '', proxyHosts: ['a.com'], excludeHosts: ['b.com'] }), [])
  })
})

describe('rebaseProxyFields', () => {
  const base = { proxy: '', proxyHosts: ['a.com'], excludeHosts: [] }

  it('takes the remote value for a field the user never touched', () => {
    const latest = { proxy: '', proxyHosts: ['a.com', 'b.com'], excludeHosts: [] }
    const draft = { proxy: 'http://127.0.0.1:7890', proxyHosts: ['a.com'], excludeHosts: [] }
    const { fields, conflicts } = rebaseProxyFields(base, draft, latest)
    assert.equal(fields.proxy, 'http://127.0.0.1:7890')
    assert.deepEqual(fields.proxyHosts, ['a.com', 'b.com'])
    assert.deepEqual(conflicts, [])
  })

  it('reports a list both sides changed instead of merging silently', () => {
    const latest = { proxy: '', proxyHosts: ['a.com', 'b.com'], excludeHosts: [] }
    const draft = { proxy: '', proxyHosts: ['a.com', 'c.com'], excludeHosts: [] }
    const { fields, conflicts } = rebaseProxyFields(base, draft, latest)
    assert.deepEqual(conflicts, ['proxyHosts'])
    assert.deepEqual(fields.proxyHosts, ['a.com', 'c.com'])
  })

  it('reports a field both sides changed instead of picking silently', () => {
    const latest = { proxy: 'http://127.0.0.1:8080', proxyHosts: ['a.com'], excludeHosts: [] }
    const draft = { proxy: 'socks5://127.0.0.1:1080', proxyHosts: ['a.com'], excludeHosts: [] }
    const { fields, conflicts } = rebaseProxyFields(base, draft, latest)
    assert.deepEqual(conflicts, ['proxy'])
    assert.equal(fields.proxy, 'socks5://127.0.0.1:1080')
  })

  it('does not treat chip reordering as an edit', () => {
    const ordered = { proxy: '', proxyHosts: ['a.com', 'b.com'], excludeHosts: [] }
    const latest = { proxy: '', proxyHosts: ['b.com', 'a.com'], excludeHosts: [] }
    const draft = { proxy: '', proxyHosts: ['a.com', 'b.com'], excludeHosts: [] }
    const { fields, conflicts } = rebaseProxyFields(ordered, draft, latest)
    assert.deepEqual(conflicts, [])
    // Unchanged by the user, so the freshly read order wins.
    assert.deepEqual(fields.proxyHosts, ['b.com', 'a.com'])
  })
})
