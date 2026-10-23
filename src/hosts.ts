/**
 * Browser-safe hostname helpers shared by the Host half (routing) and the
 * browser card (suggestions). No node imports, so either bundle can inline
 * this module without dragging in `undici`.
 *
 * Everything here is about *domains*, not providers: the plugin decides per
 * request URL which hosts travel through the proxy. Two hosts that happen to
 * share a domain (a model API and a web search on `chatgpt.com`, say) are
 * therefore routed together — that is a property of domain routing, not a bug.
 * @module dsh-model-http-proxy/hosts
 */

/** The official DeepSeek adapter's default endpoint host. */
export const DEFAULT_DEEPSEEK_HOST = 'api.deepseek.com'

/**
 * The endpoint each pi-ai catalog route uses when its profile names no
 * `baseURL` of its own. Mirrors the routes of the installed pi-ai catalog;
 * routes whose endpoint is built per request (Bedrock, Azure, Vertex, the
 * Cloudflare gateways, opencode, typesafe) carry no entry here and are covered
 * by {@link DEFAULT_MODEL_HOST_SUFFIXES} instead.
 */
export const PROVIDER_ENDPOINTS: Readonly<Record<string, string>> = {
  'ant-ling': 'https://api.ant-ling.com/v1',
  anthropic: 'https://api.anthropic.com',
  baseten: 'https://inference.baseten.co/v1',
  cerebras: 'https://api.cerebras.ai/v1',
  deepseek: 'https://api.deepseek.com',
  // The two official DeepSeek adapters (API key and signed-in account) share
  // the official host; `agent-default-model` names the first as the default.
  'deepseek-official': 'https://api.deepseek.com',
  'deepseek-account': 'https://api.deepseek.com',
  fireworks: 'https://api.fireworks.ai/inference',
  'github-copilot': 'https://api.individual.githubcopilot.com',
  google: 'https://generativelanguage.googleapis.com/v1beta',
  groq: 'https://api.groq.com/openai/v1',
  huggingface: 'https://router.huggingface.co/v1',
  'kimi-coding': 'https://api.kimi.com/coding/v1',
  meta: 'https://api.meta.ai/v1',
  minimax: 'https://api.minimax.io/anthropic',
  'minimax-cn': 'https://api.minimaxi.com/anthropic',
  mistral: 'https://api.mistral.ai',
  moonshotai: 'https://api.moonshot.ai/v1',
  'moonshotai-cn': 'https://api.moonshot.cn/v1',
  nvidia: 'https://integrate.api.nvidia.com/v1',
  openai: 'https://api.openai.com/v1',
  'openai-codex': 'https://chatgpt.com/backend-api',
  openrouter: 'https://openrouter.ai/api/v1',
  'qwen-token-plan': 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
  'qwen-token-plan-cn': 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
  'qwen-token-plan-individual': 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
  together: 'https://api.together.ai/v1',
  'vercel-ai-gateway': 'https://ai-gateway.vercel.sh',
  xai: 'https://api.x.ai/v1',
  xiaomi: 'https://api.xiaomimimo.com/v1',
  'xiaomi-token-plan-ams': 'https://token-plan-ams.xiaomimimo.com/v1',
  'xiaomi-token-plan-cn': 'https://token-plan-cn.xiaomimimo.com/v1',
  'xiaomi-token-plan-sgp': 'https://token-plan-sgp.xiaomimimo.com/v1',
  zai: 'https://api.z.ai/api/coding/paas/v4',
  'zai-coding-cn': 'https://open.bigmodel.cn/api/coding/paas/v4',
}

/**
 * Catalog endpoints that are not the sole endpoint of one pi-ai route, plus
 * the hosts whose API shares a domain with non-model traffic.
 */
const EXTRA_MODEL_HOSTS: readonly string[] = [
  // `cloudflare` builds its URL per request, so it has no PROVIDER_ENDPOINTS row.
  'api.cloudflare.com',
  'gateway.ai.cloudflare.com',
  // The ChatGPT-subscription adapter refreshes its OAuth token and reads quota
  // on these two hosts. `chatgpt.com` is a PROVIDER_ENDPOINTS row, but the auth
  // host is not a model endpoint and used to be missing: with the OS-wide proxy
  // off, a token refresh went out direct and failed, which surfaced as
  // "ChatGPT subscription authorization failed" rather than as a routing gap.
  'auth.openai.com',
]

/**
 * Default model-API hostnames used to build auto mode. Derived from
 * {@link PROVIDER_ENDPOINTS} rather than maintained as a second hand-written
 * list, so adding a provider endpoint can no longer leave auto mode behind —
 * the drift that made the `meta` endpoint suggest a host auto mode never
 * proxied.
 */
export const DEFAULT_MODEL_HOSTS: readonly string[] = [...new Set([
  ...Object.values(PROVIDER_ENDPOINTS).map(endpoint => hostnameOf(endpoint)),
  ...EXTRA_MODEL_HOSTS,
])].sort()

