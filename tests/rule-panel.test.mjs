import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { test } from 'node:test'
import { BUILTIN_DIRECT_HOSTS, BUILTIN_PROXY_GROUPS, BUILTIN_PROXY_HOSTS } from '../lib/index.js'

const plain = value => JSON.parse(JSON.stringify(value))
const proxy = (id, patch = {}) => ({ id, name: `Proxy ${id}`, enabled: true, proxy: 'http://127.0.0.1:7890', proxyHosts: [], ...patch })
const fields = (proxies = [], excludeHosts = []) => ({ proxies, excludeHosts })
const builtinGroups = [{ name: 'DeepSeek', hosts: BUILTIN_DIRECT_HOSTS }, ...BUILTIN_PROXY_GROUPS]
const suggestions = [
  ...builtinGroups.flatMap(group => group.hosts.map(host => ({ host, kind: 'builtin', providers: [group.name] }))),
  { host: 'api.openai.com', kind: 'routable', providers: ['OpenAI'] },
]
const conflict = () => Object.assign(new Error('revision changed in local settings double'), { code: 'settings/conflict' })
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

// Minimal hook runner for the actual built section: no DOM, RPC, or network.
// Identity includes both component type and React key (even a single keyed
// child). Removed/rekeyed components run effect cleanup before new effects.
// This matters for editorEpoch resets and stable card IDs after a deletion;
// an index-only runner can falsely preserve editors or move them to a peer.
function mount(initial, options = {}) {
  let entry, Component, props, current, dirty = true, tree, tasks = [], saved = null
  let remote = plain(initial), readCalls = 0, refreshCalls = 0, disposed = false
  const states = new Map(), types = new WeakMap(), saves = []
  let nextType = 0, visited
  const react = {
    useState(value) {
      const cell = current, i = cell.index++
      if (!(i in cell.values)) cell.values[i] = typeof value === 'function' ? value() : value
      cell.setters ??= []
      cell.setters[i] ??= next => {
        if (!cell.mounted) return
        const value = typeof next === 'function' ? next(cell.values[i]) : next
        if (!Object.is(value, cell.values[i])) { cell.values[i] = value; dirty = true }
      }
      return [cell.values[i], cell.setters[i]]
    },
    useRef(value) { const cell = current, i = cell.index++; return cell.values[i] ??= { current: value } },
    useEffect(fn, deps) {
      const cell = current, i = cell.index++, previous = cell.effects[i]
      if (!previous || !deps || deps.length !== previous.deps?.length || deps.some((value, j) => !Object.is(value, previous.deps[j]))) {
        tasks.push(() => {
          if (!cell.mounted) return
          previous?.cleanup?.()
          cell.effects[i] = { deps: deps?.slice(), cleanup: fn() }
        })
      }
    },
  }
  const jsx = (type, props, key) => ({ type, props: props ?? {}, key })
  const face = {
    read: async () => {
      readCalls++
      const snapshot = remote == null ? remote : { ...plain(remote), suggestions: plain(remote.suggestions ?? suggestions) }
      return options.read ? options.read(snapshot, readCalls) : snapshot
    },
    refreshSuggestions: async snapshot => {
      refreshCalls++
      return options.refresh ? options.refresh(plain(snapshot), refreshCalls) : plain(suggestions)
    },
    save: async snapshot => {
      const value = plain(snapshot)
      saves.push(value)
      await options.save?.(value, saves.length)
      saved = plain(value)
      remote = plain(value)
    },
  }
  vm.runInNewContext(readFileSync('lib/client.js', 'utf8'), {
    URL, console, setTimeout, clearTimeout,
    ...(options.now ? { Date: class extends Date { static now() { return options.now() } } } : {}),
    document: { querySelector: () => ({}), ...options.dom?.document },
    window: { ...options.dom?.window, __ModuleLoader__: { load: value => { entry = value } } },
  })
  assert.ok(entry, 'the built client registers its module')
  entry.factory(name => name === 'react' ? react : { jsx, jsxs: jsx, Fragment: 'fragment' }).apply({
    get: () => undefined,
    slots: { inject: (_name, fn) => fn(), register: (opts, component) => { Component = component; props = { ...opts.inject(), proxyFace: face } } },
  })

  function render(node, path = 'root') {
    if (node == null || typeof node !== 'object') return node
    if (Array.isArray(node)) return node.map((child, i) => render(child, `${path}/${child?.key == null ? `index:${i}` : `key:${encodeURIComponent(child.key)}`}`))
    const identity = `${path}${node.key == null ? '' : `/key:${encodeURIComponent(node.key)}`}`
    if (typeof node.type === 'function') {
      if (!types.has(node.type)) types.set(node.type, ++nextType)
      const address = `${identity}/component:${types.get(node.type)}`
      const cell = states.get(address) ?? { index: 0, values: [], effects: [], mounted: true }
      states.set(address, cell); visited.add(address); cell.index = 0
      const parent = current
      current = cell
      let result
      try { result = node.type(node.props) } finally { current = parent }
      return render(result, `${address}/render`)
    }
    // Most tests deliberately leave refs null. Effect-focused regressions may
    // opt into stable element doubles without a DOM or a ReactDOM dependency.
    if (options.dom?.refs && node.props.ref && typeof node.props.ref === 'object') {
      node.props.ref.current = options.dom.refs[node.props.id] ?? null
    }
    return { ...node, props: { ...node.props, children: render(node.props.children, `${identity}/${node.type}/children`) } }
  }
  function cleanup(cell) {
    cell.mounted = false
    for (const effect of cell.effects) effect?.cleanup?.()
  }
  function unmount() {
    disposed = true
    for (const cell of states.values()) cell.mounted = false
    for (const cell of states.values()) cleanup(cell)
    states.clear(); tasks = []; tree = null
  }
  async function flush() {
    let quiet = 0
    for (let count = 0; count < 60; count++) {
      if (disposed) return
      if (dirty) {
        dirty = false; quiet = 0; visited = new Set()
        tree = render(jsx(Component, props))
        for (const [address, cell] of states) {
          if (!visited.has(address)) { cleanup(cell); states.delete(address) }
        }
        const effectTasks = tasks; tasks = []
        for (const task of effectTasks) task()
      }
      // Several quiet microtask turns allow nested read/save promises to commit
      // without timers, sleeps, or a real React/browser dependency.
      await Promise.resolve(); await Promise.resolve()
      if (!dirty && ++quiet >= 4) return
    }
    throw new Error('render did not settle')
  }
  const flatten = node => Array.isArray(node) ? node.flatMap(flatten) : node && typeof node === 'object' ? [node, ...flatten(node.props?.children)] : []
  const nodes = (scope = tree) => flatten(scope)
  const textOf = node => Array.isArray(node) ? node.map(textOf).join(' ') : node && typeof node === 'object' ? textOf(node.props?.children) : node == null ? '' : String(node)
  const text = (...args) => textOf(args.length === 0 ? tree : args[0])
  const one = (matches, description) => { assert.equal(matches.length, 1, description); return matches[0] }
  const button = (label, scope = tree) => one(nodes(scope).filter(node => node.type === 'button' && (node.props['aria-label'] === label || text(node.props.children) === label)), `one button: ${label}`)
  const cards = () => nodes().filter(node => node.type === 'article' && node.props['data-proxy-card'] !== undefined)
  const card = id => one(cards().filter(node => node.props['data-proxy-card'] === id), `one proxy card: ${id}`)
  const field = (id = 'direct') => one(nodes(id === 'direct' ? tree : card(id)).filter(node => node.type === 'section' && (id === 'direct'
    ? node.props['aria-labelledby'] === 'model-proxy-exclude-heading'
    : node.props['aria-labelledby']?.endsWith('-hosts-heading'))), `one host field: ${id}`)
  const editor = (id = 'direct') => one(nodes(field(id)).filter(node => node.type === 'input' && typeof node.props['aria-label'] === 'string'), `one inline editor: ${id}`)
  const picker = (id = 'direct') => one(nodes(field(id)).filter(node => node.type === 'button' && node.props.role === 'combobox'), `one host picker: ${id}`)
  const popupFor = target => one(nodes().filter(node => node.props.role === 'listbox' && node.props.id === target.props['aria-controls']), `one listbox for ${target.props.id}`)
  const nameInput = id => one(nodes(card(id)).filter(node => node.type === 'input' && node.props.placeholder === '代理名称'), `one name input: ${id}`)
  const urlInput = id => one(nodes(card(id)).filter(node => node.type === 'input' && node.props.id?.endsWith('-url')), `one address input: ${id}`)
  async function click(label, scope = tree) {
    const target = button(label, scope)
    assert.ok(!target.props.disabled, `button is enabled: ${label}`)
    target.props.onClick()
    await flush()
  }
  async function openPicker(id = 'direct') {
    const target = picker(id)
    assert.ok(!target.props.disabled, 'picker is enabled')
    if (!target.props['aria-expanded']) { target.props.onClick(); await flush() }
    assert.equal(picker(id).props['aria-expanded'], true, 'picker opens')
    assert.equal(popupFor(picker(id)).props.hidden, false, 'listbox is visible')
  }
  async function key(target, value) {
    assert.equal(typeof target.props.onKeyDown, 'function', 'target handles keyboard input')
    const event = {
      key: value, prevented: false, stopped: false,
      preventDefault() { this.prevented = true },
      stopPropagation() { this.stopped = true },
    }
    target.props.onKeyDown(event)
    await flush()
    return event
  }
  async function change(target, value) {
    assert.ok(!target.props.disabled, 'input is enabled')
    if (target.props.role === 'combobox') {
      // Existing interaction tests still choose a host, but the custom popup is
      // a sibling of its trigger rather than children of a native select.
      if (!target.props['aria-expanded']) { target.props.onClick(); await flush() }
      const popup = popupFor(target)
      assert.equal(popup.props.hidden, false, 'selection requires an open menu')
      const candidate = one(nodes(popup).filter(node => node.props.role === 'option' && node.props.value === value), `one host option: ${value}`)
      assert.ok(!candidate.props.disabled, `host option is enabled: ${value}`)
      candidate.props.onClick()
    } else {
      target.props.onChange({ target: { value } })
    }
    await flush()
  }
  return { flush, unmount, nodes, text, button, cards, card, field, editor, picker, nameInput, urlInput, click, change, openPicker, key,
    saved: () => saved, saves: () => saves, readCalls: () => readCalls, refreshCalls: () => refreshCalls,
    setRemote: snapshot => { remote = plain(snapshot) },
  }
}

