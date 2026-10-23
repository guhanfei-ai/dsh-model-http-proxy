/** Shared fields for the domain-routing settings page. */
import { useEffect, useState } from 'react'
import type { HostSuggestion } from './settings-io.js'
import { BUILTIN_PROXY_HOSTS, normalizeHostEntry } from '../hosts.js'
import css from './card.module.css'

const KIND_LABEL: Record<HostSuggestion['kind'], string> = {
  builtin: '内置',
  routable: '模型目录',
  configured: '已配置·未验证',
  fallback: '内置兜底',
  saved: '自定义·已保存',
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
        value={props.value}
        placeholder={props.placeholder}
        disabled={props.disabled}
        onChange={(event) => { props.onEdit(event.target.value) }}
      />
      <p className={css.hint}>{props.hint}</p>
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
  onChange: (next: string[]) => void
  onEditingChange: (editing: boolean) => void
}) {
  const [selected, setSelected] = useState('')
  const [editor, setEditor] = useState<{ index: number | null; original: string; text: string } | null>(null)
  const [problem, setProblem] = useState('')
  const editing = editor !== null
  useEffect(() => {
    props.onEditingChange(editing)
    return () => { props.onEditingChange(false) }
  }, [editing, props.onEditingChange])
  const taken = new Set([...props.value, ...props.opposite].map(hostKey))
  const options = props.suggestions.filter(option => normalizeHostEntry(option.host) !== undefined && !taken.has(hostKey(option.host)))
  // A selection may become unavailable after editing the other list or rereading.
  const choice = options.find(option => option.host === selected)

  function sourceOf(host: string): string {
    const key = hostKey(host)
    if (BUILTIN_PROXY_HOSTS.some(entry => hostKey(entry) === key)) return '内置'
    const suggestion = props.suggestions.find(option => hostKey(option.host) === key)
    if (!suggestion) return '自定义'
    return `${KIND_LABEL[suggestion.kind]}${suggestion.providers.length > 0 ? ` · ${suggestion.providers.join(' / ')}` : ''}`
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
          aria-label={`${props.label}${editor.index === null ? '手工添加' : '编辑'}域名`}
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
      <p className={css.hint}>{props.hint}</p>
      <div className={css.picker}>
        <select
          id={props.id}
          className={css.input}
          aria-label={`选择${props.label}`}
          value={choice ? selected : ''}
          disabled={props.disabled}
          onChange={event => { setSelected(event.target.value) }}
        >
          <option value="">{options.length > 0 ? '从候选域名中选择' : '暂无可选域名，可手工添加'}</option>
          {options.map(option => <option key={option.host} value={option.host}>{option.host} — {sourceOf(option.host)}</option>)}
        </select>
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
                {props.opposite.some(entry => hostKey(entry) === hostKey(host))
                  ? <span className={css.ruleWarning}>相同规则冲突 · 直连优先</span>
                  : props.proxyRules && props.opposite.some(entry => coveredBy(host, entry))
                    ? <span className={css.ruleWarning}>被直连规则覆盖</span>
                    : props.proxyRules && props.opposite.some(entry => coveredBy(entry, host))
                      ? <span className={css.ruleWarning}>部分域名直连</span>
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
        {props.value.length === 0 ? <li className={css.emptyList}>暂无规则{props.proxyRules ? '，所有请求直连' : ''}</li> : null}
        {editor?.index === null ? <li className={css.hostRow}>{renderEditor()}</li> : null}
      </ul>
      {problem ? <p className={`${css.hint} ${css.statusFailed}`} id={`${props.id}-error`} role="alert">{problem}</p> : null}
    </section>
  )
}
