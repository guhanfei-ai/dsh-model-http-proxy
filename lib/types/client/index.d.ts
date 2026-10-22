/**
 * Client half of dsh-model-http-proxy: registers the `Model Http Proxy` page
 * in the DSH Settings left navigation (settings.section list slot — the same
 * form mindmap's 思维脑图 entry uses). The Host half (src/index.ts) owns the
 * `model-proxy` namespace; the page pairs the two without learning what the
 * namespace means.
 *
 * UI history: v0.1 registered a `settings.plugins.tab` inside the 内置插件
 * section; per author preference the entry now lives as a first-class left-nav
 * page via `settings.section` (kind list / scope root, options id/order/label).
 *
 * 0.1.7 migration note: the `settingsScope` service was removed upstream; this
 * module reads/writes through the settings provider's shared `configForms`
 * service (one ConfigForm<T> per namespace) instead.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis';
/** Required services (cordis fiber inject). */
export declare const inject: string[];
/**
 * Mount the Model Http Proxy settings page.
 * @param ctx - the browser plugin context.
 */
export declare function apply(ctx: ClientContext): void;
//# sourceMappingURL=index.d.ts.map