function mounted(t, initial, options) {
  const ui = mount(initial, options)
  t.after(() => ui.unmount())
  return ui
}
async function addHost(ui, id, host) {
  await ui.click('手工添加', ui.field(id))
  await ui.change(ui.editor(id), host)
  await ui.click('确认', ui.field(id))
}
const option = (ui, id, host) => ui.nodes(ui.field(id)).find(node => node.type === 'button' && node.props.role === 'option' && node.props.value === host)
const listbox = (ui, id = 'direct') => {
  const matches = ui.nodes(ui.field(id)).filter(node => node.props.role === 'listbox' && node.props.id === ui.picker(id).props['aria-controls'])
  assert.equal(matches.length, 1, `one controlled listbox: ${id}`)
  return matches[0]
}
const pickerOptions = (ui, id = 'direct') => ui.nodes(listbox(ui, id)).filter(node => node.props.role === 'option')
const activeOption = (ui, id = 'direct') => {
  const active = ui.picker(id).props['aria-activedescendant']
  const matches = pickerOptions(ui, id).filter(node => node.props.id === active)
  assert.equal(matches.length, 1, `one active option: ${id}`)
  assert.equal(matches[0].props.disabled, false, 'keyboard focus never lands on a disabled option')
  return matches[0]
}
const sourceLabel = (ui, node) => {
  const matches = ui.nodes(node).filter(child => child.type === 'span' && ui.text(child).startsWith('来源：'))
  assert.equal(matches.length, 1, 'one source label')
  return ui.text(matches[0]).replace(/^来源：\s*/u, '来源：')
}
const editors = ui => ui.nodes().filter(node => node.type === 'input' && typeof node.props['aria-label'] === 'string')
const alerts = ui => ui.nodes().filter(node => node.props.role === 'alert')
const activeRules = (ui, id = 'direct') => ui.nodes(ui.field(id))
  .filter(node => node.type === 'button' && node.props['aria-label']?.startsWith('删除 '))
  .map(node => node.props['aria-label'].slice('删除 '.length))
const ruleRow = (ui, id, host) => {
  const matches = ui.nodes(ui.field(id)).filter(node => node.type === 'li'
    && ui.nodes(node).some(child => child.type === 'button' && child.props['aria-label'] === `删除 ${host}`))
  assert.equal(matches.length, 1, `one active row for ${host}`)
  return matches[0]
}

test('fresh {} has exactly one disabled 代理1 with company-labelled author rules; manually added 代理2 starts empty', async t => {
  const ui = mounted(t, {})
  await ui.flush()
  assert.equal(ui.cards().length, 1)
  assert.equal(ui.card('legacy').props['aria-label'], '代理1')
  assert.equal(ui.nameInput('legacy').props.value, '代理1')
  assert.equal(ui.urlInput('legacy').props.value, '')
  assert.equal(ui.button('启用 代理1', ui.card('legacy')).props['aria-checked'], false)
  assert.deepEqual(activeRules(ui), [...BUILTIN_DIRECT_HOSTS])
  assert.deepEqual(activeRules(ui, 'legacy'), [...BUILTIN_PROXY_HOSTS])
  for (const group of builtinGroups) {
    for (const host of group.hosts) {
      const id = group.name === 'DeepSeek' ? 'direct' : 'legacy'
      assert.equal(sourceLabel(ui, ruleRow(ui, id, host)), `来源：${group.name}`, `${host} active rule shows its bare company`)
      const candidate = option(ui, id === 'direct' ? 'legacy' : 'direct', host)
      assert.ok(candidate, `${host} remains a candidate in the other list`)
      assert.ok(ui.nodes(candidate).some(node => node.type === 'span' && ui.text(node) === group.name), `${host} candidate shows its bare company`)
      const added = option(ui, id, host)
      assert.ok(added, `${host} remains visible even in its own active list`)
      assert.equal(added.props.disabled, true)
      assert.ok(ui.nodes(added).some(node => ['span', 'small'].includes(node.type) && ui.text(node) === '已添加'), `${host} clearly reports it has been added`)
    }
  }
  assert.equal(pickerOptions(ui, 'legacy')[0].props.value, '*.openai.com', 'the added OpenAI wildcard is still the first proxy preset')
  assert.equal(pickerOptions(ui, 'legacy')[0].props.disabled, true)
  assert.ok(ui.nodes(option(ui, 'legacy', 'api.openai.com')).some(node => node.type === 'span' && ui.text(node) === 'OpenAI'), 'model candidate retains its provider name')
  assert.doesNotMatch(ui.text(option(ui, 'legacy', 'api.openai.com')), /内置/u)
  for (const host of ['auth.openai.com', '*.google.com', '*.x.com', 'gemini.com', '*.gemini.com']) {
    assert.equal(option(ui, 'legacy', host), undefined, `${host} is not a surprise default candidate`)
  }
  assert.equal(ui.readCalls(), 1)
  assert.equal(ui.refreshCalls(), 1)
  assert.deepEqual(ui.saves(), [], 'initialization and suggestion enrichment do not save defaults')
  assert.equal(ui.button('保存').props.disabled, true)

  await ui.click('＋ 添加代理')
  assert.equal(ui.cards().length, 2)
  const id = ui.cards().find(card => card.props['data-proxy-card'] !== 'legacy').props['data-proxy-card']
  assert.equal(ui.nameInput(id).props.value, '代理2', 'the second card is only created by the user')
  assert.deepEqual(activeRules(ui, id), [])
  assert.deepEqual(activeRules(ui, 'legacy'), [...BUILTIN_PROXY_HOSTS])
  assert.deepEqual(activeRules(ui), [...BUILTIN_DIRECT_HOSTS])
  assert.equal(ui.urlInput(id).props.value, '')
  assert.equal(ui.button('保存').props.disabled, true, 'manually added enabled cards still require a URL')
  await ui.change(ui.urlInput(id), 'http://127.0.0.1:9000')
  await ui.click('保存')
  assert.deepEqual(ui.saved(), fields([
    proxy('legacy', { name: '代理1', enabled: false, proxy: '', proxyHosts: [...BUILTIN_PROXY_HOSTS] }),
    proxy(id, { name: '代理2', proxy: 'http://127.0.0.1:9000', proxyHosts: [] }),
  ], [...BUILTIN_DIRECT_HOSTS]))
})

test('custom pickers expose separate domain/company cells, preset-first groups and a horizontal separator', async t => {
  const ui = mounted(t, fields([proxy('a', { proxyHosts: ['saved.example.com'] })], ['direct.example.com']))
  await ui.flush()
  assert.equal(ui.nodes().filter(node => ['select', 'option'].includes(node.type)).length, 0, 'no native select or concatenated option fallback remains')
  assert.equal(ui.picker().props.id, 'model-proxy-exclude')
  assert.equal(ui.picker().props['aria-label'], '选择全局直连域名')
  assert.equal(ui.picker('a').props.id, 'model-proxy-card-0-hosts')
  assert.equal(ui.picker('a').props['aria-label'], '选择Proxy a · 代理域名')
  for (const id of ['direct', 'a']) {
    const trigger = ui.picker(id)
    assert.equal(trigger.props['aria-haspopup'], 'listbox')
    assert.equal(trigger.props['aria-expanded'], false)
    assert.equal(trigger.props.value, '')
    assert.equal(trigger.props['aria-describedby'], `${trigger.props.id}-hint`)
    assert.equal(listbox(ui, id).props.hidden, true, 'closed popup remains mounted but hidden')
    const structure = ui.nodes(listbox(ui, id)).filter(node => ['group', 'separator'].includes(node.props.role))
    assert.deepEqual(structure.map(node => node.props.role), ['group', 'separator', 'group'])
    assert.equal(structure[0].props['aria-label'], '预置域名')
    assert.equal(structure[1].props['aria-orientation'], 'horizontal')
    assert.equal(structure[2].props['aria-label'], '模型与已保存域名')
    const presets = ui.nodes(structure[0]).filter(node => node.props.role === 'option')
    assert.equal(presets[0].props.value, id === 'direct' ? '*.deepseek.com' : '*.openai.com')
    const expected = id === 'direct' ? [...BUILTIN_DIRECT_HOSTS, ...BUILTIN_PROXY_HOSTS] : [...BUILTIN_PROXY_HOSTS, ...BUILTIN_DIRECT_HOSTS]
    assert.deepEqual(presets.map(node => node.props.value), expected, 'author order is stable rather than alphabetical or catalog order')
    const models = ui.nodes(structure[2]).filter(node => node.props.role === 'option')
    assert.deepEqual(models.map(node => node.props.value).sort(), ['api.openai.com', 'direct.example.com', 'saved.example.com'])
    for (const row of pickerOptions(ui, id)) {
      const columns = (Array.isArray(row.props.children) ? row.props.children : [row.props.children]).filter(Boolean)
      assert.equal(columns.length, 2, `${row.props.value} has exactly two top-level cells`)
      assert.ok(columns.every(node => node.type === 'span'), 'domain and company/provider are separate spans')
      assert.equal(ui.text(columns[0]), row.props.value)
      assert.ok(ui.text(columns[1]).trim().length > 0, 'right cell retains a company, provider or saved-source name')
      assert.doesNotMatch(ui.text(columns[1]), /—|内置/u)
      assert.ok(!ui.text(columns[1]).includes(row.props.value), 'right cell is not a concatenated domain label')
      assert.equal(row.props.tabIndex, -1, 'only the combobox trigger participates in tab order')
    }
  }
  const model = option(ui, 'a', 'api.openai.com')
  assert.equal(ui.text(model.props.children[1]).trim(), 'OpenAI', 'model provider is visible in its own right cell')
  assert.doesNotMatch(ui.text(), /内置/u, 'normal fixture text contains no visible builtin label')
  assert.deepEqual(activeRules(ui, 'a'), ['saved.example.com'])
  assert.deepEqual(activeRules(ui), ['direct.example.com'])
  await ui.openPicker('a')
  assert.deepEqual(ui.saves(), [], 'opening and rendering candidates never saves or restores defaults')
  assert.equal(ui.button('保存').props.disabled, true)
})

