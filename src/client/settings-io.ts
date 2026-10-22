/**
 * Settings IO for the M-H-Proxy page, in the shape proven by the author's
 * other plugins on this very host (dsh-grafana / dsh-mindmap on 0.2.x):
 * resolve the `remote.settings` facade with call-time `ctx.get`, parse the
 * describe envelope across its generations, and write through `mutate` with
 * whole-path `set` ops.
 *
 * This replaces the earlier `configForms` experiment (0.1.7 SettingsForms
 * client mirror), whose form never reached `ready` on the 0.2.x host and left
 * the page blank. The Host half keeps owning the `model-proxy` namespace; the
 * page only reads and writes values, never the schema.
 *
 * Resolution order (mindmap's `settingsApiOf`):
 *  1. `remote.settings` — the dsh-api-remotes facade present since 0.1.2.
 *  2. `connection.api.settings` — the pre-0.1.2 proxy, kept as a read/write
 *     fallback so an old host degrades instead of breaking.
 * `ctx.get` returns undefined for absent services; dot access without inject
 * throws, so never touch `ctx.remote` directly.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import {
  DEFAULT_DEEPSEEK_HOST,
  normalizeHostEntry,
  providerEndpointHost,
} from '../hosts.js'

/** Settings namespace the Host half owns; keep in sync with src/index.ts. */
const NS = 'model-proxy'

/** The `llm-pi-ai` namespace, read-only here, supplying gateway hostname suggestions. */
const PI_AI_NS = 'llm-pi-ai'

/** One namespace descriptor row of a describe result. */
interface NamespaceRow {
  ns?: string
  value?: unknown
  revision?: unknown
}

/** Structural shape of the remote.settings facade this page consumes. */
interface RemoteSettingsLike {
  describe?: (...args: unknown[]) => Promise<unknown>
  mutate?: (ns: string, ops: MutateOp[], expectedRevision?: number) => Promise<unknown>
  update?: (...args: unknown[]) => Promise<unknown>
}

/** One `settings.mutate` op; `set` assigns the whole path (arrays replace, not merge). */
interface MutateOp {
  op: 'set'
  path: string[]
  value: unknown
}

/** The connection-era api.settings fallback. */
interface ConnectionSettingsLike {
  describe?: (options?: unknown) => Promise<unknown>
  update?: (payload: { ns: string; patch: Record<string, unknown> }) => Promise<unknown>
}

/** Which settings api generation `settingsApiOf` resolved. */
interface SettingsApi {
  kind: 'remote' | 'connection'
  settings: RemoteSettingsLike & Partial<ConnectionSettingsLike>
}

/** The `model-proxy` fields this page edits (mirror of the Host Config). */
export interface ProxyFields {
  /** Proxy URL (http/https/socks4/socks4a/socks5/socks5h); empty = inactive. */
  proxy: string
  /** Hostnames to proxy (empty = auto-detect every model host). */
  proxyHosts: string[]
  /** Hostnames never proxied. */
  excludeHosts: string[]
}

/** What `read()` hands the page: the live fields plus the dropdown suggestions. */
export interface ProxySnapshot extends ProxyFields {
  /** Active providers' hosts for the two fields' dropdowns. */
  suggestions: HostSuggestion[]
}

/** Registration-side face the section entry injects into the page. */
export interface ProxyFace {
  /** Read the live `model-proxy` fields; null when the namespace is unreachable. */
  read(): Promise<ProxySnapshot | null>
  /** Write all three fields in one mutate transaction; throws when the write fails. */
  save(fields: ProxyFields): Promise<void>
}

/**
 * Extract the namespace descriptor rows from any describe envelope shape:
 * `{ok, value}` (remote facade), a bare array (0.1.2 provider), `{value}` /
 * `{result:{value}}` (connection-era proxies), or the pre-aggregation
 * `{namespaces}` object. Unknown shapes degrade to an empty list — the caller
 * treats that as “namespace not found”, never as an authoritative empty value.
 */
function settingsNamespacesOf(res: unknown): NamespaceRow[] {
  const source = res as { ok?: boolean; value?: unknown; result?: { value?: unknown } } | null
  let value: unknown
  if (source && typeof source === 'object' && source.ok === true) value = source.value
  else if (Array.isArray(res)) value = res
  else if (source && typeof source === 'object' && Array.isArray((source as { value?: unknown }).value)) value = (source as { value?: unknown }).value
  else if (source && typeof source === 'object' && source.result) value = source.result.value
  else value = res
  if (Array.isArray(value)) return value as NamespaceRow[]
  const list = (value as { namespaces?: unknown } | null | undefined)?.namespaces
  return Array.isArray(list) ? (list as NamespaceRow[]) : []
}

/** Read a service without inject declarations: undefined when absent, never a throw. */
function serviceOf(ctx: ClientContext, id: string): unknown {
  try {
    const get = (ctx as unknown as { get?: (name: string) => unknown }).get
    return typeof get === 'function' ? get.call(ctx, id) : undefined
  } catch {
    return undefined
  }
}

