/**
 * Shared form fields for the Model Http Proxy settings page: one labelled
 * text field and a hostname combobox (free text + suggestions dropdown).
 */

import { useState } from 'react'
import type { KeyboardEvent } from 'react'
import type { HostSuggestion } from './settings-io.js'
import { normalizeHostEntry } from '../hosts.js'
import css from './card.module.css'

/**
 * The dropdown chevron, drawn locally instead of imported from the host's
 * primitives module. The icon's export name is not stable across host
 * releases (`IconChevronDownOutline14` on 0.1.x, `IconChevronDownOutlineRegular`
 * on 0.2.x), and requiring the missing name yields `undefined` — which React
 * rejects as an invalid element type (#130) and takes the whole slot entry
 * down with it, leaving the settings page blank. A local SVG has no
 * cross-version surface and keeps the bundle self-contained.
 */
function ChevronDown(props: { className?: string | undefined }) {
  return (
    <svg
      className={props.className}
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M4 6.25 8 10.25 12 6.25"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
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

/**
 * A hostname field that behaves like the host's own tag inputs: every
 * committed host is drawn as a removable chip, and the text cursor lives in a
 * bare input at the end of the row. Focus (or the chevron) opens a dropdown of
 * the providers that are actually configured. Enter or a comma commits what is
 * typed, Backspace on an empty entry drops the last chip, Arrow keys move the
 * highlight, Enter picks a suggestion, Escape closes the list.
 *
 * The chips are the value: `value` is the parsed host list and `onChange`
 * always hands back a whole new list, so the page never has to split text.
 */
export function HostField(props: {
  id: string
  label: string
  hint: string
  placeholder: string
  value: string[]
  suggestions: HostSuggestion[]
  disabled: boolean
  onChange: (next: string[]) => void
}) {
  const [pending, setPending] = useState('')
  const [open, setOpen] = useState(false)
  const [highlight, setHighlight] = useState(0)
  // Already-committed hostnames, normalized the same way the Host half routes,
  // so a casing/port/URL variant of a saved host never shows as "new".
  const present = new Set(
    props.value.map(host => normalizeHostEntry(host)).filter((host): host is string => host !== undefined),
  )
  const query = pending.trim().toLowerCase()
  // Match the host, and also the provider name behind it, so typing "codex"
  // finds chatgpt.com and typing "kimi" finds api.kimi.com.
  const options = props.suggestions.filter(option =>
    !present.has(option.host)
    && (query === ''
      || option.host.includes(query)
      || option.providers.some(name => name.toLowerCase().includes(query))),
  )
  const active = open && highlight >= 0 && highlight < options.length ? highlight : -1

  /** Commit one or more hosts, de-duplicated against what is already selected. */
  const commit = (text: string): void => {
    if (props.disabled) return
    const parts = text.split(/[,，\s]+/).map(part => part.trim()).filter(part => part.length > 0)
    if (parts.length === 0) return
    const next = [...props.value]
    for (const part of parts) {
      const normalized = normalizeHostEntry(part)
      if (normalized === undefined) continue
      if (next.some(existing => normalizeHostEntry(existing) === normalized)) continue
      next.push(part)
    }
    setPending('')
    if (next.length !== props.value.length) props.onChange(next)
  }

  /** Drop the chip at one index; the rest of the list keeps its order. */
  const remove = (index: number): void => {
    if (props.disabled) return
    props.onChange(props.value.filter((_, position) => position !== index))
  }

  const move = (delta: number): void => {
    if (options.length === 0) return
    setHighlight(current => (current + delta + options.length) % options.length)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Escape') { setOpen(false); return }
    if (event.key === 'Enter') {
      event.preventDefault()
      if (open && options.length > 0 && pending.trim() === '') {
        const pick = options[active >= 0 ? active : 0]
        if (pick !== undefined) commit(pick.host)
        return
      }
      if (open && options.length > 0 && active >= 0) {
        const pick = options[active]
        if (pick !== undefined) { commit(pick.host); return }
      }
      commit(pending)
      return
    }
    if (event.key === 'Backspace' && pending === '' && props.value.length > 0) {
      event.preventDefault()
      remove(props.value.length - 1)
      return
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      if (!open) { setOpen(true); setHighlight(0); return }
      move(1)
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      if (!open) { setOpen(true); setHighlight(options.length - 1); return }
      move(-1)
      return
    }
    if (event.key === 'Home' && open) { event.preventDefault(); setHighlight(0); return }
    if (event.key === 'End' && open) { event.preventDefault(); setHighlight(options.length - 1); return }
  }

  return (
    <div className={css.field}>
      <div className={css.head}>
        <label className={css.label} htmlFor={props.id}>{props.label}</label>
      </div>
      <div
        className={css.combo}
        onBlur={(event) => {
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
          setOpen(false)
          // A host typed but not confirmed still lands: a blur is a commit.
          commit(pending)
        }}
      >
        <div className={css.comboBox}>
          {props.value.map((host, index) => (
            <span className={css.chip} key={`${host}-${index}`}>
              <span className={css.chipLabel}>{host}</span>
              <button
                type="button"
                className={css.chipRemove}
                aria-label={`不再代理 ${host}`}
                disabled={props.disabled}
                onMouseDown={(event) => { event.preventDefault() }}
                onClick={() => { remove(index) }}
              >
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                  <path d="M2 2 8 8M8 2 2 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                </svg>
              </button>
            </span>
          ))}
          <input
            id={props.id}
            className={css.comboEntry}
            type="text"
            role="combobox"
            aria-expanded={open}
            aria-controls={`${props.id}-list`}
            aria-autocomplete="list"
            aria-activedescendant={active >= 0 ? `${props.id}-opt-${active}` : undefined}
            value={pending}
            placeholder={props.value.length === 0 ? props.placeholder : ''}
            disabled={props.disabled}
            onFocus={() => { setOpen(true); setHighlight(0) }}
            onChange={(event) => {
              const text = event.target.value
              // A comma finishes the entry being typed, exactly like the host's
              // own tag inputs; the remainder stays editable.
              if (/[,，]/.test(text)) {
                const parts = text.split(/[,，]/)
                commit(parts.slice(0, -1).join(','))
                setPending(parts[parts.length - 1] ?? '')
                setOpen(true)
                setHighlight(0)
                return
              }
              setPending(text)
              setOpen(true)
              setHighlight(0)
            }}
            onKeyDown={onKeyDown}
          />
        </div>
        <button
          type="button"
          className={css.comboChevron}
          aria-label="选择域名"
          aria-expanded={open}
          tabIndex={-1}
          disabled={props.disabled}
          onMouseDown={(event) => { event.preventDefault() }}
          onClick={() => {
            const next = !open
            setOpen(next)
            if (next) setHighlight(0)
          }}
        >
          <ChevronDown className={open ? css.comboChevronOpen : undefined} />
        </button>
        {open
          ? (
            <ul className={css.comboList} id={`${props.id}-list`} role="listbox">
              {options.length > 0
                ? options.map((option, index) => (
                  <li
                    key={option.host}
                    role="option"
                    id={`${props.id}-opt-${index}`}
                    aria-selected={index === active}
                    onMouseEnter={() => { setHighlight(index) }}
                  >
                    <button
                      type="button"
                      className={css.comboItem}
                      onMouseDown={(event) => { event.preventDefault() }}
                      onClick={() => { commit(option.host) }}
                    >
                      <span className={css.comboItemHost}>{option.host}</span>
                      {option.providers.length > 0
                        ? <span className={css.comboItemProvider}>{option.providers.join(' · ')}</span>
                        : null}
                    </button>
                  </li>
                ))
                : <li className={css.comboEmpty}>没有可选的域名</li>}
            </ul>
          )
          : null}
      </div>
      <p className={css.hint}>{props.hint}</p>
    </div>
  )
}