test('popover effects ignore queued unchanged-anchor and internal scrolls, close on moved anchors and clean up listeners', async t => {
  const documentListeners = new Map(), windowListeners = new Map(), removals = []
  const eventTarget = listeners => ({
    addEventListener(type, listener, capture = false) {
      const key = `${type}:${capture === true}`
      assert.equal(listeners.has(key), false, `no duplicate listener: ${key}`)
      listeners.set(key, listener)
    },
    removeEventListener(type, listener, capture = false) {
      const key = `${type}:${capture === true}`
      assert.equal(listeners.get(key), listener, `cleanup removes the original listener: ${key}`)
      listeners.delete(key)
      removals.push(key)
    },
  })
  const anchor = { top: 439.09375, left: 80 }
  const popupChild = {}, hostScroller = {}
  let shows = 0, hides = 0
  const trigger = {
    getBoundingClientRect: () => ({ ...anchor, width: 360, height: 40, bottom: anchor.top + 40 }),
    focus() {},
  }
  const popup = {
    style: {},
    getBoundingClientRect: () => ({ height: 400 }),
    showPopover() { shows++ },
    hidePopover() { hides++ },
    contains: target => target === popupChild,
  }
  const ui = mounted(t, fields([proxy('a')]), {
    dom: {
      refs: { 'model-proxy-card-0-hosts': trigger, 'model-proxy-card-0-hosts-listbox': popup },
      document: { ...eventTarget(documentListeners), getElementById: () => null },
      window: { ...eventTarget(windowListeners), innerWidth: 1024, innerHeight: 720 },
    },
  })
  const registered = () => {
    assert.deepEqual([...documentListeners.keys()].sort(), ['focusin:true', 'keydown:true', 'pointerdown:true', 'scroll:true'])
    assert.deepEqual([...windowListeners.keys()], ['resize:false'])
  }
  const cleaned = () => {
    assert.equal(documentListeners.size, 0, 'document handlers do not survive closing or unmounting')
    assert.equal(windowListeners.size, 0, 'viewport handlers do not survive closing or unmounting')
  }
  const scroll = async target => {
    const listener = documentListeners.get('scroll:true')
    assert.equal(typeof listener, 'function', 'open menu observes captured host scrolling')
    listener({ target })
    await ui.flush()
  }
  await ui.flush()
  cleaned()
  await ui.openPicker('a')
  registered()
  assert.equal(shows, 1, 'the effect opens the native popover')
  assert.equal(popup.style.position, 'fixed')
  assert.equal(popup.style.width, '360px')
  assert.equal(Number.parseFloat(popup.style.top), anchor.top - 406, 'popup positions above the trigger without a real browser')

  await scroll(hostScroller)
  assert.equal(ui.picker('a').props['aria-expanded'], true, 'a queued host scroll cannot dismiss an already-correctly-anchored popup')
  assert.equal(hides, 0)
  anchor.top += 0.25
  anchor.left += 0.25
  await scroll(hostScroller)
  assert.equal(ui.picker('a').props['aria-expanded'], true, 'subpixel rect jitter is not a meaningful anchor move')
  anchor.top += 12
  await scroll(popup)
  assert.equal(ui.picker('a').props['aria-expanded'], true, 'popup scrolling is ignored even if the host anchor moved')
  await scroll(popupChild)
  assert.equal(ui.picker('a').props['aria-expanded'], true, 'scrolling a descendant of the popup is also ignored')
  await scroll(hostScroller)
  assert.equal(ui.picker('a').props['aria-expanded'], false, 'a real vertical anchor move dismisses the popup')
  assert.equal(listbox(ui, 'a').props.hidden, true)
  assert.equal(hides, 1)
  cleaned()

  await ui.openPicker('a')
  registered()
  anchor.left += 2
  await scroll(hostScroller)
  assert.equal(ui.picker('a').props['aria-expanded'], false, 'a real horizontal anchor move also dismisses the popup')
  assert.equal(hides, 2)
  cleaned()
  await ui.openPicker('a')
  registered()
  assert.equal(shows, 3)
  assert.deepEqual(activeRules(ui, 'a'), [])
  assert.deepEqual(activeRules(ui), [])
  assert.deepEqual(ui.saves(), [], 'positioning and scroll effects never mutate or save routing')
  ui.unmount()
  cleaned()
  assert.equal(hides, 3, 'unmounting an open picker hides its native popover')
  assert.equal(removals.length, 15, 'all five listeners are removed across both closes and final unmount')
})

test('single-group and empty pickers never render a separator or invent missing candidate groups', async t => {
  const cases = [
    { label: '预置域名', rows: [{ host: '*.openai.com', kind: 'builtin', providers: ['OpenAI'] }] },
    { label: '预置域名', rows: [{ host: '*.openai.com', kind: 'builtin', providers: ['OpenAI'] }], active: ['*.openai.com'] },
    { label: '模型与已保存域名', rows: [{ host: 'model.example.com', kind: 'routable', providers: ['Model Provider'] }] },
    { label: null, rows: [] },
  ]
  for (const { label, rows, active = [] } of cases) {
    const ui = mounted(t, fields([proxy('a', { proxyHosts: active })]), {
      read: snapshot => ({ ...snapshot, suggestions: plain(rows) }),
      refresh: () => plain(rows),
    })
    await ui.flush()
    for (const id of ['direct', 'a']) {
      const groups = ui.nodes(listbox(ui, id)).filter(node => node.props.role === 'group')
      assert.deepEqual(groups.map(node => node.props['aria-label']), label === null ? [] : [label])
      assert.equal(ui.nodes(listbox(ui, id)).filter(node => node.props.role === 'separator').length, 0)
      assert.deepEqual(pickerOptions(ui, id).map(node => node.props.value), rows.map(row => row.host))
    }
    await ui.openPicker('a')
    assert.equal(listbox(ui, 'a').props.hidden, false)
    if (pickerOptions(ui, 'a').every(node => node.props.disabled)) {
      for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' ']) {
        await ui.key(ui.picker('a'), key)
        assert.equal(ui.picker('a').props.value, '', 'an empty or wholly unavailable menu cannot select a candidate')
        assert.equal(ui.picker('a').props['aria-activedescendant'], undefined)
      }
      assert.equal(ui.button('添加', ui.field('a')).props.disabled, true)
      await ui.key(ui.picker('a'), 'Escape')
      assert.equal(ui.picker('a').props['aria-expanded'], false)
    }
    assert.deepEqual(activeRules(ui, 'a'), active)
    assert.deepEqual(activeRules(ui), [])
    assert.deepEqual(ui.saves(), [])
  }
})

test('builtin source labels apply only to declared normalized rules, never concrete hosts they match', async t => {
  const hosts = ['  *.OPENAI.COM.  ', 'auth.openai.com', 'api.openai.com', 'openai.com', '*.api.openai.com']
  const ui = mounted(t, fields([proxy('a', { proxyHosts: hosts })], ['api.deepseek.com']))
  await ui.flush()
  assert.equal(sourceLabel(ui, ruleRow(ui, 'a', hosts[0])), '来源：OpenAI')
  assert.match(ui.text(ruleRow(ui, 'a', 'api.openai.com')), /来源：\s*模型目录 · OpenAI/u)
  for (const host of ['auth.openai.com', 'openai.com', '*.api.openai.com']) {
    assert.match(ui.text(ruleRow(ui, 'a', host)), /来源：\s*自定义·已保存/u)
  }
  for (const host of hosts.slice(1)) assert.doesNotMatch(ui.text(ruleRow(ui, 'a', host)), /内置/u, host)
  assert.doesNotMatch(ui.text(ruleRow(ui, 'direct', 'api.deepseek.com')), /内置/u)
  assert.doesNotMatch(ui.text(), /内置/u, 'neither active source rows nor candidate descriptions expose builtin prefixes')
  assert.deepEqual(activeRules(ui, 'a'), hosts, 'source labels never rewrite stored rules')
  assert.deepEqual(ui.saves(), [])
})

test('catalog, fallback and saved active sources retain their names without visible builtin prefixes', async t => {
  const rows = [
    { host: 'api.deepseek.com', kind: 'fallback', providers: ['DeepSeek'] },
    { host: 'configured.example.com', kind: 'configured', providers: ['Private Gateway'] },
    { host: 'model.example.com', kind: 'routable', providers: ['Model One', 'Model Two'] },
  ]
  const hosts = ['*.openai.com', 'api.deepseek.com', 'configured.example.com', 'model.example.com', 'saved.example.com']
  const ui = mounted(t, fields([proxy('a', { proxyHosts: hosts })]), {
    read: snapshot => ({ ...snapshot, suggestions: plain(rows) }),
    refresh: () => plain(rows),
  })
  await ui.flush()
  const expected = ['OpenAI', '目录兜底 · DeepSeek', '已配置·未验证 · Private Gateway', '模型目录 · Model One / Model Two', '自定义·已保存']
  for (const [index, host] of hosts.entries()) {
    assert.equal(sourceLabel(ui, ruleRow(ui, 'a', host)), `来源：${expected[index]}`)
  }
  for (const [host, provider] of [['api.deepseek.com', 'DeepSeek'], ['configured.example.com', 'Private Gateway'], ['model.example.com', 'Model One / Model Two']]) {
    assert.ok(ui.nodes(option(ui, 'a', host)).some(node => node.type === 'span' && ui.text(node) === provider), `${host} retains provider text in the picker`)
  }
  assert.doesNotMatch(ui.text(), /内置/u)
  assert.deepEqual(activeRules(ui, 'a'), hosts, 'labels never rewrite rules or insert author defaults')
  assert.deepEqual(ui.saves(), [])
})

test('DeepSeek account and API adapter labels collapse to one company without removing routes or changing other providers', async t => {
  for (const providers of [['DeepSeek', 'DeepSeek Account'], ['DeepSeek Account'], ['deepseek-account', 'DeepSeek', 'deepseek-official']]) {
    const rows = [
      { host: 'api.deepseek.com', kind: 'routable', providers },
      { host: 'gateway.example.com', kind: 'routable', providers: ['Account Gateway'] },
    ]
    const before = plain(rows)
    const hosts = ['api.deepseek.com', 'gateway.example.com']
    const ui = mounted(t, fields([proxy('a', { proxyHosts: hosts })]), {
      read: snapshot => ({ ...snapshot, suggestions: plain(rows) }),
      refresh: () => plain(rows),
    })
    await ui.flush()
    for (const id of ['direct', 'a']) {
      const candidate = option(ui, id, 'api.deepseek.com')
      const cells = ui.nodes(candidate).filter(node => node.type === 'span')
      assert.ok(cells.some(node => ui.text(node) === 'DeepSeek'), 'right column shows only the company')
      assert.doesNotMatch(ui.text(candidate), /Account|official/iu)
      assert.doesNotMatch(candidate.props['aria-label'], /Account|official/iu)
    }
    assert.equal(sourceLabel(ui, ruleRow(ui, 'a', 'api.deepseek.com')), '来源：模型目录 · DeepSeek')
    assert.ok(ui.text(option(ui, 'a', 'gateway.example.com')).includes('Account Gateway'), 'unrelated user labels remain untouched')
    assert.deepEqual(rows, before, 'presentation never edits the catalog adapter names')
    assert.deepEqual(activeRules(ui, 'a'), hosts)
    assert.deepEqual(ui.saves(), [])
  }
})

