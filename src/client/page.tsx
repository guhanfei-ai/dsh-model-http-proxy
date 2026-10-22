/**
 * The Model Http Proxy settings page (settings.section left-nav entry): the
 * three form fields rendered expanded — no collapsible card chrome, the nav
 * itself is the entry point. Fields stage drafts and write only on save
 * through the `model-proxy` config form.
 */

import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { HttpProxyCardFace, HttpProxyCardState } from './card-controller.js'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import { ValueField, HostField } from './fields.js'
import css from './card.module.css'

/** Props the renderer binds for the Model Http Proxy page. */
export type ModelProxyPageProps =
  PropsRuntime<'settings.section'>
  & InjectFace<HttpProxyCardFace>

/**
 * Render the Model Http Proxy settings page.
 * @param props - the form snapshot and its actions.
 * @returns the page, or nothing while the namespace is unavailable.
 */
export function ModelProxyPage(props: ModelProxyPageProps) {
  const state = props.useModelProxyCard((snapshot: HttpProxyCardState) => snapshot)
  if (!state.available) return null
  const disabled = !state.writable
  return (
    <div className={css.page}>
      <p className={css.pageIntro}>给模型 API 请求配置正向代理；web 搜索等其它请求仍直连。留空代理地址则插件不生效，设置保存后下一次请求即生效。</p>
      {!state.writable ? <p className={css.readOnly} role="status">本部署的设置为只读。</p> : null}
      <ValueField
        id="model-proxy-url"
        label="代理地址"
        hint="支持 http / https / socks4 / socks4a / socks5 / socks5h；留空则插件不生效。"
        placeholder="socks5://127.0.0.1:7890"
        value={state.proxy}
        disabled={disabled}
        onEdit={(text: string) => { props.edit('proxy', text) }}
      />
      <HostField
        id="model-proxy-hosts"
        label="只代理这些域名"
        hint="留空 = 自动代理所有模型域名；填写 = 只代理列出的这些域名（逗号分隔，支持域名 / 域名:端口 / URL / .域名后缀，如 .aiplatform.googleapis.com，可从下拉选择）。"
        placeholder="gateway.acme.example"
        value={state.proxyHosts}
        suggestions={state.suggestions}
        disabled={disabled}
        onEdit={(text: string) => { props.edit('proxyHosts', text) }}
      />
      <HostField
        id="model-proxy-exclude"
        label="排除域名"
        hint="永远不走代理，优先级最高（逗号分隔，支持域名 / 域名:端口 / URL / .域名后缀，可从下拉选择）。"
        placeholder="api.deepseek.com"
        value={state.excludeHosts}
        suggestions={state.suggestions}
        disabled={disabled}
        onEdit={(text: string) => { props.edit('excludeHosts', text) }}
      />
      <div className={css.footer}>
        {state.failed
          ? <p className={`${css.status} ${css.statusFailed}`} role="status">保存失败，请重试</p>
          : state.saved
            ? <p className={`${css.status} ${css.statusSaved}`} role="status">已保存 ✓</p>
            : state.saving
              ? <p className={css.status} role="status">正在写入…</p>
              : null}
        <button
          type="button"
          className={css.save}
          disabled={!state.dirty || disabled || state.saving}
          onClick={props.save}
        >
          {state.saving ? '保存中…' : '保存'}
        </button>
      </div>
    </div>
  )
}
