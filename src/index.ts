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
import { assertValid, Config, redactProxyUrl } from './config.js'
import type { Config as PluginConfig } from './config.js'
import { BUILTIN_PROXY_HOSTS } from './hosts.js'
import {
  DEFAULT_DEEPSEEK_HOST,
  DEFAULT_MODEL_HOST_SUFFIXES,
  DEFAULT_MODEL_HOSTS,
  emptyRules,
  hostnameOf,
  normalizeHostEntry,
} from './proxy.js'
import type { HostRules, ProxyFetch } from './proxy.js'
import { createProxyFetch } from './proxy.js'

export { Config, assertValid, configProblem, SUPPORTED_PROXY_SCHEMES, redactProxyUrl } from './config.js'
export type { Config as PluginConfig } from './config.js'
export { BUILTIN_PROXY_HOSTS } from './hosts.js'
export {
  DEFAULT_DEEPSEEK_HOST,
  DEFAULT_MODEL_HOST_SUFFIXES,
  DEFAULT_MODEL_HOSTS,
  addHostEntries,
  createProxyDispatcher,
  createProxyFetch,
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
function liveConfigOf(ctx: Context): PluginConfig | undefined {
  let row: SettingsRow | undefined
  try {
    const settings = ctx.get('settings') as SettingsLike | undefined
    row = settings?.describe?.().find(entry => entry.ns === name)
  } catch {
    return undefined
  }
  const value = row?.value
  if (value === null || typeof value !== 'object') return undefined
  const section = value as { proxy?: unknown; proxyHosts?: unknown; excludeHosts?: unknown }
  const listOf = (input: unknown): string[] =>
    Array.isArray(input) ? input.filter((item): item is string => typeof item === 'string') : []
  return {
    proxy: typeof section.proxy === 'string' ? section.proxy : '',
    proxyHosts: section.proxyHosts === undefined ? [...BUILTIN_PROXY_HOSTS] : listOf(section.proxyHosts),
    excludeHosts: listOf(section.excludeHosts),
  }
}

/** Add one raw entry to a rule set, ignoring entries routing cannot use. */
function addEntries(target: Set<string>, entries: readonly string[]): void {
  for (const entry of entries) {
    const normalized = normalizeHostEntry(entry)
    if (normalized !== undefined) target.add(normalized)
  }
}

/** Explicit saved rules only. Empty is empty; no implicit catalog or builtin union. */
export function collectRules(_ctx: Context, config: PluginConfig): HostRules {
  const rules = emptyRules()
  addEntries(rules.includes, config.proxyHosts)
  addEntries(rules.excludes, config.excludeHosts)
  return rules
}

/** Replace a rule set's contents in place, keeping its identity for the dispatcher. */
function applyRules(target: HostRules, next: HostRules): void {
  target.includes.clear()
  for (const host of next.includes) target.includes.add(host)
  target.excludes.clear()
  for (const host of next.excludes) target.excludes.add(host)
}

/**
 * Install the routing wrapper. The plugin reads its config per refresh, so a
 * settings change reaches the next request without a restart; an empty `proxy`
 * deactivates routing and restores the platform fetch when this plugin still
 * owns it.
 *
 * Recovery is deliberate: an invalid configuration leaves the last working
 * routing in place and logs the reason (with credentials redacted) instead of
 * silently falling back to direct connections. A deployment that never had a
 * valid configuration simply keeps the platform fetch untouched.
 * @param ctx - the Cordis context this plugin mounts into.
 * @param config - composition entry config; the `base` layer under user settings.
 */
export function apply(ctx: Context, config: PluginConfig): void {
  const baseFetch = globalThis.fetch
  // One rule object for the dispatcher's lifetime; settings changes rewrite it.
  const rules = emptyRules()
  let runtime: ProxyFetch | undefined
  let activeUrl = ''
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
    activeUrl = ''
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
    // The settings document is authoritative once the service is present: it
    // carries the value a save just wrote, whichever way the loader delivers it.
    const cfg = liveConfigOf(ctx) ?? config
    // Settings `proxy` wins; the `DSH_HTTP_PROXY` environment variable is the
    // no-file fallback so a deployment can set the proxy without editing settings.
    const proxyUrl = cfg.proxy.length > 0 ? cfg.proxy : (process.env.DSH_HTTP_PROXY ?? '')
    if (proxyUrl.length === 0) {
      deactivate()
      return
    }
    try {
      assertValid({ proxy: proxyUrl, proxyHosts: cfg.proxyHosts, excludeHosts: cfg.excludeHosts })
    } catch (cause) {
      // Keep the last working routing: a typo in an unrelated field must not
      // silently disable a proxy the user depends on.
      logger().warn(
        'model-proxy: configuration rejected (%s); keeping the previous routing',
        cause instanceof Error ? cause.message : String(cause),
      )
      return
    }
    const nextRules = collectRules(ctx, cfg)
    if (runtime !== undefined && activeUrl === proxyUrl) {
      applyRules(rules, nextRules)
      // Same proxy, new host rules: the dispatcher reads the rule set live.
      install()
      return
    }
    let next: ProxyFetch
    try {
      next = createProxyFetch(baseFetch, proxyUrl, rules)
    } catch (cause) {
      logger().warn(
        'model-proxy: cannot create a dispatcher for "%s" (%s); keeping the previous routing',
        redactProxyUrl(proxyUrl),
        cause instanceof Error ? cause.message : String(cause),
      )
      return
    }
    applyRules(rules, nextRules)
    const previous = runtime
    runtime = next
    activeUrl = proxyUrl
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