test('added and exact peer-owned presets stay visible but unselectable; opposite-list overlaps remain staged choices', async t => {
  const own = '  *.OPENAI.COM.  '
  const ui = mounted(t, fields([
    proxy('a', { name: 'Alpha', proxyHosts: [own] }),
    proxy('b', { name: 'Beta' }),
  ], ['*.deepseek.com']))
  await ui.flush()
  const added = option(ui, 'a', '*.openai.com')
  assert.ok(added, 'an already-added OpenAI wildcard is not hidden')
  assert.equal(added.props.disabled, true)
  assert.match(ui.text(added), /已添加/u)
  const owned = option(ui, 'b', '*.openai.com')
  assert.ok(owned, 'a peer-owned OpenAI wildcard is not hidden')
  assert.equal(owned.props.disabled, true)
  assert.match(ui.text(owned), /已由 Alpha 使用/u)
  assert.equal(option(ui, 'direct', '*.openai.com').props.disabled, false, 'direct rules may overlap an enabled proxy')
  assert.equal(option(ui, 'a', '*.deepseek.com').props.disabled, false, 'proxy rules may overlap a direct rule')

  option(ui, 'a', 'api.openai.com').props.onClick()
  await ui.flush()
  assert.equal(ui.picker('a').props.value, '', 'even an enabled hidden option cannot select')
  assert.equal(ui.picker('a').props['aria-expanded'], false)
  await ui.openPicker('a')
  option(ui, 'a', '*.openai.com').props.onClick()
  await ui.flush()
  assert.equal(ui.picker('a').props.value, '', 'disabled already-added option cannot select')
  assert.equal(ui.picker('a').props['aria-expanded'], true)
  await ui.openPicker('b')
  option(ui, 'b', '*.openai.com').props.onClick()
  await ui.flush()
  assert.equal(ui.picker('b').props.value, '', 'disabled peer-owned option cannot select')
  assert.equal(ui.picker('b').props['aria-expanded'], true)
  assert.deepEqual(activeRules(ui, 'a'), [own])
  assert.deepEqual(activeRules(ui, 'b'), [])
  assert.deepEqual(activeRules(ui), ['*.deepseek.com'])
  assert.deepEqual(ui.saves(), [])
  assert.equal(ui.button('保存').props.disabled, true, 'menu interactions alone do not dirty the document')

  await ui.change(ui.picker('a'), '*.deepseek.com')
  assert.equal(ui.picker('a').props.value, '*.deepseek.com')
  assert.equal(ui.picker('a').props['aria-expanded'], false, 'choosing closes the menu')
  assert.equal(listbox(ui, 'a').props.hidden, true)
  assert.deepEqual(activeRules(ui, 'a'), [own], 'choosing a candidate is not adding a rule')
  assert.equal(ui.button('保存').props.disabled, true)
  await ui.click('添加', ui.field('a'))
  assert.deepEqual(activeRules(ui, 'a'), [own, '*.deepseek.com'])
  assert.equal(ui.picker('a').props.value, '', 'explicit Add clears just this picker')
  assert.equal(option(ui, 'a', '*.deepseek.com').props.disabled, true)
  assert.match(ui.text(option(ui, 'a', '*.deepseek.com')), /已添加/u)
  assert.match(ui.text(ruleRow(ui, 'a', '*.deepseek.com')), /被全局直连规则覆盖/u)
  await ui.change(ui.picker(), '*.openai.com')
  await ui.click('添加', ui.field())
  assert.deepEqual(activeRules(ui), ['*.deepseek.com', '*.openai.com'])
  assert.equal(alerts(ui).length, 0, 'global overlaps never become proxy ownership conflicts')
  assert.deepEqual(ui.saves(), [], 'both choosing and adding remain local until explicit Save')
  await ui.click('保存')
  assert.deepEqual(ui.saved(), fields([
    proxy('a', { name: 'Alpha', proxyHosts: [own, '*.deepseek.com'] }),
    proxy('b', { name: 'Beta' }),
  ], ['*.deepseek.com', '*.openai.com']))
})

test('keyboard navigation skips unavailable rows, selects only on Enter or Space and never adds or saves', async t => {
  const ui = mounted(t, fields([
    proxy('a', { name: 'Alpha', proxyHosts: ['*.anthropic.com'] }),
    proxy('b', { name: 'Beta', proxyHosts: ['*.openai.com'] }),
  ]))
  await ui.flush()
  const enabled = pickerOptions(ui, 'b').filter(node => !node.props.disabled).map(node => node.props.value)
  assert.ok(enabled.length > 2)
  const down = await ui.key(ui.picker('b'), 'ArrowDown')
  assert.equal(down.prevented, true)
  assert.equal(ui.picker('b').props['aria-expanded'], true)
  assert.equal(activeOption(ui, 'b').props.value, enabled[0], 'opening ArrowDown starts with the first enabled row')
  await ui.key(ui.picker('b'), 'ArrowDown')
  assert.equal(activeOption(ui, 'b').props.value, enabled[1], 'ArrowDown skips peer-owned and already-added rows')
  await ui.key(ui.picker('b'), 'ArrowUp')
  assert.equal(activeOption(ui, 'b').props.value, enabled[0])
  await ui.key(ui.picker('b'), 'End')
  assert.equal(activeOption(ui, 'b').props.value, enabled.at(-1))
  await ui.key(ui.picker('b'), 'ArrowDown')
  assert.equal(activeOption(ui, 'b').props.value, enabled[0], 'forward navigation wraps')
  await ui.key(ui.picker('b'), 'ArrowUp')
  assert.equal(activeOption(ui, 'b').props.value, enabled.at(-1), 'backward navigation wraps')
  await ui.key(ui.picker('b'), 'Home')
  assert.equal(activeOption(ui, 'b').props.value, enabled[0])
  assert.equal(ui.picker('b').props.value, '', 'navigation alone does not commit a selected value')
  assert.deepEqual(activeRules(ui, 'b'), ['*.openai.com'])
  assert.equal(ui.button('保存').props.disabled, true)
  assert.deepEqual(ui.saves(), [])

  await ui.key(ui.picker('b'), 'Enter')
  assert.equal(ui.picker('b').props.value, enabled[0])
  assert.equal(ui.picker('b').props['aria-expanded'], false)
  assert.equal(ui.picker('b').props['aria-activedescendant'], undefined)
  assert.equal(option(ui, 'b', enabled[0]).props['aria-selected'], true)
  assert.equal(ui.button('添加', ui.field('b')).props.disabled, false)
  assert.equal(ui.button('保存').props.disabled, true, 'keyboard selection is still not an effective-list edit')
  await ui.change(ui.nameInput('b'), 'Beta revised')
  assert.equal(ui.picker('b').props.value, enabled[0], 'selection survives parent rerenders')
  assert.equal(ui.picker('b').props['aria-label'], '选择Beta revised · 代理域名')
  await ui.key(ui.picker('b'), 'ArrowUp')
  assert.equal(activeOption(ui, 'b').props.value, enabled[0], 'reopening navigates from the selected enabled row')
  await ui.key(ui.picker('b'), 'End')
  const escape = await ui.key(ui.picker('b'), 'Escape')
  assert.equal(escape.prevented, true)
  assert.equal(escape.stopped, true, 'Escape does not dismiss the containing settings dialog')
  assert.equal(ui.picker('b').props['aria-expanded'], false)
  assert.equal(listbox(ui, 'b').props.hidden, true)
  assert.equal(ui.picker('b').props.value, enabled[0], 'Escape discards navigation, not the prior selection')
  await ui.openPicker('b')
  const tab = await ui.key(ui.picker('b'), 'Tab')
  assert.equal(tab.prevented, false, 'Tab keeps the normal focus traversal')
  assert.equal(ui.picker('b').props['aria-expanded'], false)
  assert.equal(ui.picker('b').props.value, enabled[0])
  await ui.key(ui.picker('b'), ' ')
  assert.equal(ui.picker('b').props['aria-expanded'], true, 'Space opens a closed picker')
  await ui.key(ui.picker('b'), 'End')
  await ui.key(ui.picker('b'), ' ')
  assert.equal(ui.picker('b').props.value, enabled.at(-1), 'Space chooses the active enabled row')
  assert.equal(ui.picker('b').props['aria-expanded'], false)
  assert.deepEqual(activeRules(ui, 'b'), ['*.openai.com'], 'even repeated keyboard selections still need Add')
  assert.deepEqual(ui.saves(), [])

  const lastForA = pickerOptions(ui, 'a').filter(node => !node.props.disabled).at(-1).props.value
  await ui.key(ui.picker('a'), 'ArrowUp')
  assert.equal(activeOption(ui, 'a').props.value, lastForA, 'opening ArrowUp starts with the last enabled row when no candidate is selected')
  await ui.key(ui.picker('a'), 'Escape')
  await ui.click('添加', ui.field('b'))
  assert.deepEqual(activeRules(ui, 'b'), ['*.openai.com', enabled.at(-1)])
  assert.deepEqual(ui.saves(), [], 'Add changes only the staged draft')
})

