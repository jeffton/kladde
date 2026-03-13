import { test, expect } from '@playwright/test'
import {
  clickListButton,
  createNote,
  editor,
  expectEntry,
  listEntries,
  loginIfNeeded,
  secondaryToolbar,
  selectAll,
  typeBaseLines,
} from './helpers/editor-list-helpers'

test.describe('List type switching honors cursor/selection scope', () => {
  test.beforeEach(async ({ page }) => {
    await loginIfNeeded(page)
  })

  test('flat list: cursor item only + same-type toggle still works', async ({ page }) => {
    await createNote(page, 'list-flat-cursor')
    await typeBaseLines(page)
    await selectAll(page)
    await clickListButton(page, 'task')

    await editor(page).locator('p', { hasText: 'beta' }).first().click()
    await clickListButton(page, 'bullet')

    let entries = await listEntries(page)
    expectEntry(entries, { text: 'alpha', kind: 'task', depth: 1 })
    expectEntry(entries, { text: 'beta', kind: 'bullet', depth: 1 })
    expectEntry(entries, { text: 'gamma', kind: 'task', depth: 1 })

    await editor(page).locator('p', { hasText: 'beta' }).first().click()
    await clickListButton(page, 'bullet')

    entries = await listEntries(page)
    expectEntry(entries, { text: 'alpha', kind: 'task', depth: 1 })
    expectEntry(entries, { text: 'gamma', kind: 'task', depth: 1 })
    expect(entries.some((entry) => entry.text === 'beta')).toBeFalsy()
  })

  test('flat list: multi-item selection changes only selected items', async ({ page }) => {
    await createNote(page, 'list-flat-selection')
    await typeBaseLines(page)
    await selectAll(page)
    await clickListButton(page, 'task')

    await editor(page).locator('p', { hasText: 'alpha' }).first().click()
    await page.keyboard.down('Shift')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.up('Shift')

    await clickListButton(page, 'ordered')

    const entries = await listEntries(page)
    expectEntry(entries, { text: 'alpha', kind: 'ordered', depth: 1 })
    expectEntry(entries, { text: 'beta', kind: 'ordered', depth: 1 })
    expectEntry(entries, { text: 'gamma', kind: 'task', depth: 1 })
  })

  test('indented list: nested cursor item only + same-type toggle still works', async ({
    page,
  }) => {
    await createNote(page, 'list-indent-cursor')
    await typeBaseLines(page)
    await selectAll(page)
    await clickListButton(page, 'task')

    await editor(page).locator('p', { hasText: 'beta' }).first().click()
    await secondaryToolbar(page).nth(0).click() // indent beta under alpha

    let entries = await listEntries(page)
    expectEntry(entries, { text: 'alpha', kind: 'task', depth: 1 })
    expectEntry(entries, { text: 'beta', kind: 'task', depth: 2 })
    expectEntry(entries, { text: 'gamma', kind: 'task', depth: 1 })

    await editor(page).locator('p', { hasText: 'beta' }).first().click()
    await clickListButton(page, 'bullet')

    entries = await listEntries(page)
    expectEntry(entries, { text: 'alpha', kind: 'task', depth: 1 })
    expectEntry(entries, { text: 'beta', kind: 'bullet', depth: 2 })
    expectEntry(entries, { text: 'gamma', kind: 'task', depth: 1 })

    await editor(page).locator('p', { hasText: 'beta' }).first().click()
    await clickListButton(page, 'bullet')

    entries = await listEntries(page)
    expectEntry(entries, { text: 'alpha', kind: 'task', depth: 1 })
    expectEntry(entries, { text: 'gamma', kind: 'task', depth: 1 })
    expect(entries.some((entry) => entry.text === 'beta')).toBeFalsy()
  })

  test('indented list: text selection inside nested item only changes nested item', async ({
    page,
  }) => {
    await createNote(page, 'list-indent-selection')
    await typeBaseLines(page)
    await selectAll(page)
    await clickListButton(page, 'task')

    await editor(page).locator('p', { hasText: 'beta' }).first().click()
    await secondaryToolbar(page).nth(0).click() // indent beta under alpha

    await editor(page).locator('p', { hasText: 'beta' }).first().dblclick()

    await clickListButton(page, 'ordered')

    const entries = await listEntries(page)
    expectEntry(entries, { text: 'alpha', kind: 'task', depth: 1 })
    expectEntry(entries, { text: 'beta', kind: 'ordered', depth: 2 })
    expectEntry(entries, { text: 'gamma', kind: 'task', depth: 1 })
  })

  test('indented list: converting parent item does not change sibling item', async ({ page }) => {
    await createNote(page, 'list-indent-parent')
    await typeBaseLines(page)
    await selectAll(page)
    await clickListButton(page, 'task')

    await editor(page).locator('p', { hasText: 'beta' }).first().click()
    await secondaryToolbar(page).nth(0).click() // indent beta under alpha

    await editor(page).locator('p', { hasText: 'alpha' }).first().click()
    await clickListButton(page, 'ordered')

    const entries = await listEntries(page)
    expectEntry(entries, { text: 'alpha', kind: 'ordered', depth: 1 })
    expectEntry(entries, { text: 'beta', kind: 'task', depth: 2 })
    expectEntry(entries, { text: 'gamma', kind: 'task', depth: 1 })
  })
})
