/** Shared fields for the domain-routing settings page. */
import { useEffect, useRef, useState } from 'react'
import type { HostSuggestion } from './settings-io.js'
import { BUILTIN_DIRECT_HOSTS, BUILTIN_PROXY_HOSTS, builtinHostProvider, normalizeHostEntry } from '../hosts.js'
import { HostPicker } from './host-picker.js'
import type { HostPickerOption } from './host-picker.js'
import css from './card.module.css'

const KIND_LABEL: Record<HostSuggestion['kind'], string> = {
  builtin: '预置规则',
  routable: '模型目录',
  configured: '已配置·未验证',
  fallback: '目录兜底',
  saved: '自定义·已保存',
}

/** Adapter aliases share one company label; keep the underlying catalog intact. */
function providerLabel(providers: readonly string[]): string {
  return [...new Set(providers.map(name => /^deepseek(?:[\s_-]+(?:account|official))?$/iu.test(name.trim())
    ? 'DeepSeek' : name))].join(' / ')
}

export function ValueField(props: {
  id: string
  label: string
  hint: string
  placeholder: string
  value: string
  disabled: boolean
  onEdit: (text: string) => void
}) {
  return (
    <div className={css.field}>
      <div className={css.head}>
        <label className={css.label} htmlFor={props.id}>{props.label}</label>
      </div>
      <input
        id={props.id}
        className={css.input}
        type="text"
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        aria-describedby={`${props.id}-hint`}
        value={props.value}
        placeholder={props.placeholder}
        disabled={props.disabled}
        onChange={(event) => { props.onEdit(event.target.value) }}
      />
      <p className={css.hint} id={`${props.id}-hint`}>{props.hint}</p>
    </div>
  )
}

/** Canonical identity for dropdown exclusion, without rewriting legacy entries. */
function hostKey(host: string): string {
  return normalizeHostEntry(host) ?? host.trim().toLowerCase()
}

/** Whether the entire proxy rule is covered by a direct rule. */
function coveredBy(rule: string, direct: string): boolean {
  const host = normalizeHostEntry(rule)
  const exclusion = normalizeHostEntry(direct)
  if (!host || !exclusion) return false
  if (host === exclusion) return true
  if (!exclusion.startsWith('*.')) return false
  const base = exclusion.slice(2)
  const target = host.startsWith('*.') ? host.slice(2) : host
  return target === base || target.endsWith(`.${base}`)
}

