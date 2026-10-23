/**
 * Configuration schema and validation for `dsh-model-http-proxy`.
 * @module dsh-model-http-proxy/config
 */

import z from '@deepseek-ai/schemastery'
import { BUILTIN_PROXY_HOSTS } from './hosts.js'
import type { ProxyConfigLike } from './validate.js'

export { assertValid, configProblem, redactProxyUrl, SUPPORTED_PROXY_SCHEMES } from './validate.js'
export type { ProxyConfigLike } from './validate.js'

/** Configuration for the `dsh-model-http-proxy` plugin. */
export interface Config extends ProxyConfigLike {
  /**
   * Proxy URL. Empty means the plugin is inactive and no request is routed.
   * Supported schemes: `http:`, `https:`, `socks5:`, `socks5h:`, `socks:`.
   */
  proxy: string
  /**
   * Explicit proxy rules. Empty means no proxy rules. Author defaults apply
   * only when the field is absent, never after deleting or saving an empty list.
   */
  proxyHosts: string[]
  /** Hostnames that must never be routed, even when auto-detected or listed. */
  excludeHosts: string[]
}

/**
 * A live config reference the loader keeps updating in place after volatile
 * writes (0.1.7), or the plain resolved value on hosts without that feature.
 */
type VolatileLike<T> = { get(): T }

/** Whether a value is a live volatile reference rather than plain data. */
function isVolatileLike(value: unknown): value is VolatileLike<unknown> {
  return value !== null && typeof value === 'object' && typeof (value as VolatileLike<unknown>).get === 'function'
}

/** Resolve a field that may be a plain value or a live volatile reference. */
export function resolveVolatile<T>(value: T | VolatileLike<T>): T {
  return (isVolatileLike(value) ? value.get() : value) as T
}

/**
 * Runtime schema for {@link Config}. The annotation stays loose: `.volatile()`
 * (0.1.7 live-config references) widens the field types past what `z<Config>`
 * accepts under `exactOptionalPropertyTypes`, while `assertValid` and the
 * apply() consumer both operate on resolved plain values.
 */
export const Config = z.object({
  proxy: z.string().default('').volatile(),
  proxyHosts: z.array(z.string()).default([...BUILTIN_PROXY_HOSTS]).volatile(),
  excludeHosts: z.array(z.string()).default([]).volatile(),
})
