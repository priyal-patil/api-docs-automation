import { chromium } from 'playwright';
import * as fs from 'fs';
import dotenv from 'dotenv';
dotenv.config();

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  await page.goto('https://www.contentstack.com/docs/developers/apis/content-delivery-api/entries', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);

  // Click Open Builder
  const openBtn = page.locator('button:has-text("Open Builder")').first();
  if (await openBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await openBtn.click();
    await page.waitForTimeout(1500);
  }

  // Dump all input fields with data-param-key
  const fields = await page.evaluate(() =>
    Array.from(document.querySelectorAll('input[data-param-key]')).map(el => ({
      key: el.getAttribute('data-param-key'),
      placeholder: (el as HTMLInputElement).placeholder,
      value: (el as HTMLInputElement).value,
    }))
  );
  console.log('=== data-param-key fields on Entries page ===');
  fields.forEach(f => console.log(` key="${f.key}" placeholder="${f.placeholder}" value="${f.value}"`));

  // Also dump ALL inputs
  const allInputs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('input')).map(el => ({
      type: (el as HTMLInputElement).type,
      name: (el as HTMLInputElement).name,
      placeholder: (el as HTMLInputElement).placeholder,
      ariaLabel: el.getAttribute('aria-label'),
      dataKey: el.getAttribute('data-param-key'),
      className: el.className.substring(0, 60),
    })).filter(i => i.placeholder || i.dataKey)
  );
  console.log('\n=== All meaningful inputs on Entries page ===');
  allInputs.forEach(i => console.log(` data-param-key="${i.dataKey}" placeholder="${i.placeholder}" aria="${i.ariaLabel}"`));

  await browser.close();
})();