test('keyboard typeahead matches enabled domains and provider prefixes, resets after 700ms and restarts on a new character', async t => {
  let now = 1000
  const rows = [
    { host: '*.openai.com', kind: 'builtin', providers: ['OpenAI'] },
    { host: 'aardvark.example.com', kind: 'routable', providers: ['Aardvark Gateway'] },
    { host: 'alpha.example.com', kind: 'routable', providers: ['Amber Gateway'] },
    { host: 'alpine.example.com', kind: 'routable', providers: ['Boreal Gateway'] },
    { host: 'beta.example.com', kind: 'routable', providers: ['Cobalt Provider'] },
  ]
  const ui = mounted(t, fields([proxy('a', { proxyHosts: ['aardvark.example.com'] })]), {
    now: () => now,
    read: snapshot => ({ ...snapshot, suggestions: plain(rows) }),
    refresh: () => plain(rows),
  })
  await ui.flush()
  await ui.openPicker('a')
  const type = async value => { now += 100; return ui.key(ui.picker('a'), value) }
  const first = await type('a')
  assert.equal(first.prevented, true)
  assert.equal(activeOption(ui, 'a').props.value, 'alpha.example.com', 'a disabled earlier matching domain is skipped')
  await type('l')
  await type('p')
  await type('i')
  assert.equal(activeOption(ui, 'a').props.value, 'alpine.example.com', 'rapid characters accumulate as a domain prefix')
  await type('c')
  assert.equal(activeOption(ui, 'a').props.value, 'beta.example.com', 'an unmatched accumulated prefix falls back to the current provider character')
  await type('o')
  assert.equal(activeOption(ui, 'a').props.value, 'beta.example.com', 'the restarted prefix continues from the matching fallback character')
  now += 701
  const openai = await type('O')
  assert.equal(openai.prevented, true)
  assert.equal(activeOption(ui, 'a').props.value, '*.openai.com', 'timeout resets the prefix; matching is case-insensitive and ignores the leading wildcard')
  const unhandled = await type('z')
  assert.equal(unhandled.prevented, false, 'an unmatched character is left to the browser')
  assert.equal(activeOption(ui, 'a').props.value, '*.openai.com')
  assert.equal(ui.picker('a').props.value, '', 'typeahead only navigates until Enter or Space')
  assert.deepEqual(activeRules(ui, 'a'), ['aardvark.example.com'])
  assert.deepEqual(ui.saves(), [])
  assert.equal(ui.button('保存').props.disabled, true)
  await ui.key(ui.picker('a'), 'Enter')
  assert.equal(ui.picker('a').props.value, '*.openai.com')
  assert.deepEqual(activeRules(ui, 'a'), ['aardvark.example.com'], 'typeahead selection still needs Add')
  assert.deepEqual(ui.saves(), [])
})

test('a selected candidate stays displayed when an enabled peer owns it, while Add stays guarded', async t => {
  const ui = mounted(t, fields([
    proxy('a', { name: 'Alpha' }),
    proxy('b', { name: 'Beta' }),
  ]))
  await ui.flush()
  await ui.change(ui.picker('b'), '*.openai.com')
  assert.equal(ui.picker('b').props.value, '*.openai.com')
  assert.equal(ui.button('添加', ui.field('b')).props.disabled, false)
  await addHost(ui, 'a', '*.openai.com')
  assert.equal(ui.picker('b').props.value, '*.openai.com', 'availability changes do not silently clear the selected display')
  assert.equal(option(ui, 'b', '*.openai.com').props.disabled, true)
  assert.equal(option(ui, 'b', '*.openai.com').props['aria-selected'], true)
  assert.match(ui.text(option(ui, 'b', '*.openai.com')), /已由 Alpha 使用/u)
  assert.equal(ui.button('添加', ui.field('b')).props.disabled, true)
  ui.button('添加', ui.field('b')).props.onClick()
  await ui.flush()
  assert.deepEqual(activeRules(ui, 'b'), [], 'a disabled Add handler cannot add the now-owned selected candidate')
  await ui.change(ui.nameInput('a'), 'Alpha renamed')
  assert.equal(ui.picker('b').props.value, '*.openai.com')
  assert.match(ui.text(option(ui, 'b', '*.openai.com')), /已由 Alpha renamed 使用/u)
  await ui.click('启用 Alpha renamed', ui.card('a'))
  assert.equal(option(ui, 'b', '*.openai.com').props.disabled, false)
  assert.equal(ui.picker('b').props.value, '*.openai.com')
  assert.equal(ui.button('添加', ui.field('b')).props.disabled, false)
  await ui.click('添加', ui.field('b'))
  assert.deepEqual(activeRules(ui, 'b'), ['*.openai.com'])
  assert.deepEqual(ui.saves(), [], 'ownership changes never trigger an automatic save')
})

test('deleting author rules and every card never reinserts defaults, including the next manually created card', async t => {
  const ui = mounted(t, {})
  await ui.flush()
  for (const host of BUILTIN_PROXY_HOSTS) await ui.click(`删除 ${host}`, ui.field('legacy'))
  for (const host of BUILTIN_DIRECT_HOSTS) await ui.click(`删除 ${host}`, ui.field())
  assert.deepEqual(activeRules(ui, 'legacy'), [])
  assert.deepEqual(activeRules(ui), [])
  for (const host of BUILTIN_PROXY_HOSTS) assert.ok(option(ui, 'legacy', host), `${host} is now only a candidate`)
  assert.deepEqual(ui.saves(), [], 'deleting defaults remains staged until an explicit save')
  await ui.click('保存')
  assert.deepEqual(ui.saved().proxies[0].proxyHosts, [])
  assert.deepEqual(ui.saved().excludeHosts, [])
  await ui.click('＋ 添加代理')
  const second = ui.cards().find(card => card.props['data-proxy-card'] !== 'legacy').props['data-proxy-card']
  assert.equal(ui.nameInput(second).props.value, '代理2')
  assert.deepEqual(activeRules(ui, second), [])
  await ui.change(ui.urlInput(second), 'http://127.0.0.1:9000')
  await ui.click('保存')
  assert.deepEqual(ui.saved().proxies.map(entry => entry.proxyHosts), [[], []])
  for (const [id, name] of [['legacy', '代理1'], [second, '代理2']]) {
    await ui.click(`删除代理 ${name}`, ui.card(id))
    await ui.click('确认删除', ui.card(id))
  }
  assert.equal(ui.cards().length, 0)
  assert.deepEqual(activeRules(ui), [])
  await ui.click('保存')
  assert.deepEqual(ui.saved(), fields())
  await ui.click('＋ 添加代理')
  const next = ui.cards()[0].props['data-proxy-card']
  assert.notEqual(next, 'legacy', 'a manually created card never re-enters legacy initialization')
  assert.equal(ui.nameInput(next).props.value, '代理1')
  assert.deepEqual(activeRules(ui, next), [], 'even adding the first card to an empty document uses no inferred rules')
  assert.deepEqual(activeRules(ui), [], 'deleted direct defaults are not restored either')
  await ui.change(ui.urlInput(next), 'http://127.0.0.1:9001')
  await ui.click('保存')
  assert.deepEqual(ui.saved().proxies[0].proxyHosts, [])
  assert.deepEqual(ui.saved().excludeHosts, [])
})

test('global section appears once before proxy cards; legacy rules retain source and explicit-list editing', async t => {
  const ui = mounted(t, { proxy: 'http://127.0.0.1:7890', proxyHosts: ['auth.openai.com'], excludeHosts: [] })
  await ui.flush()
  const headings = ui.nodes().filter(node => node.type === 'h2').map(node => ui.text(node))
  assert.equal(headings.filter(label => label === '全局直连域名').length, 1)
  assert.ok(headings.indexOf('全局直连域名') < headings.findIndex(label => label.startsWith('代理配置')))
  assert.ok(headings.indexOf('全局直连域名') < headings.indexOf('代理域名'))
  assert.equal(ui.cards().length, 1)
  assert.equal(ui.card('legacy').props['aria-label'], '代理1')
  assert.match(ui.text(ruleRow(ui, 'legacy', 'auth.openai.com')), /来源：\s*自定义·已保存/u)
  assert.doesNotMatch(ui.text(ruleRow(ui, 'legacy', 'auth.openai.com')), /内置/u)
  assert.match(ui.text(), /不关闭系统代理、VPN 或 TUN/u)
  assert.equal(ui.button('保存').props.disabled, true)

  await ui.click('手工添加', ui.field())
  assert.equal(ui.editor().props['aria-label'], '全局直连域名手工添加域名')
  await ui.change(ui.editor(), '.openai.com')
  await ui.click('确认', ui.field())
  assert.match(ui.text(), /旧 .host/u)
  assert.equal(ui.button('保存').props.disabled, true)
  await ui.change(ui.editor(), '*.openai.com')
  await ui.click('确认', ui.field())
  assert.match(ui.text(ui.field('legacy')), /被全局直连规则覆盖/u)
  assert.equal(ui.button('保存').props.disabled, false)
  assert.equal(ui.saved(), null)
  await ui.click('保存')
  assert.deepEqual(ui.saved().excludeHosts, ['*.openai.com'])

  await ui.click('编辑 *.openai.com', ui.field())
  await ui.change(ui.editor(), 'api.openai.com')
  await ui.click('确认', ui.field())
  await ui.click('删除 auth.openai.com', ui.field('legacy'))
  assert.match(ui.text(ui.field('legacy')), /暂无代理规则，此卡片不代理任何域名/u)
  assert.doesNotMatch(ui.text(ui.card('legacy')), /所有请求直连|所有请求使用本机默认网络/u)
  assert.ok(option(ui, 'legacy', 'auth.openai.com'), 'removed explicit saved auth rule remains selectable, not active')
  assert.match(ui.text(option(ui, 'legacy', 'auth.openai.com')), /自定义·已保存/u)
  await ui.click('保存')
  assert.deepEqual(ui.saved().proxies[0].proxyHosts, [])
  assert.deepEqual(ui.saved().excludeHosts, ['api.openai.com'])
})

