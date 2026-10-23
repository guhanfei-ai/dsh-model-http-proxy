import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { test } from 'node:test'

// Minimal hook runner for the actual built section: no DOM, RPC, or network.
// The separately maintained routing tests exercise the transport contract.
function mount(initial) {
  let entry, Component, props, current, dirty = true, tree, tasks = [], saved = null
  const states = new Map()
  const react = {
    useState(value) {
      const cell = current, i = cell.index++
      if (!(i in cell.values)) cell.values[i] = typeof value === 'function' ? value() : value
      cell.setters ??= []
      cell.setters[i] ??= next => { const v = typeof next === 'function' ? next(cell.values[i]) : next; if (!Object.is(v, cell.values[i])) { cell.values[i] = v; dirty = true } }
      return [cell.values[i], cell.setters[i]]
    },
    useRef(value) { const cell = current, i = cell.index++; return cell.values[i] ??= { current: value } },
    useEffect(fn, deps) {
      const cell = current, i = cell.index++, prev = cell.effects[i]
      if (!prev || deps.some((d, j) => !Object.is(d, prev.deps[j]))) {
        tasks.push(() => { prev?.cleanup?.(); cell.effects[i] = { deps, cleanup: fn() } })
      }
    },
  }
  const jsx = (type, props, key) => ({ type, props: props ?? {}, key })
  const face = {
    read: async () => ({ ...initial, suggestions: [
      { host: 'auth.openai.com', kind: 'builtin', providers: ['作者内置'] },
      { host: 'api.openai.com', kind: 'routable', providers: ['OpenAI'] },
    ] }),
    refreshSuggestions: async () => [
      { host: 'auth.openai.com', kind: 'builtin', providers: ['作者内置'] },
      { host: 'api.openai.com', kind: 'routable', providers: ['OpenAI'] },
    ],
    save: async fields => { saved = JSON.parse(JSON.stringify(fields)) },
  }
  vm.runInNewContext(readFileSync('lib/client.js', 'utf8'), {
    URL, console, setTimeout, clearTimeout,
    document: { querySelector: () => ({}) },
    window: { __ModuleLoader__: { load: x => { entry = x } } },
  })
  entry.factory(name => name === 'react' ? react : { jsx, jsxs: jsx, Fragment: 'fragment' }).apply({
    get: () => undefined,
    slots: { inject: (_name, fn) => fn(), register: (opts, component) => { Component = component; props = { ...opts.inject(), proxyFace: face } } },
  })
  function render(node, path = 'root') {
    if (node == null || typeof node !== 'object') return node
    if (Array.isArray(node)) return node.map((n, i) => render(n, `${path}/${n?.key ?? i}`))
    if (typeof node.type === 'function') {
      const cell = states.get(path) ?? { index: 0, values: [], effects: [] }
      states.set(path, cell); cell.index = 0
      const parent = current; current = cell
      const result = node.type(node.props); current = parent
      return render(result, path + '/render')
    }
    return { ...node, props: { ...node.props, children: render(node.props.children, path + '/children') } }
  }
  async function flush() {
    for (let count = 0; count < 30; count++) {
      if (dirty) { dirty = false; tree = render(jsx(Component, props)); const effectTasks = tasks; tasks = []; for (const task of effectTasks) task() }
      await Promise.resolve(); await Promise.resolve()
      if (!dirty) return
    }
    throw Error('render did not settle')
  }
  const flatten = node => Array.isArray(node) ? node.flatMap(flatten) : node && typeof node === 'object' ? [node, ...flatten(node.props?.children)] : []
  const nodes = () => flatten(tree)
  const text = node => Array.isArray(node) ? node.map(text).join(' ') : node && typeof node === 'object' ? text(node.props?.children) : node == null ? '' : String(node)
  const button = label => nodes().find(n => n.type === 'button' && (n.props['aria-label'] === label || text(n.props.children) === label))
  return { flush, nodes, text: () => text(tree), button, saved: () => saved }
}

test('explicit lists layout supports add/edit/delete, conflicts and save staging', async () => {
  const ui = mount({ proxy: 'http://127.0.0.1:7890', proxyHosts: ['auth.openai.com'], excludeHosts: [] })
  await ui.flush()
  const labels = ui.nodes().filter(n => n.type === 'h2').map(n => ui.text().includes(n.props.children) ? n.props.children : '')
  assert.ok(labels.indexOf('直连域名') < labels.indexOf('代理域名'))
  assert.match(ui.text(), /来源：\s*内置/u)
  assert.equal(ui.button('保存').props.disabled, true)

  const addButtons = ui.nodes().filter(n => n.type === 'button' && n.props.children === '手工添加')
  assert.equal(addButtons.length, 2)
  addButtons[0].props.onClick(); await ui.flush()
  assert.equal(ui.button('保存').props.disabled, true)
  assert.match(ui.text(), /请先确认或取消/u)
  let input = ui.nodes().find(n => n.type === 'input' && n.props['aria-label'] === '直连域名手工添加域名')
  input.props.onChange({ target: { value: '.openai.com' } }); await ui.flush()
  ui.button('确认').props.onClick(); await ui.flush()
  assert.match(ui.text(), /旧 .host/u)
  input = ui.nodes().find(n => n.type === 'input' && n.props['aria-label'] === '直连域名手工添加域名')
  input.props.onChange({ target: { value: '*.openai.com' } }); await ui.flush()
  ui.button('确认').props.onClick(); await ui.flush()
  assert.match(ui.text(), /被直连规则覆盖/u)
  assert.equal(ui.button('保存').props.disabled, false)
  assert.equal(ui.saved(), null)
  ui.button('保存').props.onClick(); await ui.flush()
  assert.deepEqual(ui.saved().excludeHosts, ['*.openai.com'])

  ui.button('编辑 *.openai.com').props.onClick(); await ui.flush()
  input = ui.nodes().find(n => n.type === 'input' && n.props['aria-label'] === '直连域名编辑域名')
  input.props.onChange({ target: { value: 'api.openai.com' } }); await ui.flush()
  ui.button('确认').props.onClick(); await ui.flush()
  ui.button('删除 auth.openai.com').props.onClick(); await ui.flush()
  assert.match(ui.text(), /暂无规则\s*，所有请求直连/u)
  ui.button('保存').props.onClick(); await ui.flush()
  assert.deepEqual(ui.saved().proxyHosts, [])
  assert.deepEqual(ui.saved().excludeHosts, ['api.openai.com'])
})
