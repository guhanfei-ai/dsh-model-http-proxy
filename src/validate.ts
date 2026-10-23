/**
 * Configuration validation shared by the Host half (which must refuse to build
 * a broken transport) and the browser card (which must refuse to *save* one).
 * No node imports and no schema dependency, so both bundles can inline it.
 * @module dsh-model-http-proxy/validate
 */

import { normalizeHostEntry } from './hosts.js'

/**
 * Proxy URL schemes this plugin can actually serve.
 *
 * `socks4`/`socks4a` are deliberately absent: `undici` has no SOCKS4
 * implementation, so advertising them meant a settings save that passed
 * validation and then silently disabled routing. `socks5h` is served by the
 * same SOCKS5 transport as `socks5`, and both resolve the target name at the
 * proxy.
 */
export const SUPPORTED_PROXY_SCHEMES: readonly string[] = ['http', 'https', 'socks5', 'socks5h', 'socks']

/** Schemes users may have saved or read about but that this build refuses. */
const KNOWN_UNSUPPORTED_SCHEMES: readonly string[] = ['socks4', 'socks4a']

/** The editable configuration, structurally. */
export interface ProxyConfigLike {
  proxy: string
  proxyHosts: string[]
  excludeHosts: string[]
}

/**
 * A proxy URL safe to put in a log line or an error message: scheme, host,
 * port, and path survive, userinfo does not.
 * @param raw - the configured proxy URL, valid or not.
 * @returns the URL with any userinfo replaced by `***`.
 */
export function redactProxyUrl(raw: string): string {
  if (raw.length === 0) return ''
  try {
    const url = new URL(raw)
    if (url.username.length === 0 && url.password.length === 0) return url.href
    url.username = '***'
    url.password = ''
    return url.href
  } catch {
    // Unparseable: strip anything that looks like userinfo before the host.
    return raw.replace(/\/\/[^/@]*@/u, '//***@')
  }
}

/**
 * Reasons a configuration cannot be served, in the order a user reads the form.
 * @param config - the section to check.
 * @returns one human-readable message, or null when the configuration is usable.
 */
export function configProblem(config: ProxyConfigLike): string | null {
  if (config.proxy.length > 0) {
    let parsed: URL
    try {
      parsed = new URL(config.proxy)
    } catch {
      return `代理地址无效："${redactProxyUrl(config.proxy)}"`
    }
    const scheme = parsed.protocol.replace(/:$/, '')
    if (KNOWN_UNSUPPORTED_SCHEMES.includes(scheme)) {
      return `代理协议 "${scheme}:" 不受支持；可用：${SUPPORTED_PROXY_SCHEMES.join(' / ')}`
    }
    if (!SUPPORTED_PROXY_SCHEMES.includes(scheme)) {
      return `代理协议 "${parsed.protocol}" 不受支持；可用：${SUPPORTED_PROXY_SCHEMES.join(' / ')}`
    }
    if (parsed.hostname.length === 0) return `代理地址 "${redactProxyUrl(config.proxy)}" 缺少主机名`
  }
  // A malformed host entry used to be dropped silently, which quietly turned a
  // narrow "only proxy these" configuration into something else entirely.
  for (const [label, list] of [
    ['代理域名', config.proxyHosts],
    ['直连域名', config.excludeHosts],
  ] as const) {
    for (const entry of list) {
      if (normalizeHostEntry(entry) === undefined) {
        return `${label}里的 "${entry}" 无效：精确匹配用 example.com，后缀匹配必须写 *.example.com；不接受 .example.com 或其它通配格式`
      }
    }
  }
  return null
}

/**
 * Refuse a configuration this plugin cannot serve.
 * @param config - the section to check.
 * @throws Error naming the offending scheme or entry, never its credentials.
 */
export function assertValid(config: ProxyConfigLike): void {
  const problem = configProblem(config)
  if (problem !== null) throw new Error(`model-proxy: ${problem}`)
}
