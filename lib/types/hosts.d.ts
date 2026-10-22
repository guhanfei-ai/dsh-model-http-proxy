/**
 * Browser-safe hostname helpers shared by the Host half (routing) and the
 * browser card (suggestions). No node imports, so either bundle can inline
 * this module without dragging in `undici`.
 * @module dsh-model-http-proxy/hosts
 */
/** The official DeepSeek adapter's default endpoint host. */
export declare const DEFAULT_DEEPSEEK_HOST = "api.deepseek.com";
/**
 * Default model-API hostnames pi-ai's built-in providers use, so auto mode
 * proxies a catalog route (e.g. `google`) even when its profile names no
 * `baseURL`. Exact hostname matches; see {@link DEFAULT_MODEL_HOST_SUFFIXES}
 * for region- or resource-templated endpoints. This mirrors the endpoints the
 * installed pi-ai catalog ships (`builtinProviders()`); a pi-ai release that
 * adds a provider with a new default endpoint needs its host added here.
 */
export declare const DEFAULT_MODEL_HOSTS: readonly string[];
/**
 * Default suffixes for templated pi-ai endpoints: `google-vertex` resolves its
 * catalog baseURL from `https://{location}-aiplatform.googleapis.com` (the
 * actual request lands on `us-central1-aiplatform.googleapis.com` and
 * siblings), and `azure-openai-responses` builds
 * `https://{resource}.openai.azure.com`. A suffix entry matches the bare
 * domain, its subdomains, and its hyphen-joined region hosts.
 */
export declare const DEFAULT_MODEL_HOST_SUFFIXES: readonly string[];
/**
 * The endpoint each pi-ai catalog route uses when its profile names no
 * `baseURL` of its own. Mirrors `builtinProviders()` of the installed catalog
 * (pi-ai 1.3.0); routes whose endpoint is built per request (Bedrock, Azure,
 * Vertex, the Cloudflare gateways, opencode, typesafe) carry no entry and
 * resolve to nothing here — a configured profile of that kind simply does not
 * contribute a suggestion.
 *
 * The settings page reads this to show the hosts of the providers that are
 * actually configured: a catalog route such as `kimi-coding` names no
 * `baseURL`, so without this table its endpoint would be unknowable in the
 * browser (the catalog itself is a Host-only dependency).
 */
export declare const PROVIDER_ENDPOINTS: Readonly<Record<string, string>>;
/**
 * Resolve one configured pi-ai provider profile to the host its requests land
 * on: the profile's own `baseURL` when it sets one (custom gateways such as
 * `azapi` do), else the catalog endpoint of that route, else nothing.
 * @param route - the provider key in the `llm-pi-ai` settings document.
 * @param baseURL - that profile's `baseURL`, if it sets one.
 * @returns the bare lowercase hostname, or undefined when it cannot be known.
 */
export declare function providerEndpointHost(route: string, baseURL?: unknown): string | undefined;
/**
 * Extract the hostname from an absolute URL string or `URL`.
 * @param value - the URL to read.
 * @returns the lowercase hostname.
 */
export declare function hostnameOf(value: string | URL): string;
/**
 * Normalize a user-entered host entry to the form `shouldProxy` matches
 * against (`new URL(url).hostname`). Accepts a plain hostname, `host:port`,
 * a bracketed or bare IPv6 literal, an absolute URL (scheme, port, and path
 * are all stripped), or a suffix entry (`*.example.com` or `.example.com`,
 * both kept as `.example.com`). Returns undefined when nothing usable
 * remains.
 * @param entry - a raw `proxyHosts` / `excludeHosts` entry.
 * @returns the normalized entry, or undefined for an empty/invalid entry.
 */
export declare function normalizeHostEntry(entry: string): string | undefined;
//# sourceMappingURL=hosts.d.ts.map