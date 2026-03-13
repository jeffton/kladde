import { test, expect } from '@playwright/test'
import {
  createNote,
  editor,
  expectEntry,
  listEntries,
  loginIfNeeded,
  secondaryToolbar,
  selectAll,
  topToolbar,
  typeBaseLines,
} from './helpers/editor-list-helpers'

test.describe('List type switching on touch input', () => {
  test.use({ hasTouch: true, viewport: { width: 1200, height: 900 } })

  test.beforeEach(async ({ page }) => {
    await loginIfNeeded(page)
  })

  test('tapping ordered list on nested todo subitem only converts that subitem', async ({
    page,
  }) => {
    await createNote(page, 'list-touch-nested-ordered')
    await typeBaseLines(page)

    await selectAll(page)
    await topToolbar(page).nth(5).tap() // task list

    await editor(page).locator('p', { hasText: 'beta' }).first().tap()
    await secondaryToolbar(page).nth(0).tap() // indent

    await editor(page).locator('p', { hasText: 'beta' }).first().tap()
    await topToolbar(page).nth(4).tap() // ordered list

    const entries = await listEntries(page)
    expectEntry(entries, { text: 'alpha', kind: 'task', depth: 1 })
    expectEntry(entries, { text: 'beta', kind: 'ordered', depth: 2 })
    expectEntry(entries, { text: 'gamma', kind: 'task', depth: 1 })

    const nestedOrderedStyle = await editor(page).evaluate((root) => {
      const item = root.querySelector('ol li') as HTMLElement | null
      if (!item) return null
      const style = window.getComputedStyle(item)
      return {
        display: style.display,
        listStyleType: style.listStyleType,
      }
    })

    expect(nestedOrderedStyle).toEqual({
      display: 'list-item',
      listStyleType: 'decimal',
    })
  })
})