/**
 * Templated endpoints, written as glob entries. `*` matches any run of
 * characters except a dot, so:
 *
 * - `*-aiplatform.googleapis.com` covers `us-central1-aiplatform.googleapis.com`
 *   and its siblings (Vertex builds the label into the hostname);
 * - `*.openai.azure.com` covers `{resource}.openai.azure.com`.
 *
 * A leading-dot entry would NOT cover the Vertex shape: those hosts are not
 * subdomains of `aiplatform.googleapis.com`.
 */
export const DEFAULT_MODEL_HOST_SUFFIXES: readonly string[] = [
  '*.aiplatform.googleapis.com',
  '*.openai.azure.com',
]

/** Author-supplied defaults, seeded only when proxyHosts is absent, never merged on read. */
export const BUILTIN_PROXY_HOSTS: readonly string[] = ['auth.openai.com']

/** Exact domains match only themselves; only *.domain opts into suffix matching. */
export function hostMatches(hostname: string, entry: string): boolean {
  const host = canonicalHost(hostname)
  const normalized = normalizeHostEntry(entry)
  if (normalized === undefined) return false
  if (normalized.startsWith('*.')) {
    const domain = normalized.slice(2)
    return host === domain || host.endsWith(`.${domain}`)
  }
  return host === normalized
}

/** Whether any entry in a set matches the hostname. */
export function matchesAny(hostname: string, entries: ReadonlySet<string>): boolean {
  for (const entry of entries) {
    if (hostMatches(hostname, entry)) return true
  }
  return false
}

/**
 * Whether a request to `hostname` should travel through the proxy.
 *
 * Exclusions win unconditionally: a host matched by both lists stays direct.
 * That precedence is applied here rather than by removing the host from the
 * include set, because an include suffix can still cover an exact exclusion
 * (`*.example.com` includes vs `api.example.com` excludes).
 * @param hostname - the request hostname.
 * @param includes - normalized hosts to proxy.
 * @param excludes - normalized hosts that must stay direct.
 * @returns whether to route through the proxy.
 */
export function isRoutedHost(
  hostname: string,
  includes: ReadonlySet<string>,
  excludes: ReadonlySet<string>,
): boolean {
  if (matchesAny(hostname, excludes)) return false
  return matchesAny(hostname, includes)
}

/**
 * Resolve one configured pi-ai provider profile to the host its requests land
 * on: the profile's own `baseURL` when it sets one (custom gateways such as
 * `azapi` do), else the catalog endpoint of that route, else nothing.
 * @param route - the provider key in the `llm-pi-ai` settings document.
 * @param baseURL - that profile's `baseURL`, if it sets one.
 * @returns the bare lowercase hostname, or undefined when it cannot be known.
 */
export function providerEndpointHost(route: string, baseURL?: unknown): string | undefined {
  if (typeof baseURL === 'string' && baseURL.length > 0) {
    try {
      return hostnameOf(baseURL)
    } catch {
      // A malformed baseURL drops out of the suggestions; the Host half is
      // where such a configuration error actually surfaces.
      return undefined
    }
  }
  const endpoint = PROVIDER_ENDPOINTS[route]
  if (endpoint === undefined) return undefined
  try {
    return hostnameOf(endpoint)
  } catch {
    return undefined
  }
}

/**
 * Extract the hostname from an absolute URL string or `URL`, in the canonical
 * form routing compares against: lowercase, punycode for IDNs, and no trailing
 * root dot.
 * @param value - the URL to read.
 * @returns the canonical hostname.
 */
export function hostnameOf(value: string | URL): string {
  const host = value instanceof URL ? value.hostname : new URL(value).hostname
  return canonicalHost(host)
}

/** Lowercase, punycode, and strip the trailing root dot (`api.example.com.`). */
function canonicalHost(raw: string): string {
  const lowered = raw.toLowerCase()
  // A trailing dot is the DNS root: `api.example.com.` is the same host, but
  // `new URL` keeps the dot, so an un-normalized entry would never match.
  const withoutRoot = lowered.endsWith('.') && lowered.length > 1 ? lowered.slice(0, -1) : lowered
  if (withoutRoot.includes('*')) return withoutRoot
  try {
    // Round-tripping through URL applies IDNA (例子.测试 → xn--…), lowercases,
    // and rejects hosts that are not valid hostnames at all.
    return new URL(`http://${withoutRoot}`).hostname
  } catch {
    return withoutRoot
  }
}

/**
 * Canonicalize a rule while retaining its explicit *. prefix. Legacy .domain
 * and other wildcard spellings are rejected, not silently expanded. URL/port
 * inputs remain exact-host conveniences; they cannot contain a wildcard.
 */
