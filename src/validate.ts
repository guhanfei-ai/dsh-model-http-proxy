/**
 * Configuration validation shared by the Host half (which must refuse to build
 * a broken transport) and the browser card (which must refuse to *save* one).
 * No node imports and no schema dependency, so both bundles can inline it.
 * @module dsh-model-http-proxy/validate
 */

import { normalizeHostEntry } from './hosts.js'
import { proxyConflicts, routingFieldsOf } from './routes.js'

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

/** Validate an address without ever echoing its userinfo. Empty is checked by the caller. */
function proxyProblem(proxy: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(proxy)
  } catch {
    return `代理地址无效："${redactProxyUrl(proxy)}"`
  }
  const scheme = parsed.protocol.replace(/:$/, '')
  if (KNOWN_UNSUPPORTED_SCHEMES.includes(scheme)) {
    return `代理协议 "${scheme}:" 不受支持；可用：${SUPPORTED_PROXY_SCHEMES.join(' / ')}`
  }
  if (!SUPPORTED_PROXY_SCHEMES.includes(scheme)) {
    return `代理协议 "${parsed.protocol}" 不受支持；可用：${SUPPORTED_PROXY_SCHEMES.join(' / ')}`
  }
  if (parsed.hostname.length === 0) return `代理地址 "${redactProxyUrl(proxy)}" 缺少主机名`
  try {
    // URL accepts invalid percent escapes, but transport credentials must be
    // decoded before authentication. Reject those edits before saving them.
    decodeURIComponent(parsed.username)
    decodeURIComponent(parsed.password)
  } catch {
    return '代理地址的认证信息编码无效；请检查百分号转义'
  }
  return null
}

/** Explain an invalid rule rather than silently dropping it during routing. */
function hostsProblem(label: string, list: readonly string[]): string | null {
  for (const entry of list) {
    if (normalizeHostEntry(entry) === undefined) {
      return `${label}里的 "${redactProxyUrl(entry)}" 无效：精确匹配用 example.com，后缀匹配必须写 *.example.com；不接受 .example.com 或其它通配格式`
    }
  }
  return null
}

/**
 * Check both legacy single-proxy sections and new authoritative RoutingFields.
 * Structural failures are reported, never sanitized into a different route.
 * Disabled cards retain their draft address (including a blank address), but
 * all cards' rules still have to be valid before a configuration can be saved.
 */
export function configProblem(config: unknown): string | null {
  let fields
  try {
    fields = routingFieldsOf(config)
  } catch (cause) {
    return cause instanceof Error ? cause.message : '代理配置格式无效'
  }
  const ids = new Set<string>()
  for (const [index, proxy] of fields.proxies.entries()) {
    const label = `代理${index + 1}`
    if (proxy.id.trim().length === 0) return `${label}的 id 不能为空`
    if (ids.has(proxy.id)) return `${label}的 id 重复；每张代理卡片必须使用唯一 id`
    ids.add(proxy.id)
    if (proxy.name.trim().length === 0) return `${label}的名称不能为空`
    if (proxy.enabled) {
      if (proxy.proxy.length === 0) return `${label}已启用，代理地址不能为空`
      const problem = proxyProblem(proxy.proxy)
      if (problem !== null) return `${label}：${problem}`
    }
    const problem = hostsProblem(`${label}的代理域名`, proxy.proxyHosts)
    if (problem !== null) return problem
  }
  const problem = hostsProblem('直连域名', fields.excludeHosts)
  if (problem !== null) return problem
  const conflicts = proxyConflicts(fields)
  if (conflicts.length > 0) {
    const conflict = conflicts[0]!
    return `代理域名 "${conflict.host}" 冲突：${conflict.proxyNames.join('、')} 中的启用代理不能配置相同规则`
  }
  return null
}

/**
 * Refuse a configuration this plugin cannot serve.
 * @param config - the section to check.
 * @throws Error naming the offending scheme or entry, never its credentials.
 */
export function assertValid(config: unknown): void {
  const problem = configProblem(config)
  if (problem !== null) throw new Error(`model-proxy: ${problem}`)
}
