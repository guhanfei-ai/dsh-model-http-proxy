/**
 * The M-H-Proxy settings page (settings.section left-nav entry): the three
 * form fields rendered expanded — no collapsible card chrome, the nav itself
 * is the entry point. The page owns its local state (mindmap's SettingsPanel
 * shape): read once on mount through the proxy face, stage drafts, write only
 * on save.
 */

import { useEffect, useState } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { HostSuggestion, ProxyFace, ProxyFields } from './settings-io.js'
import { normalizeHostEntry } from '../hosts.js'
import { ValueField, HostField } from './fields.js'
import css from './card.module.css'

/** Props the renderer binds for the M-H-Proxy page. */
export type ModelProxyPageProps =
  PropsRuntime<'settings.section'>
  & { proxyFace?: ProxyFace }

/** What the user is editing: the proxy URL plus the two committed host lists. */
interface HostDraft {
  proxy: string
  proxyHosts: string[]
  excludeHosts: string[]
}

/** The normalized form of a list, for cross-field "already used there" checks. */
function hostSetOf(list: string[]): Set<string> {
  const set = new Set<string>()
  for (const host of list) {
    const normalized = normalizeHostEntry(host)
    if (normalized !== undefined) set.add(normalized)
  }
  return set
}

/** Order-free compare of two host lists (same hosts, any order). */
function sameHosts(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false
  const seen = new Set(left)
  return right.every(host => seen.has(host))
}

/**
 * Render the M-H-Proxy settings page.
 * @param props - the proxy face this page reads and writes through.
 * @returns the page, a loading note, or the read error — never a silent blank.
 */
export function ModelProxyPage(props: ModelProxyPageProps) {
  const face = props.proxyFace
  const [loaded, setLoaded] = useState<ProxyFields | null>(null)
  const [draft, setDraft] = useState<HostDraft | null>(null)
  const [suggestions, setSuggestions] = useState<HostSuggestion[]>([])
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let alive = true
    if (!face) return
    face.read().then(snapshot => {
      if (!alive) return
      if (!snapshot) {
        setError('设置服务不可用：settings namespace 未注册或宿主连接缺失')
        return
      }
      setLoaded({ proxy: snapshot.proxy, proxyHosts: snapshot.proxyHosts, excludeHosts: snapshot.excludeHosts })
      setDraft({ proxy: snapshot.proxy, proxyHosts: snapshot.proxyHosts, excludeHosts: snapshot.excludeHosts })
      setSuggestions(snapshot.suggestions)
    }).catch(err => {
      if (alive) setError(String((err as Error)?.message ?? err))
    })
    return () => { alive = false }
  }, [face])

  if (!face) {
    return <p className={css.pageIntro}>M-H-Proxy 面板未注入。</p>
  }
  if (draft === null || loaded === null) {
    return <p className={css.pageIntro}>{error || '正在读取设置…'}</p>
  }

  // A host belongs to exactly one side: it never shows up in the other field's
  // dropdown, so the same hostname can't be both proxied and excluded.
  const proxyTaken = hostSetOf(draft.excludeHosts)
  const excludeTaken = hostSetOf(draft.proxyHosts)
  const proxySuggestions = suggestions.filter(option => !proxyTaken.has(option.host))
  const excludeSuggestions = suggestions.filter(option => !excludeTaken.has(option.host))

  const dirty = draft.proxy !== loaded.proxy
    || !sameHosts(draft.proxyHosts, loaded.proxyHosts)
    || !sameHosts(draft.excludeHosts, loaded.excludeHosts)

  async function save(): Promise<void> {
    if (!face || !draft) return
    setSaving(true)
    setError('')
    setNotice('')
    try {
      const fields: ProxyFields = {
        proxy: draft.proxy.trim(),
        proxyHosts: draft.proxyHosts,
        excludeHosts: draft.excludeHosts,
      }
      await face.save(fields)
      setLoaded(fields)
      setDraft({ proxy: fields.proxy, proxyHosts: fields.proxyHosts, excludeHosts: fields.excludeHosts })
      setNotice('已保存 ✓')
    } catch (err) {
      setError(String((err as Error)?.message ?? err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className={css.page}>
      <p className={css.pageIntro}>给模型 API 请求配置正向代理；web 搜索等其它请求仍直连。留空代理地址则插件不生效，设置保存后下一次请求即生效。</p>
      <ValueField
        id="model-proxy-url"
        label="代理地址"
        hint="支持 http / https / socks4 / socks4a / socks5 / socks5h；留空则插件不生效。"
        placeholder="socks5://127.0.0.1:7890"
        value={draft.proxy}
        disabled={saving}
        onEdit={(text: string) => { setDraft({ ...draft, proxy: text }) }}
      />
      <HostField
        id="model-proxy-hosts"
        label="只代理这些域名"
        hint="留空 = 自动代理所有模型域名；填写 = 只代理下面的这些域名。回车或逗号确认输入，点标签右上角的 × 移除；下拉里只列出激活的提供方，已经在「排除域名」里的不会再出现，也支持直接输入域名 / 域名:端口 / URL / .域名后缀。"
        placeholder="输入域名后回车，或从下拉选择"
        value={draft.proxyHosts}
        suggestions={proxySuggestions}
        disabled={saving}
        onChange={(next: string[]) => { setDraft({ ...draft, proxyHosts: next }) }}
      />
      <HostField
        id="model-proxy-exclude"
        label="排除域名"
        hint="永远不走代理，优先级最高。回车或逗号确认输入，点标签右上角的 × 移除；已经在「只代理这些域名」里的不会再出现，同样支持直接输入域名 / 域名:端口 / URL / .域名后缀。"
        placeholder="api.deepseek.com"
        value={draft.excludeHosts}
        suggestions={excludeSuggestions}
        disabled={saving}
        onChange={(next: string[]) => { setDraft({ ...draft, excludeHosts: next }) }}
      />
      <div className={css.footer}>
        {error
          ? <p className={`${css.status} ${css.statusFailed}`} role="status">{error}</p>
          : notice
            ? <p className={css.status} role="status">{notice}</p>
            : null}
        <button
          type="button"
          className={css.save}
          disabled={!dirty || saving}
          onClick={() => { void save() }}
        >
          {saving ? '保存中…' : '保存'}
        </button>
      </div>
    </div>
  )
}