test('multiple cards add, rename, toggle and preserve editable disabled drafts until unified save', async t => {
  const initial = fields([
    proxy('a', { name: 'Primary', proxyHosts: ['a.example.com'] }),
    proxy('b', { name: 'Paused', enabled: false, proxy: '', proxyHosts: ['paused.example.com'] }),
    proxy('c', { name: 'Third', proxyHosts: ['c.example.com'] }),
  ])
  const ui = mounted(t, initial)
  await ui.flush()
  assert.deepEqual(ui.cards().map(card => card.props['data-proxy-card']), ['a', 'b', 'c'])
  assert.equal(ui.nodes().filter(node => node.type === 'h2' && ui.text(node) === '全局直连域名').length, 1)
  assert.match(ui.text(ui.card('b')), /已停用，配置保留/u)
  assert.equal(ui.urlInput('b').props.disabled, false)

  await ui.click('＋ 添加代理')
  const id = ui.cards().map(card => card.props['data-proxy-card']).find(id => !['a', 'b', 'c'].includes(id))
  assert.equal(typeof id, 'string')
  assert.ok(id.length > 0)
  assert.equal(new Set(ui.cards().map(card => card.props['data-proxy-card'])).size, 4)
  assert.match(ui.text(ui.field(id)), /此卡片不代理任何域名/u)
  assert.deepEqual(activeRules(ui, id), [], 'new cards never inherit any default active hosts')
  assert.equal(ui.urlInput(id).props.value, '')
  assert.equal(ui.button('保存').props.disabled, true, 'an enabled new card needs an address')

  await ui.change(ui.nameInput(id), 'Fourth')
  await ui.change(ui.urlInput(id), 'socks5://127.0.0.1:1080')
  await ui.change(ui.nameInput('a'), '  Renamed Primary  ')
  await ui.change(ui.urlInput('a'), '  http://127.0.0.1:9000  ')
  await ui.change(ui.nameInput('b'), 'Paused edited')
  await ui.change(ui.urlInput('b'), 'unfinished disabled address')
  await addHost(ui, 'b', 'disabled-new.example.com')
  await ui.click('启用 Third', ui.card('c'))
  assert.equal(ui.button('启用 Third', ui.card('c')).props['aria-checked'], false)
  await addHost(ui, 'direct', 'direct.example.com')
  assert.equal(ui.saves().length, 0, 'all card and global edits are staged')
  await ui.click('保存')
  assert.deepEqual(ui.saved(), fields([
    proxy('a', { name: 'Renamed Primary', proxy: 'http://127.0.0.1:9000', proxyHosts: ['a.example.com'] }),
    proxy('b', { name: 'Paused edited', enabled: false, proxy: 'unfinished disabled address', proxyHosts: ['paused.example.com', 'disabled-new.example.com'] }),
    proxy('c', { name: 'Third', enabled: false, proxyHosts: ['c.example.com'] }),
    proxy(id, { name: 'Fourth', proxy: 'socks5://127.0.0.1:1080' }),
  ], ['direct.example.com']))
  assert.equal(ui.nameInput('a').props.value, 'Renamed Primary')
  assert.equal(ui.button('保存').props.disabled, true)
})

test('delete is a staged two-step confirmation that blocks save and can be cancelled or reverted', async t => {
  const initial = fields([proxy('a', { name: 'Alpha' }), proxy('b', { name: 'Beta' })])
  const ui = mounted(t, initial)
  await ui.flush()
  await ui.change(ui.urlInput('b'), 'http://127.0.0.1:9000')
  await ui.click('删除代理 Alpha', ui.card('a'))
  assert.equal(ui.cards().length, 2, 'requesting deletion does not remove a card')
  assert.equal(ui.nodes().filter(node => node.props.role === 'alertdialog').length, 1)
  assert.match(ui.text(), /保存后才会移除该代理/u)
  assert.equal(ui.button('保存').props.disabled, true)
  assert.equal(ui.button('＋ 添加代理').props.disabled, true)
  assert.equal(ui.button('删除代理 Beta', ui.card('b')).props.disabled, true)
  ui.button('保存').props.onClick(); await ui.flush()
  assert.equal(ui.saves().length, 0, 'the save handler also guards pending confirmation')
  await ui.click('取消删除', ui.card('a'))
  assert.equal(ui.cards().length, 2)
  assert.equal(ui.button('保存').props.disabled, false)
  await ui.click('删除代理 Alpha', ui.card('a'))
  await ui.click('确认删除', ui.card('a'))
  assert.deepEqual(ui.cards().map(card => card.props['data-proxy-card']), ['b'])
  assert.equal(ui.saves().length, 0)
  await ui.click('撤销修改')
  assert.deepEqual(ui.cards().map(card => card.props['data-proxy-card']), ['a', 'b'])
  assert.equal(ui.urlInput('b').props.value, initial.proxies[1].proxy)
  assert.equal(ui.nodes().filter(node => node.props.role === 'alertdialog').length, 0)
  await ui.click('删除代理 Alpha', ui.card('a'))
  await ui.click('确认删除', ui.card('a'))
  await ui.click('保存')
  assert.deepEqual(ui.saved().proxies.map(entry => entry.id), ['b'])
})

test('two simultaneous inline editors independently block save; whole-draft revert remounts every editor', async t => {
  const initial = fields([proxy('a', { name: 'Alpha' }), proxy('b', { name: 'Beta' })], ['original.example.com'])
  const ui = mounted(t, initial)
  await ui.flush()
  await ui.change(ui.nameInput('a'), 'Alpha revised')
  await ui.click('手工添加', ui.field('a'))
  await ui.change(ui.editor('a'), 'one.example.com')
  await ui.click('手工添加', ui.field('b'))
  await ui.change(ui.editor('b'), 'two.example.com')
  assert.equal(editors(ui).length, 2)
  assert.equal(ui.editor('a').props['aria-label'], 'Alpha revised · 代理域名手工添加域名')
  assert.equal(ui.editor('b').props['aria-label'], 'Beta · 代理域名手工添加域名')
  assert.equal(ui.button('保存').props.disabled, true)
  assert.match(ui.text(), /请先确认或取消正在编辑的域名/u)
  ui.button('保存').props.onClick(); await ui.flush()
  assert.equal(ui.saves().length, 0)
  await ui.click('确认', ui.field('a'))
  assert.equal(editors(ui).length, 1)
  assert.equal(ui.editor('b').props.value, 'two.example.com')
  assert.equal(ui.button('保存').props.disabled, true, 'confirming one editor cannot clear the other editor flag')
  await ui.click('取消', ui.field('b'))
  assert.equal(ui.button('保存').props.disabled, false)

  await ui.click('手工添加', ui.field('b'))
  await ui.change(ui.editor('b'), 'discard-b.example.com')
  await ui.click('手工添加', ui.field())
  await ui.change(ui.editor(), 'discard-direct.example.com')
  await ui.click('撤销修改')
  assert.equal(editors(ui).length, 0, 'editorEpoch must reset single keyed children too')
  assert.equal(ui.nameInput('a').props.value, 'Alpha')
  assert.doesNotMatch(ui.text(ui.field('a')), /one.example.com/u)
  assert.doesNotMatch(ui.text(), /discard-b.example.com|discard-direct.example.com/u)
  assert.match(ui.text(ui.field()), /original.example.com/u)
  assert.equal(ui.button('保存').props.disabled, true)
  assert.equal(ui.saves().length, 0)
  await addHost(ui, 'b', 'fresh.example.com')
  assert.equal(ui.button('保存').props.disabled, false, 'unmount cleanup must not leave a stale editor blocker')
})

test('a proxy ID named direct cannot collide with the global inline-editor save blocker', async t => {
  const ui = mounted(t, fields([proxy('direct', { name: 'Direct ID' })]))
  await ui.flush()
  await ui.change(ui.nameInput('direct'), 'Direct ID revised')
  // field('direct') deliberately denotes the global field in this test runner;
  // locate this valid manually supplied card ID within its article instead.
  const cardField = () => {
    const matches = ui.nodes(ui.card('direct')).filter(node => node.type === 'section' && node.props['aria-labelledby']?.endsWith('-hosts-heading'))
    assert.equal(matches.length, 1)
    return matches[0]
  }
  const cardEditor = () => {
    const matches = ui.nodes(cardField()).filter(node => node.type === 'input' && typeof node.props['aria-label'] === 'string')
    assert.equal(matches.length, 1)
    return matches[0]
  }
  await ui.click('手工添加', ui.field())
  await ui.change(ui.editor(), 'global-draft.example.com')
  await ui.click('手工添加', cardField())
  await ui.change(cardEditor(), 'card-draft.example.com')
  assert.equal(editors(ui).length, 2)
  assert.equal(ui.button('保存').props.disabled, true)
  await ui.click('取消', ui.field())
  assert.equal(editors(ui).length, 1)
  assert.equal(cardEditor().props.value, 'card-draft.example.com')
  assert.equal(ui.button('保存').props.disabled, true, 'cancelling the global editor must not clear the card editor blocker')
  ui.button('保存').props.onClick(); await ui.flush()
  assert.equal(ui.saves().length, 0)
  await ui.click('确认', cardField())
  assert.equal(editors(ui).length, 0)
  assert.equal(ui.button('保存').props.disabled, false)
  assert.equal(ui.saves().length, 0, 'confirming editors still only stages changes')
})

test('revert is available for unconfirmed editor text and pending deletion even with no committed draft changes', async t => {
  const ui = mounted(t, fields([proxy('a', { name: 'Alpha' })]))
  await ui.flush()
  await ui.click('手工添加', ui.field())
  await ui.change(ui.editor(), 'unconfirmed.example.com')
  assert.equal(ui.button('撤销修改').props.disabled, false)
  await ui.click('撤销修改')
  assert.equal(editors(ui).length, 0)
  assert.equal(ui.button('撤销修改').props.disabled, true)
  await ui.click('删除代理 Alpha', ui.card('a'))
  await ui.click('撤销修改')
  assert.equal(ui.cards().length, 1)
  assert.equal(ui.nodes().filter(node => node.props.role === 'alertdialog').length, 0)
  assert.equal(ui.button('撤销修改').props.disabled, true)
})

test('stable card keys preserve the surviving picker when an earlier card is deleted', async t => {
  const ui = mounted(t, fields([proxy('a', { name: 'Alpha' }), proxy('b', { name: 'Beta' })]))
  await ui.flush()
  await ui.change(ui.picker('b'), 'api.openai.com')
  assert.equal(ui.picker('b').props.value, 'api.openai.com')
  await ui.click('删除代理 Alpha', ui.card('a'))
  await ui.click('确认删除', ui.card('a'))
  assert.equal(ui.card('b').props['data-proxy-card'], 'b')
  assert.equal(ui.picker('b').props.value, 'api.openai.com', 'identity is the card ID, not its new array index')
  await ui.click('添加', ui.field('b'))
  await ui.click('保存')
  assert.deepEqual(ui.saved().proxies, [proxy('b', { name: 'Beta', proxyHosts: ['api.openai.com'] })])
})

test('global exclusions neutrally cover all cards, never become cross-proxy errors', async t => {
  const ui = mounted(t, fields([
    proxy('a', { proxyHosts: ['api.example.com'] }),
    proxy('b', { proxyHosts: ['*.team.example.com'] }),
    proxy('c', { enabled: false, proxyHosts: ['disabled.example.com'] }),
  ]))
  await ui.flush()
  await addHost(ui, 'direct', '*.example.com')
  for (const id of ['a', 'b', 'c']) assert.match(ui.text(ui.field(id)), /被全局直连规则覆盖 · 使用本机默认网络/u)
  assert.match(ui.text(ui.field()), /此直连规则优先于代理卡片/u)
  assert.equal(alerts(ui).length, 0)
  assert.equal(ui.button('保存').props.disabled, false)
  await ui.click('保存')
  assert.deepEqual(ui.saved().excludeHosts, ['*.example.com'])
  assert.equal(ui.saved().proxies.length, 3)
})

