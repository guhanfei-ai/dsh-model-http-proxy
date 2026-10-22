/**
 * Client half of dsh-model-http-proxy: registers the `M-H-Proxy` page in the
 * DSH Settings left navigation (settings.section list slot — the same form
 * mindmap's 思维脑图 entry uses). The Host half (src/index.ts) owns the
 * `model-proxy` namespace; the page reads and writes it through the proxy
 * face (src/client/settings-io.ts), never the schema.
 *
 * UI history: v0.1 registered a `settings.plugins.tab` inside the 内置插件
 * section, then a settings.section page over the 0.1.7 `configForms` mirror
 * (which never reached ready on 0.2.x and left the page blank); the current
 * shape is the grafana/mindmap-proven `remote.settings` facade path.
 *
 * Only `slots` is injected: the settings facade is resolved with call-time
 * `ctx.get` inside the face, so a host without it degrades to a visible
 * “service unavailable” note instead of a fiber that pends forever.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis';
/** Required services (cordis fiber inject). */
export declare const inject: string[];
/**
 * Mount the M-H-Proxy settings page.
 * @param ctx - the browser plugin context.
 */
export declare function apply(ctx: ClientContext): void;
//# sourceMappingURL=index.d.ts.map