export function normalizeHostEntry(entry: string): string | undefined {
  const text = entry.trim()
  if (!text || /\s/u.test(text) || text.startsWith('.')) return undefined
  const suffix = text.startsWith('*.')
  let raw = suffix ? text.slice(2) : text
  if (!raw || raw.includes('*') || raw.startsWith('.') || raw.includes('..')) return undefined
  if (suffix && /[/:?#@\\]/u.test(raw)) return undefined
  try {
    let url: URL
    if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(raw)) {
      url = new URL(raw)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    } else {
      if (raw.includes('@') || /[/?#\\]/u.test(raw)) return undefined
      if (!raw.startsWith('[') && (raw.match(/:/gu)?.length ?? 0) > 1) raw = `[${raw}]`
      url = new URL(`http://${raw}`)
    }
    const host = canonicalHost(url.hostname)
    if (!host || host.startsWith('.') || host.includes('..') || host.includes('*')) return undefined
    if (suffix && (host.startsWith('[') || /^\d+(?:\.\d+){3}$/u.test(host))) return undefined
    if (!host.startsWith('[') && !host.split('.').every(label => /^[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?$/u.test(label))) return undefined
    return suffix ? `*.${host}` : host
  } catch {
    return undefined
  }
}

/** The three editable fields, structurally (client and Host halves share it). */
export interface HostLists {
  proxy: string
  proxyHosts: string[]
  excludeHosts: string[]
}

/** A hostname plus the labels that explain where it came from. */
export interface HostChoiceLike {
  host: string
  providers: string[]
}

/**
 * Commit free-typed entries into one list, refusing anything the opposite list
 * already owns. The same hostname cannot be both proxied and excluded, and a
 * silently dropped keystroke is worse than a refusal the page can explain.
 * @param selected - the list being edited.
 * @param opposite - the other list; its hosts are refused.
 * @param text - one or more entries typed by the user.
 * @returns the new list plus the entries refused as conflicts.
 */
export function addHostEntries(
  selected: readonly string[],
  opposite: readonly string[],
  text: string,
): { hosts: string[]; conflicts: string[] } {
  const blocked = new Set(opposite.map(host => normalizeHostEntry(host)).filter((host): host is string => host !== undefined))
  const hosts = [...selected]
  const conflicts: string[] = []
  for (const part of text.split(/[,，\s]+/).map(item => item.trim()).filter(item => item.length > 0)) {
    const normalized = normalizeHostEntry(part)
    if (normalized === undefined) continue
    if (blocked.has(normalized)) {
      if (!conflicts.includes(part)) conflicts.push(part)
      continue
    }
    if (!hosts.some(existing => normalizeHostEntry(existing) === normalized)) hosts.push(part)
  }
  return { hosts, conflicts }
}

/**
 * Suggestions still worth offering: not already committed on either side, and
 * matching the typed query by host or by provider label.
 * @param suggestions - the candidate hosts.
 * @param selected - the list being edited.
 * @param opposite - the other list.
 * @param query - what the user has typed so far.
 * @returns the filtered candidates, in their original order.
 */
export function visibleHostSuggestions<T extends HostChoiceLike>(
  suggestions: readonly T[],
  selected: readonly string[],
  opposite: readonly string[],
  query: string,
): T[] {
  const taken = new Set([...selected, ...opposite]
    .map(host => normalizeHostEntry(host))
    .filter((host): host is string => host !== undefined))
  const needle = query.trim().toLowerCase()
  return suggestions.filter(option => !taken.has(option.host) && (
    needle.length === 0
    || option.host.includes(needle)
    || option.providers.some(name => name.toLowerCase().includes(needle))
  ))
}

/** Hosts present on both lists — the state the page refuses to save. */
export function overlappingHosts(fields: HostLists): string[] {
  const proxied = new Set(fields.proxyHosts
    .map(host => normalizeHostEntry(host))
    .filter((host): host is string => host !== undefined))
  return [...new Set(fields.excludeHosts
    .map(host => normalizeHostEntry(host))
    .filter((host): host is string => host !== undefined))]
    .filter(host => proxied.has(host))
}

/**
 * Merge a local draft onto a freshly read document after a revision conflict.
 *
 * Fields the user did not touch take the latest value. Fields only the user
 * changed keep the draft. Fields both sides changed are reported as conflicts
 * and left holding the draft, so nothing is written until the page asks.
 * @param base - the document the draft was based on.
 * @param draft - the user's edits.
 * @param latest - the document just read from the host.
 * @returns the rebased fields plus the field names that genuinely conflict.
 */
export function rebaseProxyFields(
  base: HostLists,
  draft: HostLists,
  latest: HostLists,
): { fields: HostLists; conflicts: (keyof HostLists)[] } {
  const same = (key: keyof HostLists, left: HostLists, right: HostLists): boolean =>
    key === 'proxy' ? left.proxy === right.proxy : sameHostLists(left[key], right[key])
  const fields: HostLists = {
    proxy: latest.proxy,
    proxyHosts: [...latest.proxyHosts],
    excludeHosts: [...latest.excludeHosts],
  }
  const conflicts: (keyof HostLists)[] = []
  for (const key of ['proxy', 'proxyHosts', 'excludeHosts'] as const) {
    if (same(key, draft, base)) continue
    if (!same(key, latest, base) && !same(key, latest, draft)) conflicts.push(key)
    if (key === 'proxy') fields.proxy = draft.proxy
    else fields[key] = [...draft[key]]
  }
  return { fields, conflicts }
}

/** Order-free list compare: reordering chips is not an edit. */
function sameHostLists(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every(host => right.includes(host))
}