/** Suggestions only populate the picker, never the effective draft list. */
export function HostField(props: {
  id: string
  label: string
  priority: string
  hint: string
  value: string[]
  opposite: string[]
  suggestions: HostSuggestion[]
  disabled: boolean
  proxyRules?: boolean
  scopeLabel?: string
  otherProxies?: { name: string; proxyHosts: string[] }[]
  conflicts?: { host: string; message: string }[]
  onChange: (next: string[]) => void
  onEditingChange: (editing: boolean) => void
}) {
  const [selected, setSelected] = useState('')
  const [editor, setEditor] = useState<{ index: number | null; original: string; text: string } | null>(null)
  const [problem, setProblem] = useState('')
  const editing = editor !== null
  const editingCallback = useRef(props.onEditingChange)
  editingCallback.current = props.onEditingChange
  useEffect(() => {
    editingCallback.current(editing)
    return () => { editingCallback.current(false) }
  }, [editing])
  const accessibleLabel = props.scopeLabel ? `${props.scopeLabel} · ${props.label}` : props.label
  // Keep taken candidates visible so a configured wildcard never looks missing.
  // Direct exceptions may intentionally overlap proxy rules on other lists.
  const taken = new Set(props.value.map(hostKey))
  const ownersOf = (host: string): string[] => (props.otherProxies ?? [])
    .filter(entry => entry.proxyHosts.some(rule => hostKey(rule) === hostKey(host)))
    .map(entry => entry.name)
  const presetOrder = props.proxyRules ? [...BUILTIN_PROXY_HOSTS, ...BUILTIN_DIRECT_HOSTS] : [...BUILTIN_DIRECT_HOSTS, ...BUILTIN_PROXY_HOSTS]
  const rank = (host: string): number => {
    const index = presetOrder.indexOf(hostKey(host))
    return index < 0 ? presetOrder.length : index
  }
  const options: HostPickerOption[] = props.suggestions
    .filter(option => normalizeHostEntry(option.host) !== undefined)
    .map(option => {
      const company = builtinHostProvider(option.host)
      const own = taken.has(hostKey(option.host))
      const owners = ownersOf(option.host)
      const status = own ? '已添加' : owners.length > 0 ? `已由 ${owners.join(' / ')} 使用` : undefined
      return {
        host: option.host,
        description: company ?? (providerLabel(option.providers) || KIND_LABEL[option.kind]),
        group: company !== undefined || option.kind === 'builtin' ? 'preset' as const : 'model' as const,
        disabled: own || owners.length > 0,
        ...(status === undefined ? {} : { status }),
      }
    })
    .sort((left, right) => {
      if (left.group !== right.group) return left.group === 'preset' ? -1 : 1
      if (left.group === 'preset' && rank(left.host) !== rank(right.host)) return rank(left.host) - rank(right.host)
      return left.host.localeCompare(right.host)
    })
  const choice = options.find(option => option.host === selected && !option.disabled)
  const conflictOf = (host: string): string | undefined => props.conflicts?.find(conflict => hostKey(conflict.host) === hostKey(host))?.message

  function sourceOf(host: string): string {
    const key = hostKey(host)
    const builtin = builtinHostProvider(host)
    if (builtin !== undefined) return builtin
    const suggestion = props.suggestions.find(option => hostKey(option.host) === key)
    if (!suggestion) return '自定义'
    const providers = providerLabel(suggestion.providers)
    if (suggestion.kind === 'builtin') return providers || '预置规则'
    return `${KIND_LABEL[suggestion.kind]}${providers ? ` · ${providers}` : ''}`
  }

  function confirm(): void {
    if (props.disabled || !editor) return
    const text = editor.text.trim()
    if (text.startsWith('.')) {
      setProblem(`旧 .host 写法不再支持，请手动改写为 *${text} 后确认。`)
      return
    }
    const host = normalizeHostEntry(text)
    if (host === undefined) {
      setProblem('请输入有效的精确 host 或 *.host，不支持其它通配符或旧 .host 写法。')
      return
    }
    if (editor.index !== null && props.value[editor.index] !== editor.original) {
      setProblem('列表已更新，请取消后重新编辑该规则。')
      return
    }
    if (props.value.some((entry, index) => index !== editor.index && hostKey(entry) === host)) {
      setProblem('此列表已包含相同规则。')
      return
    }
    // Manual rules may overlap the opposite list: direct routing always wins.
    props.onChange(editor.index === null
      ? [...props.value, host]
      : props.value.map((entry, index) => index === editor.index ? host : entry))
    setEditor(null)
    setProblem('')
  }

  function renderEditor() {
    if (!editor) return null
    return (
      <div className={css.inlineEditor}>
        <input
          autoFocus
          className={css.input}
          aria-label={`${accessibleLabel}${editor.index === null ? '手工添加' : '编辑'}域名`}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          aria-invalid={problem.length > 0}
          aria-describedby={problem ? `${props.id}-error` : undefined}
          placeholder="example.com 或 *.example.com"
          value={editor.text}
          disabled={props.disabled}
          onChange={event => { setEditor({ ...editor, text: event.target.value }); setProblem('') }}
          onKeyDown={event => {
            if (event.key === 'Enter') { event.preventDefault(); confirm() }
            if (event.key === 'Escape') { event.preventDefault(); setEditor(null); setProblem('') }
          }}
        />
        <button type="button" className={css.secondary} disabled={props.disabled} onClick={confirm}>确认</button>
        <button type="button" className={css.secondary} disabled={props.disabled} onClick={() => { setEditor(null); setProblem('') }}>取消</button>
      </div>
    )
  }

  return (
    <section className={css.hostSection} aria-labelledby={`${props.id}-heading`}>
      <div className={css.head}>
        <h2 id={`${props.id}-heading`} className={css.sectionTitle}>{props.label}</h2>
        <span className={css.priority}>{props.priority}</span>
      </div>
      <p className={css.hint} id={`${props.id}-hint`}>{props.hint}</p>
      <div className={css.picker}>
        <HostPicker id={props.id} label={`选择${accessibleLabel}`} describedBy={`${props.id}-hint`}
          value={options.some(option => option.host === selected) ? selected : ''} options={options} disabled={props.disabled}
          onChange={host => { setSelected(host) }} />
        <button type="button" className={css.secondary} disabled={props.disabled || !choice} onClick={() => {
          if (!choice || taken.has(hostKey(choice.host))) return
          props.onChange([...props.value, choice.host])
          setSelected('')
        }}>添加</button>
      </div>
      <div className={css.listHead}>
        <h3 className={css.listTitle}>生效域名列表（保存后生效）<span className={css.count}>{props.value.length}</span></h3>
        <button type="button" className={css.secondary} disabled={props.disabled || editor !== null} onClick={() => {
          setEditor({ index: null, original: '', text: '' }); setProblem('')
        }}>手工添加</button>
      </div>
      <ul className={css.hostList}>
        {props.value.map((host, index) => (
          <li className={css.hostRow} key={`${host}-${index}`}>
            {editor?.index === index ? renderEditor() : <>
              <div className={css.hostDetails}>
                <span className={css.hostName}>{host}</span>
                <span className={css.source}>来源：{sourceOf(host)}</span>
                {host.trim().startsWith('.') ? <span className={css.ruleWarning}>旧写法：请编辑为 *{host.trim()}</span> : null}
                {conflictOf(host) ? <span className={css.ruleConflict} role="alert">{conflictOf(host)}</span> : null}
                {props.proxyRules && props.opposite.some(entry => coveredBy(host, entry))
                  ? <span className={css.ruleWarning}>被全局直连规则覆盖 · 使用本机默认网络</span>
                  : props.proxyRules && props.opposite.some(entry => coveredBy(entry, host))
                    ? <span className={css.ruleWarning}>部分域名使用本机默认网络</span>
                    : !props.proxyRules && props.opposite.some(entry => coveredBy(host, entry) || coveredBy(entry, host))
                      ? <span className={css.ruleWarning}>此直连规则优先于代理卡片</span>
                      : null}
              </div>
              <div className={css.rowActions}>
                <button type="button" className={css.rowButton} aria-label={`编辑 ${host}`} disabled={props.disabled || editor !== null} onClick={() => {
                  setEditor({ index, original: host, text: host }); setProblem('')
                }}>编辑</button>
                <button type="button" className={css.rowButton} aria-label={`删除 ${host}`} disabled={props.disabled || editor !== null} onClick={() => {
                  props.onChange(props.value.filter((_, position) => position !== index))
                }}>删除</button>
              </div>
            </>}
          </li>
        ))}
        {props.value.length === 0 ? <li className={css.emptyList}>{props.proxyRules ? '暂无代理规则，此卡片不代理任何域名' : '暂无全局直连规则'}</li> : null}
        {editor?.index === null ? <li className={css.hostRow}>{renderEditor()}</li> : null}
      </ul>
      {problem ? <p className={`${css.hint} ${css.statusFailed}`} id={`${props.id}-error`} role="alert">{problem}</p> : null}
    </section>
  )
}
