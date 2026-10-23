/** Global network exceptions and named proxy cards, saved as one routing document. */
import { useEffect, useRef, useState } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { HostSuggestion, ProxyFace, ProxyFields } from './settings-io.js'
import { cloneProxyFields, isBackendReloadRequired, isSettingsConflict, rebaseRoutingFields, sameProxyFields } from './settings-io.js'
import { normalizeHostEntry } from '../hosts.js'
import { proxyConflicts, routingFieldsOf } from '../routes.js'
import type { ProxyEntry } from '../routes.js'
import { configProblem } from '../validate.js'
import { ValueField, HostField } from './fields.js'
import css from './card.module.css'

export type ModelProxyPageProps = PropsRuntime<'settings.section'> & { proxyFace?: ProxyFace }

/** A saved custom rule stays selectable after removal, including across cards. */
function keepSavedSuggestions(suggestions: HostSuggestion[], saved: Set<string>): HostSuggestion[] {
  const byHost = new Map(suggestions.map(option => [option.host, option]))
  for (const host of saved) {
    if (!byHost.has(host)) byHost.set(host, { host, providers: [], kind: 'saved' })
  }
  return [...byHost.values()].sort((a, b) => a.host.localeCompare(b.host))
}

function rememberSaved(fields: ProxyFields, saved: Set<string>): void {
  for (const entry of [...fields.proxies.flatMap(proxy => proxy.proxyHosts), ...fields.excludeHosts]) {
    const host = normalizeHostEntry(entry)
    if (host !== undefined) saved.add(host)
  }
}

