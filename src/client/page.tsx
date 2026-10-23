/**
 * The M-H-Proxy settings section: read the settings document first, then
 * enrich hostname suggestions separately from the chat model catalog.
 */

import { useEffect, useRef, useState } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { HostSuggestion, ProxyFace, ProxyFields } from './settings-io.js'
import { isSettingsConflict, rebaseProxyFields } from './settings-io.js'
import { normalizeHostEntry } from '../hosts.js'
import { configProblem } from '../validate.js'
import { ValueField, HostField } from './fields.js'
import css from './card.module.css'

export type ModelProxyPageProps = PropsRuntime<'settings.section'> & { proxyFace?: ProxyFace }

/** A saved custom hostname remains a candidate after its chip is removed. */
function keepSavedSuggestions(suggestions: HostSuggestion[], saved: Set<string>): HostSuggestion[] {
  const byHost = new Map(suggestions.map(option => [option.host, option]))
  for (const host of saved) {
    if (!byHost.has(host)) byHost.set(host, { host, providers: [], kind: 'saved' })
  }
  return [...byHost.values()].sort((a, b) => a.host.localeCompare(b.host))
}

function rememberSaved(fields: ProxyFields, saved: Set<string>): void {
  for (const entry of [...fields.proxyHosts, ...fields.excludeHosts]) {
    const host = normalizeHostEntry(entry)
    if (host !== undefined) saved.add(host)
  }
}

function fieldsOf(snapshot: ProxyFields): ProxyFields {
  return { proxy: snapshot.proxy, proxyHosts: [...snapshot.proxyHosts], excludeHosts: [...snapshot.excludeHosts] }
}

