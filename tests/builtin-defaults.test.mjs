/** Author defaults are explicit rules, not an implicit union of catalog endpoints. */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  BUILTIN_DIRECT_HOSTS,
  BUILTIN_PROXY_GROUPS,
  BUILTIN_PROXY_HOSTS,
  Config,
  builtinHostProvider,
  collectRules,
  configProblem,
  hostMatches,
  routingFieldsOf,
  selectProxy,
  shouldProxy,
} from '../lib/index.js'

const directHosts = ['*.deepseek.com']
const proxyGroups = [
  { name: 'OpenAI', hosts: ['*.openai.com', '*.chatgpt.com'] },
  { name: 'Anthropic', hosts: ['*.anthropic.com', '*.claude.ai', '*.claude.com'] },
  { name: 'Google', hosts: ['*.googleapis.com', '*.gemini.google.com'] },
  { name: 'xAI', hosts: ['*.x.ai', '*.grok.com'] },
]
const proxyHosts = [
  '*.openai.com', '*.chatgpt.com',
  '*.anthropic.com', '*.claude.ai', '*.claude.com',
  '*.googleapis.com', '*.gemini.google.com',
  '*.x.ai', '*.grok.com',
]
const allGroups = [{ name: 'DeepSeek', hosts: directHosts }, ...proxyGroups]
const emptyContext = { get: () => undefined }
const proxyUrl = 'http://127.0.0.1:7890'

function resolvedFields(value) {
  const config = Config(value)
  return Object.fromEntries(['proxies', 'proxy', 'proxyHosts', 'excludeHosts'].map(key => [key, config[key].get()]))
}

describe('author builtin rules', () => {
  it('pins the intended direct list, four company groups, and flat nine-rule order', () => {
    assert.deepEqual(BUILTIN_DIRECT_HOSTS, directHosts)
    assert.deepEqual(BUILTIN_PROXY_GROUPS, proxyGroups)
    assert.deepEqual(BUILTIN_PROXY_HOSTS, proxyHosts)
    assert.deepEqual(BUILTIN_PROXY_HOSTS, BUILTIN_PROXY_GROUPS.flatMap(group => group.hosts))
    assert.equal(BUILTIN_PROXY_HOSTS.length, 9)
    assert.equal(new Set(BUILTIN_PROXY_HOSTS).size, 9)
    for (const host of ['auth.openai.com', '*.google.com', '*.x.com', 'gemini.com', '*.gemini.com']) {
      assert.ok(!BUILTIN_PROXY_HOSTS.includes(host), `${host} is not an author default`)
    }
  })

  it('labels only exact normalized builtin rules with the correct company', () => {
    for (const group of allGroups) {
      for (const rule of group.hosts) {
        assert.equal(builtinHostProvider(rule), group.name, rule)
        assert.equal(builtinHostProvider(`  ${rule.toUpperCase()}.  `), group.name, `${rule} normalizes before lookup`)
        const root = rule.slice(2)
        for (const concrete of [root, `api.${root}`, `a.b.${root}`, `*.api.${root}`, `https://api.${root}/v1`]) {
          assert.equal(builtinHostProvider(concrete), undefined, `${concrete} matches a rule but is not itself builtin`)
        }
      }
    }
    for (const entry of ['auth.openai.com', '*.google.com', '*.x.com', 'gemini.com', '*.gemini.com', '.openai.com', 'bad host', '']) {
      assert.equal(builtinHostProvider(entry), undefined, entry)
    }
  })

  it('matches each wildcard root and arbitrarily deep children without accepting deceptive suffixes', () => {
    for (const rule of [...directHosts, ...proxyHosts]) {
      const root = rule.slice(2)
      for (const host of [root, `api.${root}`, `a.b.${root}`, `A.B.${root.toUpperCase()}.`]) {
        assert.equal(hostMatches(host, rule), true, `${rule} covers ${host}`)
      }
      for (const host of [`fake-${root}`, `fake${root}`, `${root}.evil.test`, `api.${root}.evil.test`]) {
        assert.equal(hostMatches(host, rule), false, `${rule} rejects ${host}`)
      }
    }
  })

  it('routes auth through the OpenAI wildcard and intentionally covers other googleapis APIs, not unrelated sites', () => {
    const fields = routingFieldsOf({ proxy: proxyUrl })
    for (const host of [
      'auth.openai.com', 'chatgpt.com', 'api.anthropic.com', 'claude.ai', 'claude.com',
      'googleapis.com', 'generativelanguage.googleapis.com', 'us-central1-aiplatform.googleapis.com',
      'storage.googleapis.com', 'gemini.google.com', 'chat.gemini.google.com',
      'x.ai', 'api.x.ai', 'grok.com', 'api.grok.com',
    ]) {
      assert.equal(selectProxy(host, fields)?.id, 'legacy', host)
    }
    for (const host of [
      'google.com', 'www.google.com', 'search.google.com', 'x.com', 'api.x.com', 'gemini.com', 'api.gemini.com',
      'fake-openai.com', 'openai.com.evil.test', 'chatgpt.com.evil.test', 'api.meta.ai', 'custom.gateway.test',
    ]) {
      assert.equal(selectProxy(host, fields), undefined, `${host} must not become an implicit default`)
    }
    assert.deepEqual(fields.proxies[0].proxyHosts, proxyHosts, 'matching never expands or rewrites the saved rules')
  })
})

