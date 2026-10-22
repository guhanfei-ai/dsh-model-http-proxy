/**
 * The M-H-Proxy settings page (settings.section left-nav entry): the three
 * form fields rendered expanded — no collapsible card chrome, the nav itself
 * is the entry point. The page owns its local state (mindmap's SettingsPanel
 * shape): read once on mount through the proxy face, stage drafts, write only
 * on save.
 */
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { ProxyFace } from './settings-io.js';
/** Props the renderer binds for the M-H-Proxy page. */
export type ModelProxyPageProps = PropsRuntime<'settings.section'> & {
    proxyFace?: ProxyFace;
};
/**
 * Render the M-H-Proxy settings page.
 * @param props - the proxy face this page reads and writes through.
 * @returns the page, a loading note, or the read error — never a silent blank.
 */
export declare function ModelProxyPage(props: ModelProxyPageProps): import("react").JSX.Element;
//# sourceMappingURL=page.d.ts.map