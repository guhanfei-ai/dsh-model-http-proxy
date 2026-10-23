/**
 * `dsh-model-http-proxy`: route selected request domains through an HTTP/SOCKS
 * proxy without modifying DeepSeek Harness source.
 *
 * The unit of routing is the **domain**, not the provider or the model: the
 * settings page lists the hosts the chat model picker currently reaches, and
 * each listed host is proxied or not. Two requests that share a host (a model
 * API and a web search on `chatgpt.com`, for example) therefore always share a
 * decision. Only `fetch` traffic is covered — a WebSocket transport is not.
 *
 * @module dsh-model-http-proxy
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls in the `Context.settings` augmentation without importing a
// value, so the module's named exports are not part of this module's link step.
import type {} from '@deepseek-ai/dsh-settings'
import { assertValid, resolveVolatile } from './config.js'
import type { Config as PluginConfig } from './config.js'
import { emptyRules, normalizeHostEntry, createMultiProxyFetch } from './proxy.js'
import type { HostRules, ProxyFetch } from './proxy.js'
import { routingFieldsOf } from './routes.js'
import type { RoutingFields } from './routes.js'

export { Config, assertValid, configProblem, SUPPORTED_PROXY_SCHEMES, redactProxyUrl } from './config.js'
export type { Config as PluginConfig } from './config.js'
export { BUILTIN_DIRECT_HOSTS, BUILTIN_PROXY_GROUPS, BUILTIN_PROXY_HOSTS, builtinHostProvider } from './hosts.js'
export {
  DEFAULT_DEEPSEEK_HOST,
  DEFAULT_MODEL_HOST_SUFFIXES,
  DEFAULT_MODEL_HOSTS,
  addHostEntries,
  createProxyDispatcher,
  createProxyFetch,
  createMultiProxyFetch,
  emptyRules,
  hostMatches,
  hostnameOf,
  isRoutedHost,
  matchesAny,
  normalizeHostEntry,
  overlappingHosts,
  rebaseProxyFields,
  shouldProxy,
  urlOf,
  visibleHostSuggestions,
} from './proxy.js'
export type { HostChoiceLike, HostLists, HostRules, ProxyFetch } from './proxy.js'
export { routingFieldsOf, proxyConflicts, selectProxy } from './routes.js'
export type { ProxyEntry, RoutingFields, ProxyConflict } from './routes.js'

/** Plugin short name (also its settings namespace). */
export const name = 'model-proxy'

/** The `llm-pi-ai` settings namespace, read-only here. */
const PI_AI_NS = 'llm-pi-ai'

/** A settings service, read optionally at request time (0.1.7 SettingsForms). */
interface SettingsLike {
  describe?: () => Array<{ ns: string; value?: unknown }>
}

/** A settings-service describe row (the host shape; `value` is the live config). */
interface SettingsRow {
  ns: string
  value?: unknown
}

/** A logger that accepts printf-style arguments, as cordis' does. */
interface LoggerLike {
  warn(message: string, ...args: unknown[]): void
}

/**
 * Read this plugin's own `model-proxy` section from the settings service.
 *
 * The fiber config handed to `apply` is the mount-time snapshot: a settings
 * save either restarts the entry (fresh config) or patches the running one in
 * place, and only the settings service knows which value is current. Reading it
 * per refresh makes routing follow a save even on hosts that patch in place,
 * which is what the page promises ("保存后下一次请求即生效").
 * @param ctx - the Cordis context, for the optional settings service.
 * @returns the live section values, or undefined when the service has no row.
 */
function liveConfigOf(ctx: Context): { value: unknown } | undefined {
  let row: SettingsRow | undefined
  try {
    const settings = ctx.get('settings') as SettingsLike | undefined
    row = settings?.describe?.().find(entry => entry.ns === name)
  } catch {
    return undefined
  }
  if (row?.value === undefined) return undefined
  // Keep even an invalid raw section intact. Treating null/string as absence
  // would revive the mount-time snapshot instead of retaining the last state.
  return { value: row.value }
}

/** Resolve live top-level schema fields without defaulting away invalid data. */
function resolvedConfigOf(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value
  const section = { ...value } as Record<string, unknown>
  for (const key of ['proxies', 'proxy', 'proxyHosts', 'excludeHosts']) {
    if (key in section) section[key] = resolveVolatile(section[key])
  }
  return section
}

/** Add one raw entry to a rule set, ignoring entries routing cannot use. */
function addEntries(target: Set<string>, entries: readonly string[]): void {
  for (const entry of entries) {
    const normalized = normalizeHostEntry(entry)
    if (normalized !== undefined) target.add(normalized)
  }
}

/** Explicit saved rules only. Empty is empty; no implicit catalog or builtin union. */
export function collectRules(_ctx: Context, config: PluginConfig | RoutingFields): HostRules {
  const resolved = resolvedConfigOf(config) as PluginConfig | RoutingFields
  const fields = routingFieldsOf(resolved)
  const rules = emptyRules()
  const legacy = resolved.proxies === undefined
  for (const proxy of fields.proxies) {
    if (legacy || proxy.enabled) addEntries(rules.includes, proxy.proxyHosts)
  }
  addEntries(rules.excludes, fields.excludeHosts)
  return rules
}

