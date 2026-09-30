import { expect } from '@playwright/test'

import { test } from '../utils/test.js'
import { toUrl } from '../utils/to-url.js'

test('settings sidebar scrolling keeps the application in the viewport', async ({ page, ref }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(toUrl(`/project/${ref}/settings/general`))

  const sidebar = page.getByRole('menu', { name: 'Sidebar' })
  const content = page.locator('#panel-project-content main')
  await expect(sidebar).toBeVisible()
  await expect(content.getByRole('textbox').first()).toBeVisible()

  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight))
    .toBe(true)

  await sidebar.hover()
  await page.mouse.wheel(0, 3000)
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)))
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0)
  await expect.poll(() => content.evaluate((element) => element.scrollTop)).toBe(0)
  await expect(sidebar).toBeInViewport()

  await content.hover()
  await page.mouse.wheel(0, 600)
  await expect.poll(() => content.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
  await expect(sidebar).toBeInViewport()
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0)

  await page.locator('#main').focus()
  await page.keyboard.press('Control+End')
  await expect(sidebar).toBeInViewport()
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0)
})
