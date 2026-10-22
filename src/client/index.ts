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

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the settings provider's shared-forms Context merge (0.1.7
// provides ctx.configForms; the local 0.1.2 dev type tree predates it, so the
// consumer below reaches it through a narrow structural cast).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the ctx.slots Context merge (renderer-owned since 0.1.2).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { ConfigForm, ConfigForms } from './settings-forms-017.js'
import { ModelProxyPage } from './page.js'
import { HttpProxyCardController } from './card-controller.js'

/** Settings namespace the Host half owns; keep in sync with src/index.ts. */
const NS = 'model-proxy'

/** The `llm-pi-ai` namespace, read-only here, supplying gateway hostname suggestions. */
const PI_AI_NS = 'llm-pi-ai'

/** The `model-proxy` section fields this page edits (mirror of the Host Config). */
interface HttpProxySettings {
  /** Proxy URL (http/https/socks4/socks4a/socks5/socks5h); empty = inactive. */
  proxy?: string
  /** Hostnames to proxy (empty = auto-detect every model host). */
  proxyHosts?: string[]
  /** Hostnames never proxied. */
  excludeHosts?: string[]
}

/** The `llm-pi-ai` section subset this page reads for known model gateways. */
interface PiAiSettings {
  providers?: Record<string, { baseURL?: string }>
}

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'configForms']

/**
 * Mount the Model Http Proxy settings page.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  const forms = (ctx as unknown as { configForms: ConfigForms }).configForms
  const controller = new HttpProxyCardController(
    forms.get<HttpProxySettings>(NS),
    forms.get<PiAiSettings>(PI_AI_NS),
  )
  // Unsubscribe both forms when this fiber disposes (unload / HMR), so the
  // orphaned controller cannot keep publishing after the page is gone.
  ctx.effect(() => () => controller.dispose())
  ctx.slots.inject('settings.section', function* () {
    yield ctx.slots.register({
      name: 'settings.section',
      id: 'dsh-model-http-proxy',
      order: 100,
      label: 'Model Http Proxy',
      inject: () => controller.inject(),
    }, ModelProxyPage)
  })
}
