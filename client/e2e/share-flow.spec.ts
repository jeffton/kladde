import { expect, test } from '@playwright/test'
import { createNote, editor, isMac, loginIfNeeded } from './helpers/editor-list-helpers'

test.describe('Share flow', () => {
  test.beforeEach(async ({ page }) => {
    await loginIfNeeded(page)
  })

  test('owner can create readonly + edit links and guest can edit collaboratively', async ({ browser, page }) => {
    await createNote(page, 'share-flow')

    await editor(page).click()
    await page.keyboard.press(isMac ? 'Meta+A' : 'Control+A')
    await page.keyboard.type('# Delt note')
    await page.keyboard.press('Enter')
    await page.keyboard.press('Enter')
    await page.keyboard.type('første linje')

    await page.waitForTimeout(1500)

    await page.locator('.note-menu-button').click()
    await page.locator('.note-menu-item', { hasText: /Del|Share/ }).click()

    const dialog = page.locator('.share-dialog')
    await expect(dialog).toBeVisible()
    await page.screenshot({ path: '../screenshots/playwright-share-dialog.png', fullPage: true })

    const viewRow = page.locator('.share-link-row').nth(0)
    const editRow = page.locator('.share-link-row').nth(1)

    await expect(viewRow.locator('.share-link-toggle')).toBeEnabled()
    await expect(editRow.locator('.share-link-toggle')).toBeEnabled()

    await viewRow.locator('.share-link-toggle').click()
    await expect(viewRow.locator('.share-link-url')).toContainText('http')

    await editRow.locator('.share-link-toggle').click()
    await expect(editRow.locator('.share-link-url')).toContainText('http')

    const viewUrl = (await viewRow.locator('.share-link-url').textContent())?.trim()
    const editUrl = (await editRow.locator('.share-link-url').textContent())?.trim()

    expect(viewUrl).toBeTruthy()
    expect(editUrl).toBeTruthy()

    await page.locator('.share-dialog-close').click()

    const renamedTitle = `share-flow-renamed-${Date.now()}`
    await page.locator('.note-title-input').fill(renamedTitle)
    await page.locator('.note-title-input').press('Enter')
    await expect(page.locator('.note-title-input')).toHaveValue(renamedTitle)

    const collectionName = `deling-${Date.now()}`
    page.once('dialog', (dialog) => dialog.accept(collectionName))
    await page.locator('.note-menu-button').click()
    await page.locator('.note-menu-item').filter({ has: page.locator('.lucide-folder-plus') }).click()

    await page.waitForTimeout(800)

    const readonlyContext = await browser.newContext()
    const readonlyPage = await readonlyContext.newPage()
    await readonlyPage.goto(String(viewUrl), { waitUntil: 'networkidle' })

    const readonlyEditor = readonlyPage.locator('.tiptap-root .ProseMirror')
    await expect(readonlyEditor).toBeVisible()
    await expect(readonlyEditor).toContainText('første linje')
    await expect(readonlyEditor).toHaveAttribute('contenteditable', 'false')
    await expect(readonlyPage.locator('.note-title-input')).toHaveValue(renamedTitle)
    await readonlyPage.screenshot({ path: '../screenshots/playwright-share-readonly.png', fullPage: true })

    const guestContext = await browser.newContext()
    const guestPage = await guestContext.newPage()
    await guestPage.goto(String(editUrl), { waitUntil: 'networkidle' })

    const guestEditor = guestPage.locator('.tiptap-root .ProseMirror')
    await expect(guestEditor).toBeVisible()
    await expect(guestEditor).toHaveAttribute('contenteditable', 'true')
    await expect(guestPage.locator('.note-title-input')).toHaveValue(renamedTitle)
    await guestPage.screenshot({ path: '../screenshots/playwright-share-editor.png', fullPage: true })

    await guestEditor.click()
    await guestPage.keyboard.press(isMac ? 'Meta+A' : 'Control+A')
    await guestPage.keyboard.type('# Delt note')
    await guestPage.keyboard.press('Enter')
    await guestPage.keyboard.press('Enter')
    await guestPage.keyboard.type('opdateret fra gæst')

    await guestPage.waitForTimeout(1200)

    await expect(editor(page)).toContainText('opdateret fra gæst', { timeout: 15000 })

    await readonlyContext.close()
    await guestContext.close()
  })
})