/** A stable, document-local identity, unrelated to the card's display name or position. */
function newProxy(fields: ProxyFields): ProxyEntry {
  let number = 1
  while (fields.proxies.some(entry => entry.name === `代理${number}`)) number++
  let id: string
  do { id = `proxy-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}` }
  while (fields.proxies.some(entry => entry.id === id))
  return { id, name: `代理${number}`, enabled: true, proxy: '', proxyHosts: [] }
}

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
  const [editingFields, setEditingFields] = useState<Set<string>>(() => new Set())
  const [editorEpoch, setEditorEpoch] = useState(0)
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)
  const savedHosts = useRef(new Set<string>())
  const catalogRequest = useRef(0)
  const mounted = useRef(true)
  const editingHost = editingFields.size > 0

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; catalogRequest.current++ }
  }, [])

  function markEditing(id: string, editing: boolean): void {
    setEditingFields(previous => {
      if (previous.has(id) === editing) return previous
      const next = new Set(previous)
      if (editing) next.add(id)
      else next.delete(id)
      return next
    })
  }

  function resetEditors(): void {
    setEditorEpoch(epoch => epoch + 1)
    setEditingFields(new Set())
    setPendingDelete(null)
  }

  function enrich(snapshot: ProxyFields): void {
    if (!face) return
    const request = ++catalogRequest.current
    void face.refreshSuggestions(snapshot).then(rows => {
      if (mounted.current && catalogRequest.current === request) {
        setSuggestions(keepSavedSuggestions(rows, savedHosts.current))
      }
    }).catch(() => { /* The immediately rendered fallback candidates are labelled. */ })
  }

  useEffect(() => {
    let alive = true
    resetEditors()
    if (!face) return
    setError('')
    void face.read().then(snapshot => {
      if (!alive) return
      if (!snapshot) {
        setError('设置服务不可用：settings namespace 未注册或宿主连接缺失')
        return
      }
      const fields = routingFieldsOf(snapshot)
      setLoaded(cloneProxyFields(fields))
      setDraft(cloneProxyFields(fields))
      rememberSaved(fields, savedHosts.current)
      setSuggestions(keepSavedSuggestions(snapshot.suggestions, savedHosts.current))
      enrich(fields)
    }).catch(err => {
      if (alive) setError(String((err as Error)?.message ?? err))
    })
    return () => { alive = false; catalogRequest.current++ }
  }, [face, readAttempt])

  async function reread(): Promise<void> {
    if (!face || !draft || !loaded || saving || reloading) return
    setReloading(true)
    resetEditors()
    setError('')
    setNotice('')
    catalogRequest.current++
    try {
      const snapshot = await face.read()
      if (!mounted.current) return
      if (!snapshot) throw new Error('设置服务不可用，请稍后重试')
      const latest = routingFieldsOf(snapshot)
      const rebased = rebaseRoutingFields(loaded, draft, latest)
      rememberSaved(latest, savedHosts.current)
      setLoaded(cloneProxyFields(latest))
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
    return <div className={css.page}>
      <p className={css.pageIntro} role="status">{error || '正在读取设置…'}</p>
      {error ? <button type="button" className={css.save} onClick={() => { setReadAttempt(n => n + 1) }}>重试读取</button> : null}
    </div>
  }

  const dirty = !sameProxyFields(draft, loaded)
  const disabled = saving || reloading
  const problem = configProblem(draft)
  const conflicts = proxyConflicts(draft)
  const activeHosts = draft.proxies.filter(entry => entry.enabled).flatMap(entry => entry.proxyHosts)

  function change(next: ProxyFields): void {
    setDraft(next)
    setNotice('')
    if (!needsReload && conflictingFields.length === 0) setError('')
  }

  function editProxy(id: string, patch: Partial<ProxyEntry>): void {
    if (!draft) return
    change({ ...draft, proxies: draft.proxies.map(entry => entry.id === id ? { ...entry, ...patch } : entry) })
  }

  async function save(): Promise<void> {
    if (!face || !draft || needsReload || conflictingFields.length > 0 || disabled || editingHost || pendingDelete !== null) return
    const fields = cloneProxyFields(draft)
    fields.proxies = fields.proxies.map(entry => ({ ...entry, name: entry.name.trim(), proxy: entry.proxy.trim() }))
    const invalid = configProblem(fields)
    if (invalid !== null) { setError(invalid); return }
    setSaving(true)
    setError('')
    setNotice('')
    try {
      await face.save(fields)
      if (!mounted.current) return
      setLoaded(cloneProxyFields(fields))
      setDraft(cloneProxyFields(fields))
      rememberSaved(fields, savedHosts.current)
      setSuggestions(rows => keepSavedSuggestions(rows, savedHosts.current))
      setNotice('已保存 ✓')
    } catch (err) {
      if (!mounted.current) return
      if (isBackendReloadRequired(err)) {
        setNeedsReload(true)
        setError(String((err as Error).message))
      } else if (isSettingsConflict(err)) {
        setNeedsReload(true)
        setError('设置已在别处修改；点击「重新读取并保留草稿」后再保存，不会自动覆盖远端修改。')
      } else {
        setError(String((err as Error)?.message ?? err))
      }
    } finally {
      if (mounted.current) setSaving(false)
    }
  }

  const footerMessage = error || problem || (editingHost ? '请先确认或取消正在编辑的域名' : '')
    || (pendingDelete !== null ? '请先确认或取消删除代理' : '') || notice || (dirty ? '有未保存的修改' : '保存后，新的请求按最新规则选路。')

  return <div className={css.page}>
    <section className={css.rules} aria-labelledby="model-proxy-rules">
      <h2 className={css.sectionTitle} id="model-proxy-rules">域名规则说明</h2>
      <p className={css.hint}>命中全局直连规则时，始终走直连，不受代理卡片影响；未命中代理规则时使用本机默认网络。</p>
      <details className={css.ruleDetails}>
        <summary>展开详细说明</summary>
        <ul className={css.ruleNotes}>
          <li>这里的直连是绕过本插件，沿用宿主／本机默认网络；不关闭系统代理、VPN 或 TUN。</li>
          <li>精确 host 仅匹配自身；*.example.com 匹配根域 example.com 及所有层级子域。不支持旧 .host 或其它通配格式。</li>
          <li>代理卡片之间，精确规则优先于通配规则，更具体的后缀优先。同一规则不能同时属于两个启用的代理；卡片顺序不决定出口。</li>
          <li>只按 HTTP fetch 的请求域名路由，不区分 provider、模型或请求用途。同域的登录、搜索请求也遵循这些规则，WebSocket 不在范围内。</li>
          <li>空代理列表不代理任何请求。代理连接失败时不会自动切换其它代理或直连。</li>
        </ul>
      </details>
    </section>

    <div className={css.directCard}>
      <HostField
        key={`direct-${editorEpoch}`}
        id="model-proxy-exclude"
        label="全局直连域名"
        priority="第一优先级"
        hint="命中后使用本机默认网络，不走本插件的任何代理。"
        value={draft.excludeHosts}
        opposite={activeHosts}
        suggestions={suggestions}
        disabled={disabled}
        onEditingChange={editing => { markEditing('global-direct', editing) }}
        onChange={next => { change({ ...draft, excludeHosts: next }) }}
      />
    </div>

    <section className={css.proxySection} aria-labelledby="model-proxy-cards">
      <div className={css.proxySectionHead}>
        <div>
          <h2 className={css.sectionTitle} id="model-proxy-cards">代理配置 <span className={css.count}>{draft.proxies.length}</span></h2>
          <p className={css.hint}>每张卡管理一个代理；名称和排列顺序不代表优先级。</p>
        </div>
        <button type="button" className={css.secondary} disabled={disabled || editingHost || pendingDelete !== null} onClick={() => {
          change({ ...draft, proxies: [...draft.proxies, newProxy(draft)] })
        }}>＋ 添加代理</button>
      </div>

      <div className={css.proxyStack}>
        {draft.proxies.map((entry, index) => {
          const domId = `model-proxy-card-${index}`
          const cardName = entry.name.trim() || `未命名代理${index + 1}`
          const peers = entry.enabled ? draft.proxies.filter(other => other.enabled && other.id !== entry.id) : []
          const fieldConflicts = conflicts.filter(conflict => conflict.proxyIds.includes(entry.id)).map(conflict => ({
            host: conflict.host,
            message: `此规则已配置到「${conflict.proxyIds.filter(id => id !== entry.id).map(id => draft.proxies.find(other => other.id === id)?.name || id).join(' / ')}」，请选择保留在哪个代理。`,
          }))
          return <article className={`${css.proxyCard} ${entry.enabled ? '' : css.proxyCardInactive}`} key={entry.id} data-proxy-card={entry.id} aria-label={cardName}>
            <div className={css.proxyCardHead}>
              <span className={css.cardIndex} aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
              <label className={css.srOnly} htmlFor={`${domId}-name`}>代理名称 {index + 1}</label>
              <input id={`${domId}-name`} className={css.proxyName} value={entry.name} placeholder="代理名称" maxLength={80} disabled={disabled}
                onChange={event => { editProxy(entry.id, { name: event.target.value }) }} />
              <button type="button" role="switch" aria-checked={entry.enabled} aria-label={`启用 ${cardName}`} className={css.toggle} disabled={disabled}
                onClick={() => { editProxy(entry.id, { enabled: !entry.enabled }) }}>
                <span className={css.toggleTrack} aria-hidden="true"><span /></span>
                <span>{entry.enabled ? '已启用' : '已停用'}</span>
              </button>
            </div>
            {!entry.enabled ? <p className={css.inactiveHint}>此代理已停用，配置保留，不参与选路。</p> : null}
            <ValueField id={`${domId}-url`} label="代理地址" hint="支持 http / https / socks5 / socks5h；启用时必须填写有效地址。"
              placeholder="http://127.0.0.1:7890" value={entry.proxy} disabled={disabled} onEdit={proxy => { editProxy(entry.id, { proxy }) }} />
            <HostField key={`${entry.id}-${editorEpoch}`} id={`${domId}-hosts`} label="代理域名" scopeLabel={cardName} priority="第二优先级"
              hint="仅代理这些规则命中且未命中全局直连的请求；列表为空时，此卡片不代理任何域名。"
              value={entry.proxyHosts} opposite={draft.excludeHosts} otherProxies={peers} conflicts={fieldConflicts}
              suggestions={suggestions} disabled={disabled} proxyRules
              onEditingChange={editing => { markEditing(`proxy:${entry.id}`, editing) }}
              onChange={proxyHosts => { editProxy(entry.id, { proxyHosts }) }} />
            <div className={css.cardFooter}>
              {pendingDelete === entry.id ? <div className={css.deleteConfirm} role="alertdialog" aria-labelledby={`${domId}-delete-title`} aria-describedby={`${domId}-delete-hint`}>
                <p id={`${domId}-delete-title`}>删除「{cardName}」？</p>
                <p id={`${domId}-delete-hint`} className={css.hint}>保存后才会移除该代理；届时若无其它规则命中，其域名将使用本机默认网络。</p>
                <div className={css.deleteActions}>
                  <button type="button" className={css.secondary} disabled={disabled} autoFocus onClick={() => { setPendingDelete(null) }}>取消删除</button>
                  <button type="button" className={css.dangerButton} disabled={disabled || editingHost} onClick={() => {
                    change({ ...draft, proxies: draft.proxies.filter(other => other.id !== entry.id) })
                    setPendingDelete(null)
                  }}>确认删除</button>
                </div>
              </div> : <button type="button" className={css.deleteButton} aria-label={`删除代理 ${cardName}`} disabled={disabled || editingHost || pendingDelete !== null}
                onClick={() => { setPendingDelete(entry.id) }}>删除代理</button>}
            </div>
          </article>
        })}
        {draft.proxies.length === 0 ? <div className={css.emptyCards}>
          <p>尚未配置代理</p><p className={css.hint}>所有请求使用本机默认网络。点击「添加代理」开始配置。</p>
        </div> : null}
      </div>
    </section>

    <div className={css.footer}>
      <p className={`${css.status} ${error || problem ? css.statusFailed : notice === '已保存 ✓' ? css.statusSaved : ''}`} role="status">{footerMessage}</p>
      {needsReload ? <button type="button" className={css.secondary} disabled={disabled} onClick={() => { void reread() }}>重新读取并保留草稿</button> : null}
      {conflictingFields.length > 0 ? <button type="button" className={css.secondary} disabled={disabled} onClick={() => {
        setConflictingFields([])
        setError('')
        setNotice('已确认覆盖冲突字段；点击保存后才会写入。')
      }}>确认以草稿覆盖冲突字段</button> : null}
      <button type="button" className={css.secondary} disabled={disabled || (!dirty && !editingHost && pendingDelete === null)} onClick={() => {
        resetEditors()
        setDraft(cloneProxyFields(loaded))
        setConflictingFields([])
        setError(needsReload ? '请先重新读取最新设置后再保存。' : '')
        setNotice('已撤销未保存的修改。')
      }}>撤销修改</button>
      <button type="button" className={css.save} disabled={!dirty || disabled || needsReload || conflictingFields.length > 0 || editingHost || problem !== null || pendingDelete !== null}
        onClick={() => { void save() }}>{saving ? '保存中…' : '保存'}</button>
    </div>
  </div>
}