/**
 * Install the routing wrapper. Each refresh builds a complete next generation
 * before publishing it. With no enabled cards, restore the captured fetch only
 * when this plugin still owns it. Retained outer wrappers continue to work.
 *
 * Recovery is deliberate: an invalid configuration leaves the last working
 * routing in place and logs the reason (with credentials redacted) instead of
 * silently falling back to direct connections. A deployment that never had a
 * valid configuration simply keeps the platform fetch untouched.
 * @param ctx - the Cordis context this plugin mounts into.
 * @param config - composition entry config; the `base` layer under user settings.
 */
export function apply(ctx: Context, config: PluginConfig | RoutingFields): void {
  const baseFetch = globalThis.fetch
  let runtime: ProxyFetch | undefined
  let activeKey = ''
  let disposed = false

  /** Pass through when inactive or disposed, so no request lands on a closed dispatcher. */
  const wrapper = ((input: RequestInfo | URL, init?: RequestInit) => {
    const active = runtime
    return active === undefined ? baseFetch(input, init) : active.fetch(input, init)
  }) as typeof fetch

  /** Install only over the fetch this wrapper was built on; never clobber a later wrapper. */
  const install = (): void => {
    if (globalThis.fetch === baseFetch) globalThis.fetch = wrapper
  }

  /** Restore the platform fetch only when this plugin is still the installed one. */
  const uninstall = (): void => {
    if (globalThis.fetch === wrapper) globalThis.fetch = baseFetch
  }

  const deactivate = (): void => {
    const previous = runtime
    runtime = undefined
    activeKey = ''
    uninstall()
    if (previous !== undefined) void previous.close().catch(() => { /* a closed transport is the goal */ })
  }

  // A host without a logger still has to report a broken configuration; fall
  // back to the console rather than throwing while handling a failure.
  const logger = (): LoggerLike => {
    const candidate = (ctx as unknown as { logger?: LoggerLike }).logger
    if (candidate !== undefined && typeof candidate.warn === 'function') return candidate
    return { warn: (message, ...rest) => { console.warn(message, ...rest) } }
  }

  const refresh = (): void => {
    if (disposed) return
    // Preserve proxies and malformed data all the way to validation. The env
    // fallback is evaluated only by legacy migration, never for a new list.
    let fields: RoutingFields
    try {
      const live = liveConfigOf(ctx)
      const cfg = resolvedConfigOf(live === undefined ? config : live.value)
      fields = routingFieldsOf(cfg, process.env.DSH_HTTP_PROXY ?? '')
      assertValid(fields)
    } catch (cause) {
      logger().warn(
        'model-proxy: configuration rejected (%s); keeping the previous routing',
        cause instanceof Error ? cause.message : 'invalid configuration',
      )
      return
    }
    if (!fields.proxies.some(proxy => proxy.enabled)) {
      deactivate()
      return
    }
    const key = JSON.stringify(fields)
    if (runtime !== undefined && activeKey === key) {
      install()
      return
    }
    let next: ProxyFetch
    try {
      next = createMultiProxyFetch(baseFetch, fields)
    } catch {
      // Transport constructors can echo their complete input in an exception.
      // Do not forward arbitrary exception text containing proxy credentials.
      logger().warn('model-proxy: cannot create proxy dispatchers; keeping the previous routing')
      return
    }
    const previous = runtime
    runtime = next
    activeKey = key
    // Publish before closing the old transport, so requests started after this
    // point always land on a live dispatcher.
    install()
    if (previous !== undefined) void previous.close().catch(() => { /* replaced by a newer transport */ })
  }

  refresh()
  ctx.effect(() => () => {
    disposed = true
    deactivate()
  })

  // The proxied host set depends on the `llm-pi-ai` gateways, which this
  // plugin does not own. Recompute on any committed settings change so a new
  // or renamed gateway is proxied without a restart (no-op when nothing moved).
  // 0.1.7 renamed the broadcast to `settings/document-updated` (payload: the
  // entry id whose section moved); `settings/updated` no longer fires there.
  ctx.on('settings/document-updated', (ns: unknown) => {
    const id = String(ns)
    // Our own section decides the proxy URL and both host lists; `llm-pi-ai`
    // decides the auto-detected gateways the host set is built from.
    if (id === name || id === PI_AI_NS) refresh()
  })

  // 0.1.7 discovery: the loader reads the plugin's flat `Config` export as the
  // entry schema, and `SettingsForms` (describe/update/replace/mutate) serves
  // reads and writes — the imperative `installSection` registration this used
  // to perform was removed upstream, so nothing is registered here. Volatile
  // fields (see config.ts) make in-place config updates reach `refresh()`'s
  // next read without remounting this fiber.
}
