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
import { hostnameOf, isRoutedHost } from './hosts.js'

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
 * A dispatcher that picks a transport per request origin: the proxy dispatcher
 * for routed hosts, the process global dispatcher for everything else.
 *
 * undici's fetch calls `dispatch` once per hop, passing that hop's `origin`, so
 * redirects are re-evaluated instead of keeping the first hop's decision. This
 * is why the plugin does not choose a fetch implementation per call.
 */
class RoutingDispatcher extends Dispatcher {
  #proxy: Dispatcher
  #rules: HostRules

  constructor(proxy: Dispatcher, rules: HostRules) {
    super()
    this.#proxy = proxy
    this.#rules = rules
  }

  override dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
    return (this.#routes(options.origin) ? this.#proxy : getGlobalDispatcher()).dispatch(options, handler)
  }

  /** Whether one hop's origin belongs to the proxy; unreadable origins stay direct. */
  #routes(origin: string | URL | undefined): boolean {
    if (origin === undefined) return false
    try {
      return isRoutedHost(new URL(String(origin)).hostname, this.#rules.includes, this.#rules.excludes)
    } catch {
      return false
    }
  }

  /**
   * Close only the proxy transport. The global dispatcher is shared with the
   * rest of the process and must survive this plugin's teardown.
   */
  override close(): Promise<void> {
    return this.#proxy.close()
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
  const routing = new RoutingDispatcher(createProxyDispatcher(proxyUrl), rules)
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
    // A caller that supplies its own dispatcher (another plugin's tunnel, a test
    // double) has chosen its transport explicitly; honour it instead of
    // silently replacing it with this router.
    if ((init as { dispatcher?: unknown } | undefined)?.dispatcher !== undefined) return baseFetch(input, init)
    return baseFetch(input, {
      ...init,
      // undici reads this from the init object; the DOM `RequestInit` type has
      // no such member, so the boundary cast is the only place it appears.
      dispatcher: routing,
    } as RequestInit)
  }) as typeof fetch
  return {
    fetch: fetchImpl,
    close: () => routing.close(),
  }
}
