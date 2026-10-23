/**
 * Proxy transport and host-routing helpers for `dsh-model-http-proxy`.
 *
 * The plugin does not touch DeepSeek Harness source. It wraps
 * `globalThis.fetch` and attaches a *routing dispatcher*: every request the
 * platform fetch hands to the dispatcher is matched by its own origin, so a
 * redirect is judged hop by hop instead of inheriting the first URL's decision.
 * Non-routed hosts are dispatched to the process's global dispatcher — exactly
 * what a fetch without a dispatcher option would use.
 *
 * The wrapper keeps the platform `fetch`, so returned values are the platform
 * `Response` and a caller's native `Request` is accepted as-is. (undici's own
 * `fetch` recognizes only its own `Request` class and rejects a platform one.)
 * @module dsh-model-http-proxy/proxy
 */

import { Dispatcher, ProxyAgent, Socks5ProxyAgent, getGlobalDispatcher } from 'undici'
import { isRoutedHost } from './hosts.js'
import { routingFieldsOf, selectProxy } from './routes.js'
import type { RoutingFields } from './routes.js'
import { assertValid } from './validate.js'

export {
  DEFAULT_DEEPSEEK_HOST,
  DEFAULT_MODEL_HOST_SUFFIXES,
  DEFAULT_MODEL_HOSTS,
  addHostEntries,
  hostMatches,
  hostnameOf,
  isRoutedHost,
  matchesAny,
  normalizeHostEntry,
  overlappingHosts,
  rebaseProxyFields,
  visibleHostSuggestions,
} from './hosts.js'
export type { HostChoiceLike, HostLists } from './hosts.js'

/** The two host lists that decide routing. Mutated in place on settings change. */
export interface HostRules {
  /** Normalized hosts to route through the proxy. */
  includes: Set<string>
  /** Normalized hosts that must stay direct; these always win. */
  excludes: Set<string>
}

/** Create an empty rule set. */
export function emptyRules(): HostRules {
  return { includes: new Set<string>(), excludes: new Set<string>() }
}

/** Extract the absolute URL string from a `fetch` input. */
export function urlOf(input: string | URL | Request): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}

/**
 * Whether a URL's hostname is routed through the proxy.
 * @param url - the request URL.
 * @param includes - normalized hosts to proxy.
 * @param excludes - normalized hosts that must stay direct.
 * @returns whether to route through the proxy; malformed URLs stay direct.
 */
export function shouldProxy(
  url: string,
  includes: ReadonlySet<string>,
  excludes: ReadonlySet<string> = new Set<string>(),
): boolean {
  try {
    return isRoutedHost(new URL(url).hostname, includes, excludes)
  } catch {
    return false
  }
}

/**
 * Every redirect is a fresh dispatch and therefore a fresh routing decision.
 * Undefined means the exact process global dispatcher, never a direct Agent.
 * Selection/dispatch failures propagate; a chosen proxy is never retried direct.
 */
class RoutingDispatcher extends Dispatcher {
  #select: (hostname: string) => Dispatcher | undefined
  #transports: Dispatcher[]

  constructor(select: (hostname: string) => Dispatcher | undefined, transports: Dispatcher[]) {
    super()
    this.#select = select
    this.#transports = transports
  }

  override dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
    let hostname: string | undefined
    try {
      if (options.origin !== undefined) hostname = new URL(String(options.origin)).hostname
    } catch { /* an unreadable origin has no matching host rule */ }
    const selected = hostname === undefined ? undefined : this.#select(hostname)
    return (selected ?? getGlobalDispatcher()).dispatch(options, handler)
  }

  /** Close only owned transports, gracefully; the process dispatcher is shared. */
  override async close(): Promise<void> {
    await Promise.all(this.#transports.map(transport => transport.close()))
  }
}

/** Split proxy credentials out of a URL so the plain endpoint stays credential-free. */
function endpointOf(url: URL): { endpoint: string; token: string | undefined } {
  const credentials = url.username.length > 0 || url.password.length > 0
  // `URL` keeps userinfo percent-encoded; proxy servers expect the decoded form.
  const token = credentials
    ? `Basic ${Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString('base64')}`
    : undefined
  const endpoint = new URL(url.href)
  endpoint.username = ''
  endpoint.password = ''
  return { endpoint: endpoint.href, token }
}

/**
 * Build the transport for one proxy URL.
 *
 * `http`/`https` use undici's `ProxyAgent` with `proxyTunnel: false`, so a plain
 * `http:` target is forwarded in absolute form and only `https:` targets
 * CONNECT — the behaviour ordinary HTTP proxies expect. SOCKS schemes use
 * `Socks5ProxyAgent` with explicitly decoded credentials; it has no SOCKS4
 * support, which is why validation refuses `socks4:`/`socks4a:`.
 * @param proxyUrl - a validated proxy URL.
 * @returns the dispatcher carrying every request for routed hosts.
 */
