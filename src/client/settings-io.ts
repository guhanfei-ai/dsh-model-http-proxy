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
  BUILTIN_PROXY_HOSTS,
  addHostEntries,
  normalizeHostEntry,
  overlappingHosts,
  providerEndpointHost,
  rebaseProxyFields,
  visibleHostSuggestions,
} from '../hosts.js'

// The cross-field guards are shared with the Host half so the pure matching
// rules have one implementation and one test suite.
export { addHostEntries, overlappingHosts, rebaseProxyFields, visibleHostSuggestions }

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
  /** Proxy URL (http/https/socks5/socks5h); empty = inactive. */
  proxy: string
  /** Hostnames to proxy (empty = auto-detect every model host). */
  proxyHosts: string[]
  /** Hostnames never proxied. */
  excludeHosts: string[]
}

/** What `read()` hands the page: the live fields plus immediately available suggestions. */
export interface ProxySnapshot extends ProxyFields {
  /** Clearly labelled fallback suggestions until the catalog is checked. */
  suggestions: HostSuggestion[]
}

/** Registration-side face the section entry injects into the page. */
export interface ProxyFace {
  /** Read settings without waiting for a possibly hung modelCatalog call. */
  read(): Promise<ProxySnapshot | null>
  /** Enrich suggestions asynchronously; catalog failures time out to labelled fallbacks. */
  refreshSuggestions(fields: ProxyFields): Promise<HostSuggestion[]>
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
  const error = (res as { error?: { message?: string; code?: string } } | null)?.error
  throw Object.assign(new Error(error?.message ?? `${what} failed`), { code: error?.code })
}

/** A conflict is recoverable by rereading the latest revision, not blindly retrying. */
export function isSettingsConflict(err: unknown): boolean {
  const error = err as { code?: unknown; message?: unknown } | null
  return /settings\/conflict|\bconflict\b|revision|版本冲突|版本已变/i.test(
    `${typeof error?.code === 'string' ? error.code : ''} ${typeof error?.message === 'string' ? error.message : ''}`,
  )
}

/** Labels distinguish chat-routable hosts from clearly marked degraded data. */
export type SuggestionKind = 'routable' | 'configured' | 'saved' | 'fallback' | 'builtin'

/** One hostname may correspond to several currently routable model groups. */
export interface HostSuggestion {
  host: string
  providers: string[]
  /** Configured and builtin rows are *only* shown when the catalog is unavailable. */
  kind: SuggestionKind
}

interface ProviderCatalog {
  available: boolean
  routes: string[]
  names: Map<string, string>
}

const UNAVAILABLE_CATALOG: ProviderCatalog = { available: false, routes: [], names: new Map() }
const CATALOG_TIMEOUT_MS = 1500

/**
 * Catalog success means precisely the routes available in the chat model picker,
 * even if that list is empty. A configured pi-ai profile only supplies the
 * matching route's actual baseURL; it is NOT a separate candidate in this case.
 * When the catalog fails, configured endpoints and the builtin DeepSeek host
 * remain available, but are visibly marked as unverified fallback suggestions.
 */
function suggestionsOf(fields: ProxyFields, piAiValue: unknown, catalog: ProviderCatalog): HostSuggestion[] {
  const byHost = new Map<string, HostSuggestion>()
  const providers = (piAiValue as { providers?: Record<string, { baseURL?: unknown; displayName?: unknown }> } | null)?.providers
  const profileOf = (route: string): { baseURL?: unknown; displayName?: unknown } | undefined =>
    providers && typeof providers === 'object' ? providers[route] : undefined
  const addRoute = (route: string, kind: 'routable' | 'configured'): void => {
    const profile = profileOf(route)
    const host = providerEndpointHost(route, profile?.baseURL)
    if (host === undefined) return
    const configured = profile?.displayName
    const label = typeof configured === 'string' && configured.length > 0
      ? configured
      : catalog.names.get(route) ?? route
    const existing = byHost.get(host)
    if (existing) {
      if (!existing.providers.includes(label)) existing.providers.push(label)
    } else {
      byHost.set(host, { host, kind, providers: [label] })
    }
  }
  if (catalog.available) {
    for (const route of catalog.routes) addRoute(route, 'routable')
  } else {
    if (providers && typeof providers === 'object') {
      for (const route of Object.keys(providers)) addRoute(route, 'configured')
    }
    if (!byHost.has(DEFAULT_DEEPSEEK_HOST)) {
      byHost.set(DEFAULT_DEEPSEEK_HOST, { host: DEFAULT_DEEPSEEK_HOST, kind: 'fallback', providers: ['DeepSeek'] })
    }
  }
  // Author-supplied hosts are selectable even when they are not model API endpoints.
  // This is a candidate list only, never an implicit routing union.
  for (const host of BUILTIN_PROXY_HOSTS) {
    if (!byHost.has(host)) byHost.set(host, { host, kind: 'builtin', providers: ['作者内置'] })
  }
  // The settings snapshot, not the live chips, owns these suggestions. A saved
  // custom host must reappear after its chip is removed, even after catalog refresh.
  for (const entry of [...fields.proxyHosts, ...fields.excludeHosts]) {
    const host = normalizeHostEntry(entry)
    if (host !== undefined && !byHost.has(host)) byHost.set(host, { host, kind: 'saved', providers: [] })
  }
  return [...byHost.values()].sort((left, right) => left.host.localeCompare(right.host))
}

