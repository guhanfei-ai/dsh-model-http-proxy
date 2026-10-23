/**
 * Browser-safe routing data, legacy migration, and multi-proxy selection.
 * No Node or transport dependencies: the settings page and host use the same
 * normalization, conflict detection, and precedence rules.
 * @module dsh-model-http-proxy/routes
 */

import { BUILTIN_DIRECT_HOSTS, BUILTIN_PROXY_HOSTS, hostMatches, normalizeHostEntry } from './hosts.js'

/** One independently editable proxy card. Its position has no routing meaning. */
export interface ProxyEntry {
  id: string
  name: string
  enabled: boolean
  proxy: string
  proxyHosts: string[]
}

/** The complete authoritative routing section once migrated. */
export interface RoutingFields {
  proxies: ProxyEntry[]
  excludeHosts: string[]
}

/** An identical normalized rule owned by multiple enabled cards. */
export interface ProxyConflict {
  host: string
  proxyIds: string[]
  proxyNames: string[]
}

/** Read an optional list without dropping malformed entries or changing empty. */
function hostList(value: unknown, fallback: readonly string[], label: string): string[] {
  if (value === undefined) return [...fallback]
  if (!Array.isArray(value)) throw new TypeError(`${label}必须是字符串列表`)
  const entries = [...value]
  if (!entries.every(item => typeof item === 'string')) throw new TypeError(`${label}必须是字符串列表`)
  return entries as string[]
}

/**
 * Read current fields, or migrate legacy fields without writing anything back.
 * An absent `proxies` takes the legacy path; a present empty list is final.
 * Malformed new data throws instead of quietly restoring legacy/env routing.
 */
export function routingFieldsOf(value: unknown, envProxy = ''): RoutingFields {
  if (value !== undefined && (value === null || typeof value !== 'object' || Array.isArray(value))) {
    throw new TypeError('代理配置必须是对象')
  }
  const section = (value ?? {}) as Record<string, unknown>
  const excludeHosts = hostList(section.excludeHosts, BUILTIN_DIRECT_HOSTS, '直连域名')
  if (section.proxies !== undefined) {
    if (!Array.isArray(section.proxies)) throw new TypeError('proxies 必须是代理列表')
    const proxies = Array.from(section.proxies, (raw: unknown, index): ProxyEntry => {
      const label = `代理${index + 1}`
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new TypeError(`${label}必须是对象`)
      }
      const entry = raw as Record<string, unknown>
      for (const key of ['id', 'name', 'proxy'] as const) {
        if (typeof entry[key] !== 'string') throw new TypeError(`${label}的 ${key} 必须是字符串`)
      }
      if (typeof entry.enabled !== 'boolean') throw new TypeError(`${label}的 enabled 必须是布尔值`)
      if (!Array.isArray(entry.proxyHosts)) throw new TypeError(`${label}的代理域名必须是字符串列表`)
      return {
        id: entry.id as string,
        name: entry.name as string,
        enabled: entry.enabled,
        proxy: entry.proxy as string,
        proxyHosts: hostList(entry.proxyHosts, [], `${label}的代理域名`),
      }
    })
    return { proxies, excludeHosts }
  }
  if (section.proxy !== undefined && typeof section.proxy !== 'string') {
    throw new TypeError('代理地址必须是字符串')
  }
  const configured = section.proxy as string | undefined
  const proxy = configured !== undefined && configured.length > 0 ? configured : envProxy
  return {
    proxies: [{
      id: 'legacy',
      name: '代理1',
      enabled: proxy.length > 0,
      proxy,
      proxyHosts: hostList(section.proxyHosts, BUILTIN_PROXY_HOSTS, '代理域名'),
    }],
    excludeHosts,
  }
}

/** Identical rules conflict across enabled cards, not within a single card. */
export function proxyConflicts(fields: RoutingFields): ProxyConflict[] {
  const owners = new Map<string, Map<string, string>>()
  for (const proxy of fields.proxies) {
    if (!proxy.enabled) continue
    for (const raw of proxy.proxyHosts) {
      const host = normalizeHostEntry(raw)
      if (host === undefined) continue // validation explains invalid rules separately
      let cards = owners.get(host)
      if (cards === undefined) {
        cards = new Map<string, string>()
        owners.set(host, cards)
      }
      cards.set(proxy.id, proxy.name)
    }
  }
  return [...owners]
    .filter(([, cards]) => cards.size > 1)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([host, cards]) => ({ host, proxyIds: [...cards.keys()], proxyNames: [...cards.values()] }))
}

/**
 * Global exclusion always wins. Otherwise exact beats wildcard, and a longer
 * wildcard suffix beats a shorter one. Equal rules are rejected by validation;
 * a stable id tie-break also keeps this helper independent of card order while
 * a draft still contains a conflict.
 */
export function selectProxy(hostname: string, fields: RoutingFields): ProxyEntry | undefined {
  if (fields.excludeHosts.some(rule => hostMatches(hostname, rule))) return undefined
  let selected: ProxyEntry | undefined
  let best = -1
  for (const proxy of fields.proxies) {
    if (!proxy.enabled) continue
    for (const raw of proxy.proxyHosts) {
      const rule = normalizeHostEntry(raw)
      if (rule === undefined || !hostMatches(hostname, rule)) continue
      const score = rule.startsWith('*.') ? rule.length - 2 : Number.POSITIVE_INFINITY
      if (score > best || (score === best && selected !== undefined && proxy.id < selected.id)) {
        best = score
        selected = proxy
      }
    }
  }
  return selected
}
