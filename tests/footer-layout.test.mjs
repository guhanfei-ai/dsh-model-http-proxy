/** Guard the layout contract separately from the DOM-free interaction runner. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const css = readFileSync(new URL('../src/client/card.module.css', import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//gu, '')
const blocks = name => [...css.matchAll(new RegExp(`\\.${name}\\s*\\{([^}]*)\\}`, 'gu'))].map(match => match[1])
const declarations = rules => Object.fromEntries(rules.flatMap(rule => rule.split(';').flatMap(declaration => {
  const colon = declaration.indexOf(':')
  return colon < 0 ? [] : [[declaration.slice(0, colon).trim(), declaration.slice(colon + 1).trim()]]
})))

test('settings actions stay in normal document flow, not over the scrolling proxy cards', () => {
  const rules = blocks('footer')
  assert.ok(rules.length > 0, 'the footer has an explicit layout contract')
  for (const rule of rules) {
    assert.doesNotMatch(rule, /\bposition\s*:\s*(?:sticky|fixed|absolute)\b/iu,
      'a floating footer overlays content inside the host settings scroller')
  }
  const style = declarations(rules)
  assert.equal(style.position, 'static')
  assert.equal(style['flex-shrink'], '0')
  assert.ok(style.bottom === undefined || style.bottom === 'auto')
  assert.ok(style['z-index'] === undefined || style['z-index'] === 'auto')
})

test('long footer errors wrap without widening the settings scroll container', () => {
  const style = declarations(blocks('status'))
  assert.equal(style['min-width'], '0')
  assert.equal(style['overflow-wrap'], 'anywhere')
})
