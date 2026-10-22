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
import type { Context as ClientContext } from '@deepseek-ai/cordis';
/** The `model-proxy` fields this page edits (mirror of the Host Config). */
export interface ProxyFields {
    /** Proxy URL (http/https/socks4/socks4a/socks5/socks5h); empty = inactive. */
    proxy: string;
    /** Hostnames to proxy (empty = auto-detect every model host). */
    proxyHosts: string[];
    /** Hostnames never proxied. */
    excludeHosts: string[];
}
/** What `read()` hands the page: the live fields plus the dropdown suggestions. */
export interface ProxySnapshot extends ProxyFields {
    /** Active providers' hosts for the two fields' dropdowns. */
    suggestions: HostSuggestion[];
}
/** Registration-side face the section entry injects into the page. */
export interface ProxyFace {
    /** Read the live `model-proxy` fields; null when the namespace is unreachable. */
    read(): Promise<ProxySnapshot | null>;
    /** Write all three fields in one mutate transaction; throws when the write fails. */
    save(fields: ProxyFields): Promise<void>;
}
/**
 * One dropdown row: the hostname to proxy plus the providers that reach it
 * (two routes can share a host — the two DeepSeek adapters both land on
 * `api.deepseek.com` — hence a list).
 */
export interface HostSuggestion {
    /** Bare lowercase hostname to add to the list. */
    host: string;
    /** Provider names behind this host, for the row's muted label. */
    providers: string[];
}
/**
 * Build the M-H-Proxy face over the resolved settings api.
 * @param ctx - the browser plugin context.
 * @returns the face the settings page consumes.
 */
export declare function createProxyFace(ctx: ClientContext): ProxyFace;
//# sourceMappingURL=settings-io.d.ts.map