/**
 * The Model Http Proxy settings page (settings.section left-nav entry): the
 * three form fields rendered expanded — no collapsible card chrome, the nav
 * itself is the entry point. Fields stage drafts and write only on save
 * through the `model-proxy` config form.
 */
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { HttpProxyCardFace } from './card-controller.js';
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots';
/** Props the renderer binds for the Model Http Proxy page. */
export type ModelProxyPageProps = PropsRuntime<'settings.section'> & InjectFace<HttpProxyCardFace>;
/**
 * Render the Model Http Proxy settings page.
 * @param props - the form snapshot and its actions.
 * @returns the page, or nothing while the namespace is unavailable.
 */
export declare function ModelProxyPage(props: ModelProxyPageProps): import("react").JSX.Element | null;
//# sourceMappingURL=page.d.ts.map