export function createProxyDispatcher(proxyUrl: string): Dispatcher {
  const url = new URL(proxyUrl)
  const scheme = url.protocol.replace(/:$/, '')
  if (scheme === 'socks5' || scheme === 'socks5h' || scheme === 'socks') {
    const username = url.username.length > 0 ? decodeURIComponent(url.username) : undefined
    const password = url.password.length > 0 ? decodeURIComponent(url.password) : undefined
    // undici resolves SOCKS names at the proxy already, but its constructor
    // accepts only socks5:/socks:, not the equivalent socks5h: spelling.
    url.protocol = 'socks5:'
    return new Socks5ProxyAgent(endpointOf(url).endpoint, {
      ...(username === undefined ? {} : { username }),
      ...(password === undefined ? {} : { password }),
    })
  }
  const { endpoint, token } = endpointOf(url)
  return new ProxyAgent({
    uri: endpoint,
    proxyTunnel: false,
    ...(token === undefined ? {} : { token }),
  })
}

/** A platform-shaped fetch plus the proxy transport behind it. */
export interface ProxyFetch {
  /** Fetch that routes every request per host through the routing dispatcher. */
  fetch: typeof fetch
  /** Close the proxy transport; the global dispatcher is left alone. */
  close(): Promise<void>
}

/**
 * Create a fetch that routes `rules` through the proxy and everything else
 * through the process global dispatcher.
 *
 * The returned fetch delegates to `baseFetch` (the platform fetch captured
 * before this plugin wrapped it): that keeps the platform `Request`/`Response`
 * classes, streaming bodies, and `duplex` handling intact while still letting
 * the dispatcher choose the transport per hop.
 * @param baseFetch - the fetch this wrapper sits on top of.
 * @param proxyUrl - a validated proxy URL.
 * @param rules - the live host rules; mutate in place to change routing.
 * @returns the routing fetch and its transport closer.
 */
export function createProxyFetch(baseFetch: typeof fetch, proxyUrl: string, rules: HostRules): ProxyFetch {
  const proxy = createProxyDispatcher(proxyUrl)
  return fetchWithRouting(baseFetch, new RoutingDispatcher(
    hostname => isRoutedHost(hostname, rules.includes, rules.excludes) ? proxy : undefined,
    [proxy],
  ))
}

/**
 * Build a complete immutable routing generation before the caller publishes it.
 * If any transport cannot be constructed, close everything already constructed
 * and throw; the caller can keep the previous generation without a routing gap.
 */
export function createMultiProxyFetch(baseFetch: typeof fetch, fields: RoutingFields): ProxyFetch {
  assertValid(fields)
  const snapshot = routingFieldsOf(fields)
  const transports = new Map<string, Dispatcher>()
  try {
    for (const proxy of snapshot.proxies) {
      if (proxy.enabled) transports.set(proxy.id, createProxyDispatcher(proxy.proxy))
    }
  } catch (cause) {
    for (const transport of transports.values()) void transport.close().catch(() => { /* not published */ })
    throw cause
  }
  return fetchWithRouting(baseFetch, new RoutingDispatcher(hostname => {
    const proxy = selectProxy(hostname, snapshot)
    if (proxy === undefined) return undefined
    const transport = transports.get(proxy.id)
    // An invariant failure must not turn a required proxy into default routing.
    if (transport === undefined) throw new Error('model-proxy: selected proxy transport is unavailable')
    return transport
  }, [...transports.values()]))
}

/**
 * Keep a retiring generation alive until all fetches reach their final headers:
 * closing a transport after an intermediate redirect response would otherwise
 * reject the next hop. After headers, undici.close() drains streaming bodies.
 * The lifecycle's stable wrapper always sends later calls to its new generation.
 */
function fetchWithRouting(baseFetch: typeof fetch, routing: RoutingDispatcher): ProxyFetch {
  let pending = 0
  let retiring = false
  let draining = false
  let closePromise: Promise<void> | undefined
  let resolveClose: (() => void) | undefined
  let rejectClose: ((cause: unknown) => void) | undefined
  const drain = (): void => {
    if (!retiring || pending > 0 || draining) return
    draining = true
    void routing.close().then(resolveClose, rejectClose)
  }
  const release = (): void => { pending -= 1; drain() }
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
    // A caller that supplies a dispatcher chose its transport explicitly.
    if ((init as { dispatcher?: unknown } | undefined)?.dispatcher !== undefined) return baseFetch(input, init)
    if (retiring) return Promise.reject(new Error('model-proxy: routing transport is closed'))
    pending += 1
    try {
      return baseFetch(input, {
        ...init,
        // The platform fetch accepts undici's dispatcher even though the DOM
        // RequestInit type does not declare it. Keep the boundary cast here.
        dispatcher: routing,
      } as RequestInit).finally(release)
    } catch (cause) {
      release()
      throw cause
    }
  }) as typeof fetch
  return {
    fetch: fetchImpl,
    close: () => {
      if (closePromise === undefined) {
        retiring = true
        closePromise = new Promise<void>((resolve, reject) => { resolveClose = resolve; rejectClose = reject })
        drain()
      }
      return closePromise
    },
  }
}
