import { expect } from '@playwright/test'

import { test } from '../utils/test.js'
import { toUrl } from '../utils/to-url.js'

test.describe('Fleet lifecycle profile isolation',()=>{
  test('Embedded Studio keeps Fleet lifecycle controls absent',async({page,ref})=>{
    await page.goto(toUrl(`/project/${ref}/settings/infrastructure`))
    await expect(page.getByRole('heading',{name:'Infrastructure'}),'Infrastructure settings should preserve the Embedded page').toBeVisible({timeout:30000})
    await expect(page.getByText('Lifecycle providers',{exact:true}),'Fleet lifecycle controls must not leak into Embedded Studio').toHaveCount(0)
  })
})