test('identical normalized rules show per-card conflict alerts and block save until a duplicate is disabled', async t => {
  const ui = mounted(t, fields([
    proxy('a', { name: 'Alpha', proxyHosts: ['https://API.Example.com.:443/v1'] }),
    proxy('b', { name: 'Beta' }),
  ], ['api.example.com']))
  await ui.flush()
  await addHost(ui, 'b', 'API.Example.com.:443')
  assert.equal(alerts(ui).length, 2)
  assert.ok(alerts(ui).every(node => /ruleConflict/u.test(node.props.className)), 'conflict alerts use the red ruleConflict styling hook')
  assert.match(ui.text(ui.field('a')), /此规则已配置到「Beta」/u)
  assert.match(ui.text(ui.field('b')), /此规则已配置到「Alpha」/u)
  assert.equal(ui.button('保存').props.disabled, true)
  ui.button('保存').props.onClick(); await ui.flush()
  assert.equal(ui.saves().length, 0)
  await ui.click('启用 Beta', ui.card('b'))
  assert.equal(alerts(ui).length, 0)
  assert.equal(ui.button('保存').props.disabled, false)
  await ui.click('保存')
  assert.equal(ui.saved().proxies[1].enabled, false)
  assert.deepEqual(ui.saved().proxies[1].proxyHosts, ['api.example.com'])
  assert.deepEqual(ui.saved().excludeHosts, ['api.example.com'])
})

test('exact versus wildcard rules are allowed; active peer ownership only disables identical picker options', async t => {
  const ui = mounted(t, fields([
    proxy('a', { name: 'Alpha', proxyHosts: ['*.example.com', 'auth.openai.com'] }),
    proxy('b', { name: 'Beta', proxyHosts: ['api.example.com'] }),
  ]))
  await ui.flush()
  await ui.change(ui.nameInput('b'), 'Beta revised')
  assert.equal(alerts(ui).length, 0)
  assert.equal(ui.button('保存').props.disabled, false)
  assert.equal(option(ui, 'b', 'auth.openai.com').props.disabled, true)
  assert.match(ui.text(option(ui, 'b', 'auth.openai.com')), /已由 Alpha 使用/u)
  assert.ok(!option(ui, 'direct', 'auth.openai.com').props.disabled, 'global direct can overlap any proxy')
  await ui.click('启用 Alpha', ui.card('a'))
  assert.equal(option(ui, 'b', 'auth.openai.com').props.disabled, false)
  await ui.change(ui.picker('b'), 'auth.openai.com')
  await ui.click('添加', ui.field('b'))
  await ui.click('保存')
  assert.deepEqual(ui.saved().proxies[1].proxyHosts, ['api.example.com', 'auth.openai.com'])
  assert.deepEqual(ui.saved().proxies[0].proxyHosts, ['*.example.com', 'auth.openai.com'])
})

test('saved custom suggestions survive removal and save, including hosts from disabled cards', async t => {
  const ui = mounted(t, fields([
    proxy('a', { proxyHosts: ['saved.example.com'] }),
    proxy('b', { enabled: false, proxy: '', proxyHosts: ['disabled.example.com'] }),
  ], ['direct.example.com']))
  await ui.flush()
  assert.equal(option(ui, 'a', 'disabled.example.com').props.disabled, false)
  assert.match(ui.text(option(ui, 'a', 'disabled.example.com')), /自定义·已保存/u)
  assert.ok(option(ui, 'a', 'direct.example.com'))
  await ui.click('删除 saved.example.com', ui.field('a'))
  await ui.click('删除 disabled.example.com', ui.field('b'))
  assert.match(ui.text(option(ui, 'a', 'saved.example.com')), /自定义·已保存/u)
  await ui.click('保存')
  assert.deepEqual(ui.saved().proxies.map(entry => entry.proxyHosts), [[], []])
  for (const host of ['saved.example.com', 'disabled.example.com']) {
    assert.match(ui.text(option(ui, 'a', host)), /自定义·已保存/u)
  }
  await addHost(ui, 'a', 'never-saved.example.com')
  await ui.click('删除 never-saved.example.com', ui.field('a'))
  assert.equal(option(ui, 'a', 'never-saved.example.com'), undefined, 'uncommitted rules are not promoted to saved suggestions')
  assert.equal(ui.button('保存').props.disabled, true)
})

test('authoritative empty proxy list remains empty and a new card has no implicit default rules', async t => {
  const ui = mounted(t, { proxies: [], excludeHosts: [], proxy: 'http://obsolete.example.com:8080', proxyHosts: ['obsolete.example.com'] })
  await ui.flush()
  assert.equal(ui.cards().length, 0)
  assert.match(ui.text(), /尚未配置代理/u)
  assert.match(ui.text(), /所有请求使用本机默认网络/u)
  assert.equal(ui.saves().length, 0, 'opening an empty migrated section does not write settings')
  await ui.click('＋ 添加代理')
  const id = ui.cards()[0].props['data-proxy-card']
  assert.match(ui.text(ui.field(id)), /此卡片不代理任何域名/u)
  assert.doesNotMatch(ui.text(ui.card(id)), /所有请求直连|所有请求使用本机默认网络/u)
  assert.ok(option(ui, id, '*.openai.com'))
  assert.deepEqual(activeRules(ui, id), [])
  assert.equal(option(ui, id, 'auth.openai.com'), undefined, 'unsaved auth is not an extra builtin candidate')
  await ui.click(`启用 ${ui.nameInput(id).props.value}`, ui.card(id))
  await ui.click('保存')
  assert.deepEqual(ui.saved().proxies[0].proxyHosts, [])
  assert.equal(ui.saved().proxies[0].enabled, false)
})

test('ordinary save failures retain drafts, allow retry, and revert to the last successful save', async t => {
  const ui = mounted(t, fields([proxy('a', { name: 'Alpha' })]), {
    save: async (_snapshot, attempt) => { if (attempt !== 2) throw new Error('local write failed') },
  })
  await ui.flush()
  await ui.change(ui.urlInput('a'), 'http://127.0.0.1:9000')
  await ui.click('保存')
  assert.match(ui.text(), /local write failed/u)
  assert.equal(ui.urlInput('a').props.value, 'http://127.0.0.1:9000')
  assert.equal(ui.button('保存').props.disabled, false)
  assert.equal(ui.saved(), null)
  await ui.click('保存')
  assert.match(ui.text(), /已保存 ✓/u)
  assert.equal(ui.saved().proxies[0].proxy, 'http://127.0.0.1:9000')
  await ui.change(ui.nameInput('a'), 'Failed rename')
  await ui.click('保存')
  assert.equal(ui.nameInput('a').props.value, 'Failed rename')
  await ui.click('撤销修改')
  assert.equal(ui.nameInput('a').props.value, 'Alpha')
  assert.equal(ui.urlInput('a').props.value, 'http://127.0.0.1:9000')
  assert.equal(ui.button('保存').props.disabled, true)
})

test('an in-flight save disables the document, retains picker selections and never adopts the draft until success', async t => {
  const pending = deferred()
  const ui = mounted(t, fields([proxy('a')]), { save: () => pending.promise })
  await ui.flush()
  await ui.change(ui.picker('a'), 'api.openai.com')
  await ui.change(ui.picker(), '*.openai.com')
  await ui.change(ui.urlInput('a'), 'http://127.0.0.1:9000')
  await ui.openPicker('a')
  await ui.click('保存')
  assert.equal(ui.button('保存中…').props.disabled, true)
  assert.equal(ui.nameInput('a').props.disabled, true)
  assert.equal(ui.urlInput('a').props.disabled, true)
  assert.equal(ui.picker().props.disabled, true)
  assert.equal(ui.picker('a').props.disabled, true)
  assert.equal(ui.picker('a').props['aria-expanded'], false, 'disabling a document closes the popup')
  assert.equal(listbox(ui, 'a').props.hidden, true)
  assert.equal(ui.picker('a').props.value, 'api.openai.com')
  assert.equal(ui.picker().props.value, '*.openai.com')
  ui.picker('a').props.onClick()
  await ui.key(ui.picker('a'), 'ArrowDown')
  await ui.key(ui.picker('a'), 'Enter')
  option(ui, 'a', '*.deepseek.com').props.onClick()
  await ui.flush()
  assert.equal(ui.picker('a').props['aria-expanded'], false, 'disabled click and keyboard handlers cannot reopen the menu')
  assert.equal(ui.picker('a').props.value, 'api.openai.com', 'disabled handlers cannot change the selection')
  assert.deepEqual(activeRules(ui, 'a'), [])
  assert.deepEqual(activeRules(ui), [])
  assert.equal(ui.saves().length, 1)
  assert.deepEqual(ui.saves()[0].proxies[0].proxyHosts, [], 'unadded selections are not included in the in-flight save')
  assert.deepEqual(ui.saves()[0].excludeHosts, [])
  assert.equal(ui.button('撤销修改').props.disabled, true)
  assert.equal(ui.saved(), null)
  pending.resolve()
  await ui.flush()
  assert.equal(ui.saved().proxies[0].proxy, 'http://127.0.0.1:9000')
  assert.equal(ui.nameInput('a').props.disabled, false)
  assert.equal(ui.picker('a').props.disabled, false)
  assert.equal(ui.picker('a').props.value, 'api.openai.com', 'successful saves preserve an unadded selection')
  assert.equal(ui.picker().props.value, '*.openai.com')
  assert.equal(ui.picker('a').props['aria-expanded'], false)
  assert.equal(ui.button('保存').props.disabled, true)
})