/** Resolve the settings api generation available on this host, or null. */
function settingsApiOf(ctx: ClientContext): SettingsApi | null {
  const remote = serviceOf(ctx, 'remote.settings') as RemoteSettingsLike | undefined
  if (remote && typeof remote.describe === 'function') return { kind: 'remote', settings: remote }
  const connection = serviceOf(ctx, 'connection') as { api?: { settings?: ConnectionSettingsLike } } | undefined
  const settings = connection?.api?.settings
  if (settings && typeof settings.describe === 'function') return { kind: 'connection', settings: settings as SettingsApi['settings'] }
  return null
}

/** Read the revision a write landed on, so the next save checks against it. */
function revisionOf(res: unknown): number | null {
  const value = (res as { value?: { revision?: unknown } } | null)?.value
  const revision = value?.revision
  return typeof revision === 'number' && Number.isInteger(revision) ? revision : null
}

/** Reject a write whose response envelope is missing or explicitly `ok:false`. */
function unwrapWrite(res: unknown, what: string): void {
  if (res && typeof res === 'object' && (res as { ok?: unknown }).ok === true) return
  const message = (res as { error?: { message?: string } } | null)?.error?.message
  throw new Error(message ?? `${what} failed`)
}

/**
 * One dropdown row: the hostname to proxy plus the providers that reach it
 * (two routes can share a host — the two DeepSeek adapters both land on
 * `api.deepseek.com` — hence a list).
 */
export interface HostSuggestion {
  /** Bare lowercase hostname to add to the list. */
  host: string
  /** Provider names behind this host, for the row's muted label. */
  providers: string[]
}

/** What the model catalog told us: routable routes and their display names. */
interface ProviderCatalog {
  routes: string[]
  names: Map<string, string>
}

/**
 * Collect the hosts offered by the two host fields: the providers that are
 * actually active, not the whole catalog. Two sources, both of which matter:
 *
 *  - the routes the host currently serves models for
 *    (`session.modelCatalog`'s `routableProviders`) — this is what puts a
 *    plugin-registered provider such as the Codex subscription
 *    (`openai-codex` → chatgpt.com) or the official DeepSeek adapters in the
 *    list, and it is also the only source that knows a provider exists;
 *  - the profiles configured in `llm-pi-ai.providers`, each resolved to its own
 *    `baseURL` for a custom gateway (azapi/zenmux/…) or to the catalog endpoint
 *    of that route otherwise (kimi-coding/…).
 *
 * Once a route is known, its host comes from `providerEndpointHost`. Saved
 * entries are always included so nothing on the page becomes unremovable.
 */
function suggestionsOf(fields: ProxyFields, piAiValue: unknown, catalog: ProviderCatalog): HostSuggestion[] {
  const byHost = new Map<string, Set<string>>()
  const providers = (piAiValue as { providers?: Record<string, { baseURL?: unknown; displayName?: unknown }> } | null)?.providers
  const profileOf = (route: string): { baseURL?: unknown; displayName?: unknown } | undefined =>
    providers && typeof providers === 'object' ? providers[route] : undefined
  const add = (route: string, label: string): void => {
    const host = providerEndpointHost(route, profileOf(route)?.baseURL)
    if (host === undefined) return
    const names = byHost.get(host) ?? new Set<string>()
    names.add(label)
    byHost.set(host, names)
  }
  for (const route of catalog.routes) {
    const configured = profileOf(route)?.displayName
    const label = typeof configured === 'string' && configured.length > 0
      ? configured
      : catalog.names.get(route) ?? route
    add(route, label)
  }
  if (providers && typeof providers === 'object') {
    for (const [route, profile] of Object.entries(providers)) {
      const host = providerEndpointHost(route, profile?.baseURL)
      if (host === undefined || byHost.has(host)) continue
      const configured = profile?.displayName
      byHost.set(host, new Set([typeof configured === 'string' && configured.length > 0 ? configured : route]))
    }
  }
  // Without the catalog (an older host, or the call failing) the official
  // adapter is still the one provider this deployment always has.
  if (catalog.routes.length === 0 && !byHost.has(DEFAULT_DEEPSEEK_HOST)) byHost.set(DEFAULT_DEEPSEEK_HOST, new Set(['DeepSeek']))
  // Already-saved entries stay listed (with no provider label) so they can be
  // seen and removed from the page that owns them.
  const addList = (list: unknown): void => {
    if (!Array.isArray(list)) return
    for (const host of list) {
      if (typeof host !== 'string') continue
      const normalized = normalizeHostEntry(host)
      if (normalized !== undefined && !byHost.has(normalized)) byHost.set(normalized, new Set())
    }
  }
  addList(fields.proxyHosts)
  addList(fields.excludeHosts)
  return [...byHost.entries()]
    .map(([host, names]) => ({ host, providers: [...names] }))
    .sort((left, right) => left.host.localeCompare(right.host))
}