describe('missing fields versus explicit stored routing', () => {
  it('creates exactly one disabled legacy 代理1 and no automatic 代理2 for a fresh document', () => {
    const expected = {
      proxies: [{ id: 'legacy', name: '代理1', enabled: false, proxy: '', proxyHosts }],
      excludeHosts: directHosts,
    }
    assert.deepEqual(routingFieldsOf({}), expected)
    assert.deepEqual(routingFieldsOf(undefined), expected)
    assert.equal(configProblem(routingFieldsOf({})), null)
    const configured = routingFieldsOf({ proxy: proxyUrl })
    assert.equal(configured.proxies.length, 1)
    assert.equal(configured.proxies[0].enabled, true)
    assert.deepEqual(configured.proxies[0].proxyHosts, proxyHosts)
  })

  it('keeps schema defaults aligned with in-memory migration without schema-seeding an authoritative proxies array', () => {
    const resolved = resolvedFields({})
    assert.equal(resolved.proxies, undefined)
    assert.equal(resolved.proxy, '')
    assert.deepEqual(resolved.proxyHosts, proxyHosts)
    assert.deepEqual(resolved.excludeHosts, directHosts)
    assert.deepEqual(routingFieldsOf(resolved), routingFieldsOf({}))
    for (const value of [
      { proxy: proxyUrl, proxyHosts: [], excludeHosts: [] },
      { proxy: proxyUrl, proxyHosts: ['auth.openai.com'], excludeHosts: ['api.deepseek.com'] },
      { proxies: [], excludeHosts: [] },
      { proxies: [{ id: 'saved', name: '代理2', enabled: false, proxy: '', proxyHosts: [] }], excludeHosts: [] },
    ]) {
      assert.deepEqual(routingFieldsOf(resolvedFields(value)), routingFieldsOf(value), JSON.stringify(value))
    }
  })

  it('gives the missing DeepSeek global exclusion precedence even over an exact proxy rule', () => {
    const value = { proxy: proxyUrl, proxyHosts: ['*.deepseek.com', 'api.deepseek.com', '*.openai.com'] }
    const fields = routingFieldsOf(value)
    const rules = collectRules(emptyContext, value)
    assert.deepEqual(fields.excludeHosts, directHosts)
    assert.deepEqual([...rules.excludes], directHosts)
    for (const host of ['deepseek.com', 'api.deepseek.com', 'a.b.deepseek.com', 'API.DEEPSEEK.COM.']) {
      assert.equal(selectProxy(host, fields), undefined, host)
      assert.equal(shouldProxy(`https://${host}/v1`, rules.includes, rules.excludes), false, host)
    }
    assert.equal(selectProxy('auth.openai.com', fields)?.id, 'legacy')
    const explicitEmpty = routingFieldsOf({ ...value, excludeHosts: [] })
    assert.equal(selectProxy('api.deepseek.com', explicitEmpty)?.id, 'legacy', 'an explicitly empty direct list is final')
    assert.deepEqual(explicitEmpty.excludeHosts, [])
  })

  it('preserves explicit legacy lists verbatim, including saved auth rules and deliberate empty arrays', () => {
    for (const proxyHosts of [[], ['auth.openai.com'], ['auth.openai.com', 'https://API.OpenAI.COM.:443/v1', '.old.example.com']]) {
      for (const excludeHosts of [[], ['api.deepseek.com', 'CUSTOM.Direct.test.']]) {
        const value = { proxy: proxyUrl, proxyHosts, excludeHosts }
        const before = structuredClone(value)
        const migrated = routingFieldsOf(value)
        assert.deepEqual(migrated.proxies[0].proxyHosts, proxyHosts)
        assert.deepEqual(migrated.excludeHosts, excludeHosts)
        assert.notEqual(migrated.proxies[0].proxyHosts, proxyHosts)
        assert.notEqual(migrated.excludeHosts, excludeHosts)
        migrated.proxies[0].proxyHosts.push('draft-only.test')
        migrated.excludeHosts.push('draft-only.test')
        assert.deepEqual(value, before, 'reading and editing a migrated draft cannot mutate stored arrays')
      }
    }
  })

  it('preserves explicit modern cards and empty card lists without reviving defaults or legacy/env values', () => {
    for (const proxies of [[], [
      { id: 'empty', name: '代理2', enabled: true, proxy: proxyUrl, proxyHosts: [] },
      { id: 'saved', name: 'Saved', enabled: false, proxy: '', proxyHosts: ['auth.openai.com', 'chatgpt.com'] },
    ]]) {
      const value = { proxies, excludeHosts: [], proxy: proxyUrl, proxyHosts: ['obsolete.test'] }
      const before = structuredClone(value)
      assert.deepEqual(routingFieldsOf(value, 'http://environment.test:7890'), { proxies, excludeHosts: [] })
      assert.deepEqual(value, before)
      assert.deepEqual(routingFieldsOf({ ...value, excludeHosts: undefined }).excludeHosts, directHosts)
    }
  })

  it('returns fresh copies of missing-list defaults so deleting rules never changes future initialization', () => {
    const first = routingFieldsOf({})
    first.proxies[0].proxyHosts.splice(0)
    first.excludeHosts.splice(0)
    assert.deepEqual(first, { proxies: [{ id: 'legacy', name: '代理1', enabled: false, proxy: '', proxyHosts: [] }], excludeHosts: [] })
    const next = routingFieldsOf({})
    assert.deepEqual(next.proxies[0].proxyHosts, proxyHosts)
    assert.deepEqual(next.excludeHosts, directHosts)
    assert.deepEqual(BUILTIN_PROXY_HOSTS, proxyHosts)
    assert.deepEqual(BUILTIN_DIRECT_HOSTS, directHosts)
    assert.deepEqual(routingFieldsOf(first), first, 'an explicit emptied draft is never seeded again')
  })
})
