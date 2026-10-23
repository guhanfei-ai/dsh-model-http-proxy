/** A two-column domain picker. Native popovers escape the host modal's scroller. */
import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import css from './card.module.css'

export interface HostPickerOption {
  host: string
  description: string
  group: 'preset' | 'model'
  disabled: boolean
  status?: string
}

export function HostPicker(props: {
  id: string
  label: string
  describedBy: string
  value: string
  options: HostPickerOption[]
  disabled: boolean
  onChange: (host: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [activeHost, setActiveHost] = useState('')
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popupRef = useRef<HTMLDivElement>(null)
  const typed = useRef({ text: '', time: 0 })
  const rows = props.options.map((option, index) => ({ ...option, domId: `${props.id}-option-${index}` }))
  const presets = rows.filter(option => option.group === 'preset')
  const models = rows.filter(option => option.group === 'model')
  const enabled = rows.filter(option => !option.disabled)
  const selected = rows.find(option => option.host === props.value)
  const active = rows.find(option => option.host === activeHost)
  const popupId = `${props.id}-listbox`
  const expanded = open && !props.disabled

  useEffect(() => { if (props.disabled) setOpen(false) }, [props.disabled])

  useEffect(() => {
    if (!expanded) return
    const trigger = triggerRef.current
    const popup = popupRef.current
    if (!trigger || !popup) return
    const nativePopover = typeof popup.showPopover === 'function'
    if (!nativePopover) popup.removeAttribute('popover')
    let anchorPosition: { top: number; left: number } | undefined

    function position(): void {
      if (!trigger || !popup) return
      const anchor = trigger.getBoundingClientRect()
      anchorPosition = { top: anchor.top, left: anchor.left }
      const margin = 8
      const gap = 6
      const width = Math.max(0, Math.min(anchor.width, window.innerWidth - margin * 2))
      const left = Math.max(margin, Math.min(anchor.left, window.innerWidth - margin - width))
      const below = window.innerHeight - anchor.bottom - margin - gap
      const above = anchor.top - margin - gap
      const upwards = below < 400 && above > below
      const available = Math.max(0, Math.min(400, upwards ? above : below))
      popup.style.width = `${width}px`
      popup.style.maxHeight = `${available}px`
      if (nativePopover) {
        popup.style.position = 'fixed'
        popup.style.left = `${left}px`
        const height = popup.getBoundingClientRect().height
        popup.style.top = `${upwards ? Math.max(margin, anchor.top - gap - height) : anchor.bottom + gap}px`
      } else {
        // Functional fallback for old engines without a top-layer API. Current
        // DSH browsers use the native path, avoiding transformed-modal clipping.
        popup.style.position = 'absolute'
        popup.style.left = '0px'
        popup.style.top = upwards ? 'auto' : 'calc(100% + 6px)'
        popup.style.bottom = upwards ? 'calc(100% + 6px)' : 'auto'
      }
    }

    position()
    if (nativePopover) popup.showPopover()
    position()
    const contains = (event: Event): boolean => {
      const path = event.composedPath()
      return path.includes(trigger) || path.includes(popup)
    }
    const outside = (event: Event): void => { if (!contains(event)) setOpen(false) }
    const scroll = (event: Event): void => {
      if (event.target === popup || popup.contains(event.target as Node)) return
      const current = trigger.getBoundingClientRect()
      // Focusing/scrolling the trigger can queue a scroll event that arrives
      // after opening. Do not dismiss a correctly anchored menu for that event
      // (or for an unrelated scroller); close only when the trigger has moved.
      if (anchorPosition && Math.abs(current.top - anchorPosition.top) < 0.5
        && Math.abs(current.left - anchorPosition.left) < 0.5) return
      setOpen(false)
    }
    const escape = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
      trigger.focus()
    }
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('focusin', outside, true)
    document.addEventListener('scroll', scroll, true)
    document.addEventListener('keydown', escape, true)
    window.addEventListener('resize', position)
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(position)
    observer?.observe(trigger)
    observer?.observe(popup)
    return () => {
      observer?.disconnect()
      document.removeEventListener('pointerdown', outside, true)
      document.removeEventListener('focusin', outside, true)
      document.removeEventListener('scroll', scroll, true)
      document.removeEventListener('keydown', escape, true)
      window.removeEventListener('resize', position)
      if (nativePopover) {
        try { popup.hidePopover() } catch { /* unmounted or already hidden */ }
      }
    }
  }, [expanded, props.id])

  useEffect(() => {
    const popup = popupRef.current
    if (!expanded || !popup || !active) return
    const option = document.getElementById(active.domId)
    if (!option) return
    // Scroll only the menu, never its containing settings panel.
    if (option.offsetTop < popup.scrollTop) popup.scrollTop = option.offsetTop
    else if (option.offsetTop + option.offsetHeight > popup.scrollTop + popup.clientHeight) {
      popup.scrollTop = option.offsetTop + option.offsetHeight - popup.clientHeight
    }
  }, [expanded, active?.domId])

  function openMenu(backwards = false): void {
    if (props.disabled) return
    typed.current = { text: '', time: 0 }
    const current = enabled.find(option => option.host === props.value)
    setActiveHost((current ?? (backwards ? enabled.at(-1) : enabled[0]))?.host ?? '')
    setOpen(true)
  }

  function choose(option: HostPickerOption): void {
    if (!expanded || props.disabled || option.disabled) return
    props.onChange(option.host)
    setOpen(false)
    triggerRef.current?.focus()
  }

  function keyDown(event: KeyboardEvent<HTMLElement>): void {
    if (props.disabled) return
    if (event.key === 'Escape' && expanded) {
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
      return
    }
    if (event.key === 'Tab') { setOpen(false); return }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!expanded) { openMenu(event.key === 'ArrowUp'); return }
      if (enabled.length === 0) { setActiveHost(''); return }
      const index = enabled.findIndex(option => option.host === activeHost)
      const direction = event.key === 'ArrowDown' ? 1 : -1
      const next = index < 0 ? (direction > 0 ? 0 : enabled.length - 1)
        : (index + direction + enabled.length) % enabled.length
      setActiveHost(enabled[next]?.host ?? '')
      return
    }
    if (expanded && (event.key === 'Home' || event.key === 'End')) {
      event.preventDefault()
      setActiveHost((event.key === 'Home' ? enabled[0] : enabled.at(-1))?.host ?? '')
      return
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      if (!expanded) openMenu()
      else if (active) choose(active)
      return
    }
    if (expanded && event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const now = Date.now()
      const prefix = now - typed.current.time > 700 ? event.key : typed.current.text + event.key
      const matches = (text: string): HostPickerOption | undefined => enabled.find(option =>
        option.host.replace(/^\*\./u, '').toLowerCase().startsWith(text)
        || option.description.toLowerCase().startsWith(text))
      const query = prefix.toLowerCase()
      const fullMatch = matches(query)
      const match = fullMatch ?? matches(event.key.toLowerCase())
      typed.current = { text: fullMatch ? query : match ? event.key.toLowerCase() : '', time: now }
      if (match) { event.preventDefault(); setActiveHost(match.host) }
    }
  }

  function renderRows(options: typeof rows) {
    return options.map(option => <button type="button" role="option" key={option.host} id={option.domId}
      value={option.host} aria-label={`${option.host}，${option.description}${option.status ? `，${option.status}` : ''}`}
      aria-selected={props.value === option.host} aria-disabled={option.disabled}
      disabled={option.disabled} tabIndex={-1}
      className={`${css.hostPickerOption} ${activeHost === option.host ? css.hostPickerOptionActive : ''}`}
      onPointerMove={() => { if (!option.disabled) setActiveHost(option.host) }}
      onMouseDown={event => { event.preventDefault() }}
      onClick={() => { choose(option) }}>
      <span className={css.hostPickerDomain} title={option.host}>{option.host}</span>
      <span className={css.hostPickerDescription}>
        <span>{option.description}</span>
        {option.status ? <small className={css.hostPickerStatus}>{option.status}</small> : null}
      </span>
    </button>)
  }

  return <div className={css.hostPicker}>
    <button type="button" role="combobox" id={props.id} ref={triggerRef} value={props.value}
      className={css.hostPickerTrigger} aria-label={props.label} aria-describedby={props.describedBy}
      aria-haspopup="listbox" aria-expanded={expanded} aria-controls={popupId}
      aria-activedescendant={expanded ? active?.domId : undefined} disabled={props.disabled}
      onClick={() => { if (expanded) setOpen(false); else openMenu() }} onKeyDown={keyDown}>
      <span className={css.hostPickerTriggerText}>{selected?.host ?? (rows.length > 0 ? '从候选域名中选择' : '暂无可选域名，可手工添加')}</span>
      <svg className={`${css.hostPickerChevron} ${expanded ? css.hostPickerChevronOpen : ''}`} width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="m4 6 4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
    <div {...{ popover: 'manual' }} id={popupId} ref={popupRef} role="listbox" aria-label={props.label}
      className={css.hostPickerPopup} hidden={!expanded} onKeyDown={keyDown}>
      {presets.length > 0 ? <div role="group" aria-label="预置域名">{renderRows(presets)}</div> : null}
      {presets.length > 0 && models.length > 0 ? <div role="separator" aria-orientation="horizontal" aria-label="预置域名与模型域名分隔" className={css.hostPickerSeparator} /> : null}
      {models.length > 0 ? <div role="group" aria-label="模型与已保存域名">{renderRows(models)}</div> : null}
      {rows.length === 0 ? <p className={css.hostPickerEmpty}>暂无候选域名，可手工添加</p> : null}
    </div>
  </div>
}
