import { test, expect, type Page } from '@playwright/test'

const isMac = process.platform === 'darwin'

type ListEntry = {
  text: string
  kind: 'task' | 'bullet' | 'ordered'
  depth: number
}

async function loginIfNeeded(page: Page) {
  await page.goto('http://127.0.0.1:8080', { waitUntil: 'networkidle' })
  const loginVisible = await page.locator('.login-form').isVisible().catch(() => false)
  if (!loginVisible) return

  await page.locator('.login-input').nth(0).fill('admin')
  await page.locator('.login-input').nth(1).fill('testpass123')
  await page.locator('.login-button').click()
}

async function createNote(page: Page, titlePrefix: string) {
  await page.locator('.create-fab').click()
  await page.locator('.note-title-input').fill(`${titlePrefix}-${Date.now()}`)
  await page.locator('.note-title-input').press('Enter')
}

function editor(page: Page) {
  return page.locator('.tiptap-root .ProseMirror')
}

function topToolbar(page: Page) {
  return page.locator('.editor-toolbar .toolbar-row').first().locator('button')
}

function secondaryToolbar(page: Page) {
  return page.locator('.editor-toolbar .toolbar-row-secondary').first().locator('button')
}

async function clickListButton(page: Page, kind: 'bullet' | 'ordered' | 'task') {
  const bar = topToolbar(page)
  const index = kind === 'bullet' ? 3 : kind === 'ordered' ? 4 : 5
  await bar.nth(index).click()
}

async function selectAll(page: Page) {
  await page.keyboard.press(isMac ? 'Meta+A' : 'Control+A')
}

async function typeBaseLines(page: Page) {
  const ed = editor(page)
  await ed.click()
  await page.keyboard.press(isMac ? 'Meta+A' : 'Control+A')
  await page.keyboard.press('Backspace')
  await page.keyboard.type('alpha')
  await page.keyboard.press('Enter')
  await page.keyboard.type('beta')
  await page.keyboard.press('Enter')
  await page.keyboard.type('gamma')
}

async function listEntries(page: Page): Promise<ListEntry[]> {
  const ed = editor(page)
  const raw = await ed.evaluate((root) => {
    const entries: Array<{ text: string; kind: 'task' | 'bullet' | 'ordered'; depth: number }> = []
    const listItems = Array.from(root.querySelectorAll('li'))

    for (const li of listItems) {
      const list = li.parentElement
      if (!list || (list.tagName !== 'UL' && list.tagName !== 'OL')) continue

      let text = ''
      if (list.getAttribute('data-type') === 'taskList') {
        text = (li.querySelector(':scope > div > p')?.textContent || '').trim()
      } else {
        text = (li.querySelector(':scope > p')?.textContent || '').trim()
      }
      if (!text) continue

      const kind = list.tagName === 'OL'
        ? 'ordered'
        : (list.getAttribute('data-type') === 'taskList' ? 'task' : 'bullet')

      let depth = 1
      let parent: HTMLElement | null = list.parentElement
      while (parent) {
        if (parent.tagName === 'UL' || parent.tagName === 'OL') depth += 1
        parent = parent.parentElement
      }

      entries.push({ text, kind, depth })
    }

    return entries
  })

  return raw.sort((a, b) => a.text.localeCompare(b.text))
}

function expectEntry(entries: ListEntry[], expected: { text: string; kind: ListEntry['kind']; depth: number }) {
  expect(
    entries.some((entry) => entry.kind === expected.kind && entry.depth === expected.depth && entry.text.includes(expected.text))
  ).toBeTruthy()
}

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

  test('indented list: nested cursor item only + same-type toggle still works', async ({ page }) => {
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

  test('indented list: text selection inside nested item only changes nested item', async ({ page }) => {
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