/** The client-side `remote.session` face this page reads for routable routes. */
interface SessionRemoteLike {
  modelCatalog?: () => Promise<unknown>
}

/**
 * Ask the host which provider routes currently serve models, and what they are
 * called. This is the only way to see a provider another plugin registered (the
 * Codex subscription adds `openai-codex` straight to the pi-ai adapter, so it
 * never appears in the `llm-pi-ai` settings document).
 * @param ctx - the browser plugin context.
 * @returns the routable routes and their names; empty when the call fails.
 */
async function providerCatalogOf(ctx: ClientContext): Promise<ProviderCatalog> {
  const empty: ProviderCatalog = { routes: [], names: new Map() }
  const remote = serviceOf(ctx, 'remote.session') as SessionRemoteLike | undefined
  if (!remote || typeof remote.modelCatalog !== 'function') return empty
  try {
    const res = await remote.modelCatalog()
    const envelope = res as { ok?: unknown; value?: unknown } | null
    const value = envelope && envelope.ok === true ? envelope.value : envelope?.value ?? res
    const catalog = value as { routableProviders?: unknown; groups?: unknown } | null
    const routes = Array.isArray(catalog?.routableProviders)
      ? catalog.routableProviders.filter((route): route is string => typeof route === 'string')
      : []
    const names = new Map<string, string>()
    if (Array.isArray(catalog?.groups)) {
      for (const group of catalog.groups) {
        const row = group as { id?: unknown; name?: unknown } | null
        if (typeof row?.id === 'string' && typeof row.name === 'string' && row.name.length > 0) names.set(row.id, row.name)
      }
    }
    return { routes, names }
  } catch {
    // A failed catalog call degrades to the configured-provider list.
    return empty
  }
}

/** Coerce a namespace value into the page's fields, defaulting absent members. */
function fieldsOf(value: unknown): ProxyFields {
  const row = (value && typeof value === 'object' ? value : {}) as { proxy?: unknown; proxyHosts?: unknown; excludeHosts?: unknown }
  const listOf = (input: unknown): string[] => (Array.isArray(input) ? input.filter((item): item is string => typeof item === 'string') : [])
  return {
    proxy: typeof row.proxy === 'string' ? row.proxy : '',
    proxyHosts: listOf(row.proxyHosts),
    excludeHosts: listOf(row.excludeHosts),
  }
}

/**
 * Build the M-H-Proxy face over the resolved settings api.
 * @param ctx - the browser plugin context.
 * @returns the face the settings page consumes.
 */
export function createProxyFace(ctx: ClientContext): ProxyFace {
  // Revision read by the last successful describe, replayed on save as the
  // optimistic-concurrency check so a stale page cannot overwrite a newer one.
  let describedRevision: number | null = null
  return {
    async read(): Promise<ProxySnapshot | null> {
      const api = settingsApiOf(ctx)
      if (!api) return null
      const res = api.kind === 'remote'
        ? await api.settings.describe!()
        : await (api.settings as ConnectionSettingsLike).describe!({})
      const rows = settingsNamespacesOf(res)
      const own = rows.find(row => row?.ns === NS)
      if (!own) return null
      const revision = own.revision
      describedRevision = typeof revision === 'number' && Number.isInteger(revision) ? revision : null
      const fields = fieldsOf(own.value)
      const piAi = rows.find(row => row?.ns === PI_AI_NS)
      // The catalog call is independent of the settings read; both feed the
      // suggestion list, and a failure on either side degrades to the other.
      const catalog = await providerCatalogOf(ctx)
      return { ...fields, suggestions: suggestionsOf(fields, piAi?.value, catalog) }
    },
    async save(fields: ProxyFields): Promise<void> {
      const api = settingsApiOf(ctx)
      if (!api) throw new Error('settings service unavailable')
      if (api.kind === 'remote') {
        if (typeof api.settings.mutate !== 'function') throw new Error('settings.mutate unavailable')
        // Whole-path set ops: arrays replace wholesale (no index-wise merge);
        // the three ops land in one host-side write transaction. The third
        // argument is arity-required: pass undefined, not fewer arguments.
        const ops: MutateOp[] = [
          { op: 'set', path: ['proxy'], value: fields.proxy },
          { op: 'set', path: ['proxyHosts'], value: fields.proxyHosts },
          { op: 'set', path: ['excludeHosts'], value: fields.excludeHosts },
        ]
        const written = await api.settings.mutate(NS, ops, describedRevision ?? undefined)
        unwrapWrite(written, 'settings.mutate')
        // Adopt the revision this write produced: the host rejects a save whose
        // expectation is stale, so a page that saved once would otherwise fail
        // every later save with `settings/conflict`.
        describedRevision = revisionOf(written)
        return
      }
      // Legacy connection proxy: object-payload update, resolves void.
      if (typeof (api.settings as ConnectionSettingsLike).update !== 'function') throw new Error('settings.update unavailable')
      await (api.settings as ConnectionSettingsLike).update!({
        ns: NS,
        patch: { ...fields },
      })
    },
  }
}