/** Keep a draft across revision conflicts; never silently replace remote edits. */
export function ModelProxyPage(props: ModelProxyPageProps) {
  const face = props.proxyFace
  const [loaded, setLoaded] = useState<ProxyFields | null>(null)
  const [draft, setDraft] = useState<ProxyFields | null>(null)
  const [suggestions, setSuggestions] = useState<HostSuggestion[]>([])
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [saving, setSaving] = useState(false)
  const [reloading, setReloading] = useState(false)
  const [needsReload, setNeedsReload] = useState(false)
  const [conflictingFields, setConflictingFields] = useState<(keyof ProxyFields)[]>([])
  const [readAttempt, setReadAttempt] = useState(0)
  const [directEditing, setDirectEditing] = useState(false)
  const [proxyEditing, setProxyEditing] = useState(false)
  const [editorEpoch, setEditorEpoch] = useState(0)
  const editingHost = directEditing || proxyEditing
  const savedHosts = useRef(new Set<string>())
  const catalogRequest = useRef(0)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; catalogRequest.current++ }
  }, [])

  function enrich(snapshot: ProxyFields): void {
    if (!face) return
    const request = ++catalogRequest.current
    void face.refreshSuggestions(snapshot).then(rows => {
      if (mounted.current && catalogRequest.current === request) {
        setSuggestions(keepSavedSuggestions(rows, savedHosts.current))
      }
    }).catch(() => {
      // read() already rendered the explicitly labelled fallback candidates.
    })
  }

  useEffect(() => {
    let alive = true
    // Remount rule fields when their settings source changes; stale inline
    // input must never overwrite a freshly loaded or rebased array.
    setEditorEpoch(epoch => epoch + 1)
    setDirectEditing(false)
    setProxyEditing(false)
    if (!face) return
    setError('')
    void face.read().then(snapshot => {
      if (!alive) return
      if (!snapshot) {
        setError('设置服务不可用：settings namespace 未注册或宿主连接缺失')
        return
      }
      const fields = fieldsOf(snapshot)
      setLoaded(fields)
      setDraft(fieldsOf(fields))
      rememberSaved(fields, savedHosts.current)
      setSuggestions(keepSavedSuggestions(snapshot.suggestions, savedHosts.current))
      enrich(fields)
    }).catch(err => {
      if (alive) setError(String((err as Error)?.message ?? err))
    })
    return () => { alive = false; catalogRequest.current++ }
  }, [face, readAttempt])

  /** Fetch the latest revision and three-way rebase edits rather than discarding them. */
  async function reread(): Promise<void> {
    if (!face || !draft || !loaded || saving || reloading) return
    setReloading(true)
    setEditorEpoch(epoch => epoch + 1)
    setDirectEditing(false)
    setProxyEditing(false)
    setError('')
    catalogRequest.current++
    try {
      const snapshot = await face.read()
      if (!mounted.current) return
      if (!snapshot) throw new Error('设置服务不可用，请稍后重试')
      const latest = fieldsOf(snapshot)
      const rebased = rebaseProxyFields(loaded, draft, latest)
      rememberSaved(latest, savedHosts.current)
      setLoaded(latest)
      setDraft(rebased.fields)
      setSuggestions(keepSavedSuggestions(snapshot.suggestions, savedHosts.current))
      setNeedsReload(false)
      setConflictingFields(rebased.conflicts)
      if (rebased.conflicts.length > 0) {
        setError('远端和本地草稿修改了相同字段；草稿已保留。确认覆盖前不会保存。')
      } else {
        setNotice('已读取最新设置；本地草稿已保留，未编辑的字段已更新。')
      }
      enrich(latest)
    } catch (err) {
      if (mounted.current) {
        setError(`重新读取失败：${String((err as Error)?.message ?? err)}；本地草稿未丢失。`)
        setNeedsReload(true)
      }
    } finally {
      if (mounted.current) setReloading(false)
    }
  }

  if (!face) return <p className={css.pageIntro}>M-H-Proxy 面板未注入。</p>
  if (draft === null || loaded === null) {
    return (
      <div className={css.page}>
        <p className={css.pageIntro} role="status">{error || '正在读取设置…'}</p>
        {error ? <button type="button" className={css.save} onClick={() => { setReadAttempt(n => n + 1) }}>重试读取</button> : null}
      </div>
    )
  }

  const dirty = draft.proxy !== loaded.proxy
    || !sameHosts(draft.proxyHosts, loaded.proxyHosts)
    || !sameHosts(draft.excludeHosts, loaded.excludeHosts)
  const disabled = saving || reloading

  async function save(): Promise<void> {
    if (!face || !draft || needsReload || conflictingFields.length > 0 || saving || reloading || editingHost) return
    const fields = fieldsOf(draft)
    fields.proxy = fields.proxy.trim()
    // Refuse here rather than saving something the Host half will reject: a
    // "saved ✓" that silently kept the old routing would be a lie.
    const problem = configProblem(fields)
    if (problem !== null) {
      setError(problem)
      return
    }
    setSaving(true)
    setError('')
    setNotice('')
    try {
      await face.save(fields)
      if (!mounted.current) return
      setLoaded(fieldsOf(fields))
      setDraft(fieldsOf(fields))
      rememberSaved(fields, savedHosts.current)
      setSuggestions(rows => keepSavedSuggestions(rows, savedHosts.current))
      setNotice('已保存 ✓')
    } catch (err) {
      if (!mounted.current) return
      if (isSettingsConflict(err)) {
        setNeedsReload(true)
        setError('设置已在别处修改；点击「重新读取并保留草稿」后再保存，不会自动覆盖远端修改。')
      } else {
        setError(String((err as Error)?.message ?? err))
      }
    } finally {
      if (mounted.current) setSaving(false)
    }
  }

  return (
    <div className={css.page}>
      <ValueField
        id="model-proxy-url"
        label="代理地址"
        hint="支持 http / https / socks5 / socks5h（socks5h 的主机名由代理解析）；socks4/4a 不支持。留空则插件不生效。"
        placeholder="socks5://127.0.0.1:7890"
        value={draft.proxy}
        disabled={disabled}
        onEdit={(text: string) => { setDraft({ ...draft, proxy: text }) }}
      />
      <section className={css.rules} aria-labelledby="model-proxy-rules">
        <h2 className={css.label} id="model-proxy-rules">域名规则说明</h2>
        <ul className={css.ruleNotes}>
          <li>精确 host（如 api.example.com）仅匹配该主机；*.example.com 匹配根域 example.com 及所有层级子域。</li>
          <li>直连规则绝对优先；同时命中代理和直连时，始终直连。代理域名列表为空时，不代理任何请求。</li>
          <li>规则使用精确 host 或 *.host，不支持其它通配符。旧 .host 请手动改写为 *.host，不会自动转换。</li>
          <li>按请求域名路由，不区分 provider、模型或请求用途；同域名的 web 搜索、登录等请求也遵循这些规则。保存后下一次请求生效。</li>
        </ul>
      </section>
      <HostField
        key={`direct-${editorEpoch}`}
        onEditingChange={setDirectEditing}
        id="model-proxy-exclude"
        label="直连域名"
        priority="第一优先"
        hint="匹配这些规则的请求始终直连，即使也命中代理规则。"
        value={draft.excludeHosts}
        opposite={draft.proxyHosts}
        suggestions={suggestions}
        disabled={disabled}
        onChange={(next: string[]) => { setDraft({ ...draft, excludeHosts: next }); setError('') }}
      />
      <HostField
        key={`proxy-${editorEpoch}`}
        onEditingChange={setProxyEditing}
        id="model-proxy-hosts"
        label="代理域名"
        priority="第二优先"
        hint="仅代理匹配这些规则且未命中直连规则的请求；列表为空则不代理。下拉来自模型目录，目录不可用时明确标注降级来源。"
        value={draft.proxyHosts}
        opposite={draft.excludeHosts}
        suggestions={suggestions}
        disabled={disabled}
        proxyRules
        onChange={(next: string[]) => { setDraft({ ...draft, proxyHosts: next }); setError('') }}
      />
      <div className={css.footer}>
        {editingHost ? <p className={css.status} role="status">请先确认或取消正在编辑的域名</p> : null}
        {error
          ? <p className={`${css.status} ${css.statusFailed}`} role="status">{error}</p>
          : notice
            ? <p className={css.status} role="status">{notice}</p>
            : null}
        {needsReload
          ? <button type="button" className={css.secondary} disabled={disabled} onClick={() => { void reread() }}>{reloading ? '读取中…' : '重新读取并保留草稿'}</button>
          : null}
        {conflictingFields.length > 0
          ? <button type="button" className={css.secondary} disabled={disabled} onClick={() => {
              setConflictingFields([])
              setError('')
              setNotice('已确认覆盖冲突字段；点击保存后才会写入。')
            }}>确认以草稿覆盖冲突字段</button>
          : null}
        <button
          type="button"
          className={css.save}
          disabled={!dirty || disabled || needsReload || conflictingFields.length > 0 || editingHost}
          onClick={() => { void save() }}
        >
          {saving ? '保存中…' : '保存'}
        </button>
      </div>
    </div>
  )
}

/** Compare list membership without treating reorder-only edits as a dirty form. */
function sameHosts(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every(host => right.includes(host))
}
