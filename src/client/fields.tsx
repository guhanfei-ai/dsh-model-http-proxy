/**
 * Shared form fields for the Model Http Proxy settings page: one labelled
 * text field and a hostname combobox (free text + suggestions dropdown).
 */

import { useState } from 'react'
import type { KeyboardEvent } from 'react'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import { normalizeHostEntry } from '../hosts.js'
import css from './card.module.css'

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
 * A hostname field that doubles as a combobox: it stays free text, but focus
 * (or a chevron) opens a dropdown of known model hostnames to pick from,
 * styled like the host's own menus rather than a browser dialog. Arrow keys
 * move the highlight, Enter picks, Escape closes.
 */
export function HostField(props: {
  id: string
  label: string
  hint: string
  placeholder: string
  value: string
  suggestions: string[]
  disabled: boolean
  onEdit: (text: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [highlight, setHighlight] = useState(0)
  // Already-committed hostnames, normalized the same way the Host half routes,
  // so a casing/port/URL variant of a saved host never shows as "new".
  const present = new Set(
    props.value.split(/[,\s]+/).map(token => normalizeHostEntry(token)).filter((h): h is string => h !== undefined),
  )
  // The token being typed right now: whatever follows the last separator.
  const tail = /[^,\s]*$/.exec(props.value)?.[0] ?? ''
  const options = props.suggestions.filter(host =>
    !present.has(host)
    && (tail === '' || host.includes(tail.toLowerCase())),
  )
  const active = open && highlight >= 0 && highlight < options.length ? highlight : -1

  const add = (host: string): void => {
    if (props.disabled) return
    const parts = props.value.trim() === '' ? [] : props.value.trim().split(/[,\s]+/).filter(Boolean)
    // The text ends right after a separator: every token is committed and
    // nothing is being typed, so the pick always appends — a committed custom
    // host is never clobbered.
    const hasDraft = !/[,\s]$/.test(props.value)
    const last = parts[parts.length - 1]
    const committed = new Set<string>()
    for (const token of [...props.suggestions, ...parts.slice(0, -1)]) {
      const normalized = normalizeHostEntry(token)
      if (normalized !== undefined) committed.add(normalized)
    }
    const draft = hasDraft && last !== undefined && !committed.has(normalizeHostEntry(last) ?? '')
      ? last
      : undefined
    const base = draft === undefined ? parts : parts.slice(0, -1)
    if (!base.some(token => normalizeHostEntry(token) === host)) {
      props.onEdit(base.length === 0 ? host : `${base.join(', ')}${', '}${host}`)
    }
    // Keep the panel open so several hosts can be picked in a row; the
    // just-picked host leaves `options` on the next render.
    setHighlight(0)
  }

  const move = (delta: number): void => {
    if (options.length === 0) return
    setHighlight(current => (current + delta + options.length) % options.length)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Escape') { setOpen(false); return }
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
    if (event.key === 'Enter' && open && options.length > 0) {
      event.preventDefault()
      const pick = options[active >= 0 ? active : 0]
      if (pick !== undefined) add(pick)
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
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false)
        }}
      >
        <input
          id={props.id}
          className={`${css.input} ${css.comboInput}`}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={`${props.id}-list`}
          aria-autocomplete="list"
          aria-activedescendant={active >= 0 ? `${props.id}-opt-${active}` : undefined}
          value={props.value}
          placeholder={props.placeholder}
          disabled={props.disabled}
          onFocus={() => { setOpen(true); setHighlight(0) }}
          onChange={(event) => { props.onEdit(event.target.value); setOpen(true); setHighlight(0) }}
          onKeyDown={onKeyDown}
        />
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
          <IconChevronDownOutline14 className={open ? css.comboChevronOpen : undefined} />
        </button>
        {open
          ? (
            <ul className={css.comboList} id={`${props.id}-list`} role="listbox">
              {options.length > 0
                ? options.map((host, index) => (
                  <li
                    key={host}
                    role="option"
                    id={`${props.id}-opt-${index}`}
                    aria-selected={index === active}
                    onMouseEnter={() => { setHighlight(index) }}
                  >
                    <button
                      type="button"
                      className={css.comboItem}
                      onMouseDown={(event) => { event.preventDefault() }}
                      onClick={() => { add(host) }}
                    >
                      {host}
                    </button>
                  </li>
                ))
                : <li className={css.comboEmpty}>无更多可选域名</li>}
            </ul>
          )
          : null}
      </div>
      <p className={css.hint}>{props.hint}</p>
    </div>
  )
}