/** The client-side `remote.session` face this page reads for routable routes. */
interface SessionRemoteLike {
  modelCatalog?: () => Promise<unknown>
}

/** A malformed/failed catalog is NOT an authoritative empty routable list. */
async function providerCatalogOf(ctx: ClientContext): Promise<ProviderCatalog> {
  const remote = serviceOf(ctx, 'remote.session') as SessionRemoteLike | undefined
  if (!remote || typeof remote.modelCatalog !== 'function') return UNAVAILABLE_CATALOG
  try {
    const res = await remote.modelCatalog()
    const envelope = res as { ok?: unknown; value?: unknown } | null
    if (envelope?.ok === false) return UNAVAILABLE_CATALOG
    const value = envelope?.ok === true ? envelope.value : envelope?.value ?? res
    const catalog = value as { routableProviders?: unknown; groups?: unknown } | null
    if (!Array.isArray(catalog?.routableProviders)) return UNAVAILABLE_CATALOG
    const routes = catalog.routableProviders.filter((route): route is string => typeof route === 'string')
    const names = new Map<string, string>()
    if (Array.isArray(catalog.groups)) {
      for (const group of catalog.groups) {
        const row = group as { id?: unknown; name?: unknown } | null
        if (typeof row?.id === 'string' && typeof row.name === 'string' && row.name.length > 0) names.set(row.id, row.name)
      }
    }
    return { available: true, routes, names }
  } catch {
    return UNAVAILABLE_CATALOG
  }
}

/** Finite wait: a never-settling modelCatalog must never hold the page hostage. */
async function boundedProviderCatalogOf(ctx: ClientContext): Promise<ProviderCatalog> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      providerCatalogOf(ctx),
      new Promise<ProviderCatalog>(resolve => {
        timeout = setTimeout(() => { resolve(UNAVAILABLE_CATALOG) }, CATALOG_TIMEOUT_MS)
      }),
    ])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}

/** Coerce a namespace value into the page's fields, defaulting absent members. */
function fieldsOf(value: unknown): ProxyFields {
  const row = (value && typeof value === 'object' ? value : {}) as { proxy?: unknown; proxyHosts?: unknown; excludeHosts?: unknown }
  const listOf = (input: unknown): string[] => (Array.isArray(input) ? input.filter((item): item is string => typeof item === 'string') : [])
  return {
    proxy: typeof row.proxy === 'string' ? row.proxy : '',
    proxyHosts: row.proxyHosts === undefined ? [...BUILTIN_PROXY_HOSTS] : listOf(row.proxyHosts),
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
  let piAiValue: unknown
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
      piAiValue = rows.find(row => row?.ns === PI_AI_NS)?.value
      // Render the actual settings immediately. Fallback rows are labelled as
      // unverified until refreshSuggestions resolves the chat model catalog.
      return { ...fields, suggestions: suggestionsOf(fields, piAiValue, UNAVAILABLE_CATALOG) }
    },
    async refreshSuggestions(fields: ProxyFields): Promise<HostSuggestion[]> {
      const catalog = await boundedProviderCatalogOf(ctx)
      return suggestionsOf(fields, piAiValue, catalog)
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
