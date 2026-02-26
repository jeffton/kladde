import { test } from '@playwright/test'
import {
  clickListButton,
  createNote,
  editor,
  expectEditorHasFocus,
  expectEntry,
  isMac,
  listEntries,
  loginIfNeeded,
  typeBaseLines,
} from './helpers/editor-list-helpers'

test.describe('Tab/Shift+Tab list indentation', () => {
  test.beforeEach(async ({ page }) => {
    await loginIfNeeded(page)
  })

  test('Tab on first list item does not move focus away from editor', async ({ page }) => {
    await createNote(page, 'list-tab-focus-first')
    await typeBaseLines(page)

    await page.keyboard.press(isMac ? 'Meta+A' : 'Control+A')
    await clickListButton(page, 'task')

    await editor(page).locator('p', { hasText: 'alpha' }).first().click()
    await page.keyboard.press('Tab')

    await expectEditorHasFocus(page)

    const entries = await listEntries(page)
    expectEntry(entries, { text: 'alpha', kind: 'task', depth: 1 })
    expectEntry(entries, { text: 'beta', kind: 'task', depth: 1 })
    expectEntry(entries, { text: 'gamma', kind: 'task', depth: 1 })
  })

  test('Tab and Shift+Tab indent/outdent current list item', async ({ page }) => {
    await createNote(page, 'list-tab-current-item')
    await typeBaseLines(page)

    await page.keyboard.press(isMac ? 'Meta+A' : 'Control+A')
    await clickListButton(page, 'task')

    await editor(page).locator('p', { hasText: 'beta' }).first().click()
    await page.keyboard.press('Tab')

    let entries = await listEntries(page)
    expectEntry(entries, { text: 'alpha', kind: 'task', depth: 1 })
    expectEntry(entries, { text: 'beta', kind: 'task', depth: 2 })
    expectEntry(entries, { text: 'gamma', kind: 'task', depth: 1 })
    await expectEditorHasFocus(page)

    await page.keyboard.press('Shift+Tab')

    entries = await listEntries(page)
    expectEntry(entries, { text: 'alpha', kind: 'task', depth: 1 })
    expectEntry(entries, { text: 'beta', kind: 'task', depth: 1 })
    expectEntry(entries, { text: 'gamma', kind: 'task', depth: 1 })
    await expectEditorHasFocus(page)
  })

  test('Tab and Shift+Tab indent/outdent selected list items', async ({ page }) => {
    await createNote(page, 'list-tab-selection')
    await typeBaseLines(page)

    await page.keyboard.press(isMac ? 'Meta+A' : 'Control+A')
    await clickListButton(page, 'task')

    await editor(page).locator('p', { hasText: 'beta' }).first().click()
    await page.keyboard.down('Shift')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.up('Shift')

    await page.keyboard.press('Tab')

    let entries = await listEntries(page)
    expectEntry(entries, { text: 'alpha', kind: 'task', depth: 1 })
    expectEntry(entries, { text: 'beta', kind: 'task', depth: 2 })
    expectEntry(entries, { text: 'gamma', kind: 'task', depth: 2 })
    await expectEditorHasFocus(page)

    await page.keyboard.press('Shift+Tab')

    entries = await listEntries(page)
    expectEntry(entries, { text: 'alpha', kind: 'task', depth: 1 })
    expectEntry(entries, { text: 'beta', kind: 'task', depth: 1 })
    expectEntry(entries, { text: 'gamma', kind: 'task', depth: 1 })
    await expectEditorHasFocus(page)
  })
})