test('backend reload errors keep their actionable text and local drafts, block retries, then rebase only after an explicit reread', async t => {
  // The word revision deliberately also matches the conflict classifier: the
  // typed backend-reload error must take precedence and retain its own message.
  const failure = Object.assign(new Error('后端尚未加载新的 revision schema；请重载后端插件。仅刷新网页无效，本次未保存。'), {
    code: 'MODEL_PROXY_BACKEND_RELOAD_REQUIRED',
  })
  const initial = fields([proxy('a', { name: 'Alpha' })], ['old.direct.example.com'])
  const ui = mounted(t, initial, { save: async (_snapshot, attempt) => { if (attempt === 1) throw failure } })
  await ui.flush()
  await ui.change(ui.urlInput('a'), 'http://127.0.0.1:9000')
  await ui.click('保存')
  assert.ok(ui.text().includes(failure.message), 'the original backend instruction is shown, not a generic revision-conflict message')
  assert.equal(ui.saved(), null)
  assert.equal(ui.saves().length, 1)
  assert.equal(ui.readCalls(), 1, 'a failed save never triggers an automatic read or retry')
  assert.equal(ui.button('保存').props.disabled, true)
  assert.equal(ui.button('重新读取并保留草稿').props.disabled, false)
  assert.equal(ui.urlInput('a').props.value, 'http://127.0.0.1:9000')

  await ui.change(ui.nameInput('a'), 'Alpha revised')
  await addHost(ui, 'a', 'staged.example.com')
  assert.ok(ui.text().includes(failure.message), 'editing and confirming new rules cannot clear the required backend action')
  assert.equal(ui.button('保存').props.disabled, true)
  ui.button('保存').props.onClick()
  await ui.flush()
  assert.equal(ui.saves().length, 1, 'the disabled save handler also refuses another write')
  assert.ok(ui.text().includes(failure.message))
  ui.setRemote(fields(initial.proxies, ['remote.direct.example.com']))
  assert.equal(ui.button('保存').props.disabled, true, 'backend availability changing does not silently unblock stale frontend state')
  await ui.click('重新读取并保留草稿')
  assert.equal(ui.readCalls(), 2)
  assert.equal(ui.saves().length, 1, 'recovery reread rebases but does not automatically retry the failed save')
  assert.equal(ui.saved(), null)
  assert.equal(ui.nameInput('a').props.value, 'Alpha revised')
  assert.equal(ui.urlInput('a').props.value, 'http://127.0.0.1:9000')
  assert.deepEqual(activeRules(ui, 'a'), ['staged.example.com'])
  assert.deepEqual(activeRules(ui), ['remote.direct.example.com'])
  assert.match(ui.text(), /本地草稿已保留，未编辑的字段已更新/u)
  assert.ok(!ui.text().includes(failure.message), 'only a successful explicit reread clears the backend error')
  assert.equal(ui.button('保存').props.disabled, false)
  await ui.click('保存')
  assert.deepEqual(ui.saved(), fields([
    proxy('a', { name: 'Alpha revised', proxy: 'http://127.0.0.1:9000', proxyHosts: ['staged.example.com'] }),
  ], ['remote.direct.example.com']))
  assert.equal(ui.saves().length, 2)
  assert.equal(ui.button('保存').props.disabled, true)
})

test('conflict reload merges remote global edits with local proxy edits without automatically writing', async t => {
  const initial = fields([proxy('a', { name: 'Alpha' })], ['old.example.com'])
  const ui = mounted(t, initial, { save: async (_snapshot, attempt) => { if (attempt === 1) throw conflict() } })
  await ui.flush()
  await ui.change(ui.urlInput('a'), 'http://127.0.0.1:9000')
  const latest = fields(initial.proxies, ['remote.example.com'])
  ui.setRemote(latest)
  await ui.click('保存')
  assert.match(ui.text(), /不会自动覆盖远端修改/u)
  assert.equal(ui.readCalls(), 1)
  assert.equal(ui.button('保存').props.disabled, true)
  assert.equal(ui.urlInput('a').props.value, 'http://127.0.0.1:9000')
  await ui.click('重新读取并保留草稿')
  assert.equal(ui.readCalls(), 2)
  assert.match(ui.text(), /本地草稿已保留，未编辑的字段已更新/u)
  assert.equal(ui.urlInput('a').props.value, 'http://127.0.0.1:9000')
  assert.match(ui.text(ui.field()), /remote.example.com/u)
  assert.doesNotMatch(ui.text(ui.nodes(ui.field()).filter(node => node.type === 'li')), /old.example.com/u)
  assert.ok(option(ui, 'direct', 'old.example.com'), 'old saved exclusions remain candidates, not effective rules')
  assert.equal(ui.button('保存').props.disabled, false)
  assert.equal(ui.saves().length, 1, 'reread/rebase does not retry the failed write')
  await ui.click('保存')
  assert.deepEqual(ui.saved(), fields([proxy('a', { name: 'Alpha', proxy: 'http://127.0.0.1:9000' })], ['remote.example.com']))
})

test('when both sides changed proxies, reread preserves local drafts but requires explicit overwrite confirmation', async t => {
  const initial = fields([proxy('a', { name: 'Alpha' })], ['old.example.com'])
  const ui = mounted(t, initial, { save: async (_snapshot, attempt) => { if (attempt === 1) throw conflict() } })
  await ui.flush()
  await ui.change(ui.nameInput('a'), 'Local name')
  ui.setRemote(fields([proxy('a', { name: 'Alpha', proxy: 'http://127.0.0.1:9999' })], ['remote.example.com']))
  await ui.click('保存')
  await ui.click('重新读取并保留草稿')
  assert.match(ui.text(), /远端和本地草稿修改了相同字段/u)
  assert.equal(ui.nameInput('a').props.value, 'Local name')
  assert.equal(ui.urlInput('a').props.value, initial.proxies[0].proxy, 'the local proxies field is retained intact')
  assert.match(ui.text(ui.field()), /remote.example.com/u)
  assert.equal(ui.button('保存').props.disabled, true)
  ui.button('保存').props.onClick(); await ui.flush()
  assert.equal(ui.saves().length, 1, 'a disabled handler cannot silently overwrite remote proxies')
  await ui.click('确认以草稿覆盖冲突字段')
  assert.equal(ui.button('保存').props.disabled, false)
  assert.equal(ui.saves().length, 1, 'confirmation itself does not write')
  await ui.click('保存')
  assert.deepEqual(ui.saved(), fields([proxy('a', { name: 'Local name' })], ['remote.example.com']))
})

test('reverting a conflicting rebase selects the latest remote document instead of stale original settings', async t => {
  const ui = mounted(t, fields([proxy('a', { name: 'Alpha' })]), { save: async () => { throw conflict() } })
  await ui.flush()
  await ui.change(ui.nameInput('a'), 'Local name')
  const latest = fields([proxy('a', { name: 'Remote name', proxy: 'http://127.0.0.1:9999' })], ['remote.example.com'])
  ui.setRemote(latest)
  await ui.click('保存')
  await ui.click('重新读取并保留草稿')
  await ui.click('撤销修改')
  assert.equal(ui.nameInput('a').props.value, 'Remote name')
  assert.equal(ui.urlInput('a').props.value, latest.proxies[0].proxy)
  assert.match(ui.text(ui.field()), /remote.example.com/u)
  assert.equal(ui.button('保存').props.disabled, true)
  assert.equal(ui.saves().length, 1)
})

test('reload failure preserves drafts and permits a later successful reread', async t => {
  const ui = mounted(t, fields([proxy('a')], ['old.example.com']), {
    save: async () => { throw conflict() },
    read: async (snapshot, attempt) => { if (attempt === 2) throw new Error('local reread failed'); return snapshot },
  })
  await ui.flush()
  await ui.change(ui.urlInput('a'), 'http://127.0.0.1:9000')
  ui.setRemote(fields([proxy('a')], ['remote.example.com']))
  await ui.click('保存')
  await ui.click('重新读取并保留草稿')
  assert.match(ui.text(), /重新读取失败：local reread failed；本地草稿未丢失/u)
  assert.equal(ui.urlInput('a').props.value, 'http://127.0.0.1:9000')
  assert.match(ui.text(ui.field()), /old.example.com/u)
  assert.equal(ui.button('保存').props.disabled, true)
  await ui.click('重新读取并保留草稿')
  assert.equal(ui.urlInput('a').props.value, 'http://127.0.0.1:9000')
  assert.match(ui.text(ui.field()), /remote.example.com/u)
  assert.equal(ui.button('保存').props.disabled, false)
  assert.equal(ui.saves().length, 1)
})

test('initial read failures can retry without writing settings', async t => {
  const ui = mounted(t, fields([proxy('a')]), { read: async (snapshot, attempt) => { if (attempt === 1) throw new Error('local read failed'); return snapshot } })
  await ui.flush()
  assert.match(ui.text(), /local read failed/u)
  assert.equal(ui.cards().length, 0)
  await ui.click('重试读取')
  assert.equal(ui.cards().length, 1)
  assert.equal(ui.button('保存').props.disabled, true)
  assert.equal(ui.saves().length, 0)
})

test('a late catalog response from before a reread cannot replace the latest suggestions', async t => {
  const stale = deferred()
  const ui = mounted(t, fields([proxy('a')]), {
    save: async () => { throw conflict() },
    refresh: async (_snapshot, attempt) => attempt === 1 ? stale.promise : [{ host: 'latest.example.com', kind: 'routable', providers: ['Latest'] }],
  })
  await ui.flush()
  await ui.change(ui.nameInput('a'), 'Local name')
  ui.setRemote(fields([proxy('a')], ['remote.example.com']))
  await ui.click('保存')
  await ui.click('重新读取并保留草稿')
  assert.ok(option(ui, 'a', 'latest.example.com'))
  stale.resolve([{ host: 'stale.example.com', kind: 'routable', providers: ['Stale'] }])
  await ui.flush()
  assert.ok(option(ui, 'a', 'latest.example.com'))
  assert.equal(option(ui, 'a', 'stale.example.com'), undefined)
  assert.ok(option(ui, 'a', 'remote.example.com'), 'latest saved exclusions also remain candidates')
})

test('unmount cleanup ignores a pending settings read and catalog enrichment', async t => {
  const read = deferred(), catalog = deferred()
  const first = mounted(t, fields(), { read: () => read.promise })
  await first.flush()
  assert.match(first.text(), /正在读取设置/u)
  first.unmount()
  read.resolve({ ...fields([proxy('a')]), suggestions })
  await first.flush()
  assert.equal(first.nodes().length, 0)
  const second = mounted(t, fields([proxy('a')]), { refresh: () => catalog.promise })
  await second.flush()
  second.unmount()
  catalog.resolve([{ host: 'late.example.com', kind: 'routable', providers: [] }])
  await second.flush()
  assert.equal(second.nodes().length, 0)
})
