/**
 * Debug script — opens the Content Types page, clicks Open Builder,
 * clicks Send Request, then dumps the relevant HTML so we can find
 * the correct selectors for the response code and input fields.
 */
import { chromium } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const URL = 'https://www.contentstack.com/docs/developers/apis/content-delivery-api/content-types#get-all-content-types';
const API_KEY = process.env.CS_API_KEY ?? '';
const DELIVERY_TOKEN = process.env.CS_DELIVERY_TOKEN ?? '';

(async () => {
  const browser = await chromium.launch({ headless: false }); // visible so you can watch
  const page = await browser.newPage();

  console.log('Opening:', URL);
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);

  // Take a screenshot of the page before clicking anything
  await page.screenshot({ path: 'reports/debug-before-open.png', fullPage: false });
  console.log('📸 Screenshot saved: reports/debug-before-open.png');

  // Dump all buttons on the page
  const buttons = await page.evaluate(() =>
    Array.from(document.querySelectorAll('button')).map(b => ({
      text: b.innerText.trim(),
      className: b.className,
      id: b.id,
    }))
  );
  console.log('\n=== ALL BUTTONS ON PAGE ===');
  buttons.forEach(b => console.log(`  [${b.text}] class="${b.className}" id="${b.id}"`));

  // Try clicking Open Builder — try multiple selectors
  const openBtnSelectors = [
    'button:has-text("Open Builder")',
    'button:has-text("Try it")',
    'button:has-text("Try It")',
    '[class*="open-builder"]',
    '[class*="try-out"]',
    '[class*="tryout"]',
    '[data-testid*="builder"]',
  ];

  let clicked = false;
  for (const sel of openBtnSelectors) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 2000 })) {
        console.log(`\n✅ Found Open Builder with selector: ${sel}`);
        await btn.click();
        clicked = true;
        break;
      }
    } catch {}
  }

  if (!clicked) {
    console.log('\n❌ Could not find Open Builder button. Saving page HTML...');
    const html = await page.content();
    fs.writeFileSync('reports/debug-page.html', html);
    console.log('HTML saved to reports/debug-page.html');
    await browser.close();
    return;
  }

  await page.waitForTimeout(2000);
  await page.screenshot({ path: 'reports/debug-after-open.png', fullPage: false });
  console.log('📸 Screenshot saved: reports/debug-after-open.png');

  // Dump all input fields visible in the Try Out panel
  const inputs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('input, textarea, select')).map(el => ({
      tag: el.tagName,
      type: (el as HTMLInputElement).type,
      name: (el as HTMLInputElement).name,
      placeholder: (el as HTMLInputElement).placeholder,
      className: el.className.substring(0, 80),
      id: el.id,
      ariaLabel: el.getAttribute('aria-label'),
    }))
  );
  console.log('\n=== ALL INPUTS AFTER OPEN BUILDER ===');
  inputs.forEach(i => console.log(`  [${i.tag}] type=${i.type} name="${i.name}" placeholder="${i.placeholder}" aria-label="${i.ariaLabel}" class="${i.className}"`));

  // Try filling api_key
  const apiKeySelectors = [
    'input[placeholder*="api_key"]',
    'input[name*="api_key"]',
    'input[aria-label*="api_key"]',
    'input[placeholder*="API Key"]',
    '[class*="api-key"] input',
  ];
  for (const sel of apiKeySelectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 1000 })) {
        console.log(`\n✅ Found api_key input with: ${sel}`);
        await el.fill(API_KEY);
        break;
      }
    } catch {}
  }

  // Try finding and clicking Send Request
  const sendSelectors = [
    'button:has-text("Send Request")',
    'button:has-text("Send")',
    'button:has-text("Run")',
    '[class*="send-btn"]',
    '[class*="submit-btn"]',
    '[class*="execute"]',
  ];

  let sent = false;
  for (const sel of sendSelectors) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 2000 })) {
        console.log(`\n✅ Found Send button with selector: ${sel}`);
        await btn.click();
        sent = true;
        break;
      }
    } catch {}
  }

  if (!sent) {
    console.log('\n❌ Could not find Send Request button');
  } else {
    await page.waitForTimeout(5000);
    await page.screenshot({ path: 'reports/debug-after-send.png', fullPage: false });
    console.log('📸 Screenshot saved: reports/debug-after-send.png');

    // Dump the response area HTML
    const responseHtml = await page.evaluate(() => {
      // Look for any element that might contain the response
      const candidates = [
        '[class*="response"]',
        '[class*="result"]',
        '[class*="output"]',
        '[class*="status"]',
        '[class*="code"]',
      ];
      const results: Array<{ selector: string; text: string; className: string }> = [];
      for (const sel of candidates) {
        document.querySelectorAll(sel).forEach(el => {
          const text = (el as HTMLElement).innerText?.trim();
          if (text && text.length < 200) {
            results.push({ selector: sel, text, className: el.className });
          }
        });
      }
      return results;
    });

    console.log('\n=== RESPONSE AREA ELEMENTS ===');
    responseHtml.forEach(r => console.log(`  [${r.selector}] class="${r.className}" text="${r.text}"`));
  }

  // Save full HTML for manual inspection
  const html = await page.content();
  fs.mkdirSync('reports', { recursive: true });
  fs.writeFileSync('reports/debug-page.html', html);
  console.log('\n💾 Full page HTML saved to reports/debug-page.html');

  console.log('\n⏳ Keeping browser open for 15 seconds so you can inspect...');
  await page.waitForTimeout(15000);
  await browser.close();
})();
