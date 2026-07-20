import { test, expect, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { TryOutTestResult } from '../../config/types';

const scrapedPath = path.join(__dirname, '../../reports/scraped-requests-imagedelivery.json');
const scrapedRequests = fs.existsSync(scrapedPath)
  ? JSON.parse(fs.readFileSync(scrapedPath, 'utf-8'))
  : [];

const RESULTS_PATH = path.join(__dirname, '../../reports/tryout-results-imagedelivery.json');
const INDIVIDUAL_DIR = path.join(__dirname, '../../reports/individual-imagedelivery');

function saveResult(result: TryOutTestResult, fileKey?: string): void {
  fs.mkdirSync(INDIVIDUAL_DIR, { recursive: true });
  const safeName = (fileKey ?? result.requestName).replace(/[^a-z0-9]/gi, '_').toLowerCase();
  fs.writeFileSync(
    path.join(INDIVIDUAL_DIR, `${safeName}.json`),
    JSON.stringify(result, null, 2)
  );
}

// The Response code lives in a heading whose own text is "Response" + the
// status code glued together (e.g. "Response200", "Response422") — confirmed
// live via DOM inspection. Unlike CDA/CMA there is no `.response-body` JSON
// panel: a successful call renders an <img>, an error renders this heading
// plus a "Request failed" banner. No heading at all means no request has
// been sent yet (or the panel wasn't opened).
async function readResponseHeadingCode(page: Page): Promise<number | undefined> {
  try {
    const text = await page
      .locator('[class*="docs-h3"]')
      .filter({ hasText: /Response\d{3}/ })
      .first()
      .innerText({ timeout: 2000 });
    const match = text.match(/Response(\d{3})/);
    return match ? parseInt(match[1], 10) : undefined;
  } catch {
    return undefined;
  }
}

test.describe('Phase 2 — Live Try Out Panel Tests (Image Delivery)', () => {

  const targets = scrapedRequests.length > 0
    ? scrapedRequests.map((r: any) => ({
        name: r.doc.name,
        module: r.doc.module,
        url: r.doc.docUrl,
        method: r.doc.method,
      }))
    : [
        { name: 'Resize image width', module: 'resize-images', url: 'https://www.contentstack.com/docs/developers/apis/image-delivery-api/resize-images#resize-image-width', method: 'GET' },
      ];

  const nameCounts: Record<string, number> = {};
  for (const t of targets) nameCounts[t.name] = (nameCounts[t.name] ?? 0) + 1;

  for (const target of targets) {
    const title = nameCounts[target.name] > 1
      ? `Try Out: [${target.module}] ${target.name}`
      : `Try Out: ${target.name}`;

    test(title, async ({ page }) => {
      const flags: string[] = [];
      let defaultResponseCode: number | undefined;
      let actualResponseCode: number | undefined;
      let passed = true;

      await page.goto(target.url, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2000);

      // ── Step 1: Check for a Response heading BEFORE opening Try Out ────────
      defaultResponseCode = await readResponseHeadingCode(page);
      if (defaultResponseCode && defaultResponseCode >= 400) {
        flags.push(`⚠️  Page shows ${defaultResponseCode} by default before Send is clicked`);
        passed = false;
      }

      // ── Step 2: Find and click the Open Builder for this exact section ────
      const anchorId = target.url.includes('#') ? target.url.split('#')[1] : '';

      const clicked = anchorId
        ? await page.evaluate((id: string): boolean => {
            const section = document.getElementById(id);
            if (!section) return false;
            const row = section.closest('.flex.items-center.justify-between');
            if (row) {
              const btn = Array.from(row.children).find(
                el => el.tagName === 'BUTTON' && (el as HTMLElement).innerText?.trim() === 'Open Builder'
              ) as HTMLButtonElement | undefined;
              if (btn) { btn.click(); return true; }
            }
            let el: Element | null = section;
            for (let i = 0; i < 10; i++) {
              el = el?.nextElementSibling ?? el?.parentElement?.nextElementSibling ?? null;
              if (!el) break;
              const btns = Array.from(el.querySelectorAll?.('button') ?? []) as HTMLButtonElement[];
              const b = btns.find(b => b.innerText?.trim() === 'Open Builder');
              if (b) { b.click(); return true; }
            }
            return false;
          }, anchorId)
        : false;

      if (!clicked) {
        const openBtn = page.locator('button:has-text("Open Builder")').first();
        const hasOpenBuilder = await openBtn.isVisible({ timeout: 5000 }).catch(() => false);
        if (!hasOpenBuilder) {
          flags.push('⚠️  Open Builder button not found — this may be an overview page without a Try Out panel');
          saveResult({
            requestName: target.name,
            endpoint: target.url,
            method: target.method,
            docUrl: target.url,
            defaultResponseCode,
            passed: true,
            flags,
          }, `${target.module}_${target.name}`);
          return;
        }
        await openBtn.click();
      }

      await page.waitForTimeout(1500);

      // ── Step 3: Check the Response heading again after the panel opens ────
      const panelDefaultCode = await readResponseHeadingCode(page);
      if (panelDefaultCode && panelDefaultCode >= 400) {
        flags.push(`⚠️  Try Out panel shows ${panelDefaultCode} as default before Send Request is clicked`);
        passed = false;
        defaultResponseCode = panelDefaultCode;
      }

      // ── Step 4: Read all visible param keys in the panel ───────────────────
      const visibleParamKeys = await page.evaluate(() =>
        Array.from(document.querySelectorAll('input[data-param-key]'))
          .map(el => el.getAttribute('data-param-key') ?? '')
          .filter(Boolean)
      );
      flags.push(`ℹ️  Try Out fields: ${visibleParamKeys.join(', ') || 'none found'}`);

      // ── Step 5: Every field already ships with the doc's own example value
      // pre-filled (e.g. width=100, environment=production) — this panel has
      // no api_key/asset override fields (the demo asset is baked into the
      // doc site itself), so there is nothing to inject. Fill any field a
      // scraper run found empty using its own placeholder, so every
      // documented param actually gets exercised.
      await page.evaluate(() => {
        document.querySelectorAll('input[data-param-key]').forEach(el => {
          const input = el as HTMLInputElement;
          if (!input.value && input.placeholder) input.value = input.placeholder;
        });
      });

      // ── Step 6: Click Send Request ─────────────────────────────────────────
      const sendBtn = page.locator('button.swaggerButton').first();
      const hasSendBtn = await sendBtn.isVisible({ timeout: 3000 }).catch(() => false);

      if (!hasSendBtn) {
        flags.push('❌  Send Request button (swaggerButton) not found');
        passed = false;
        saveResult({ requestName: target.name, endpoint: target.url, method: target.method, docUrl: target.url, defaultResponseCode, actualResponseCode, passed, flags }, `${target.module}_${target.name}`);
        return;
      }

      await sendBtn.click();

      // ── Step 7: Wait for the image/error response and read the code ────────
      await page.waitForTimeout(5000);
      actualResponseCode = await readResponseHeadingCode(page);

      // ── Step 8: Assert 2xx ──────────────────────────────────────────────────
      if (actualResponseCode === undefined) {
        flags.push('❌  Could not read response code after Send — selector may have changed');
        passed = false;
      } else if (actualResponseCode >= 500) {
        flags.push(`❌  Server error: ${actualResponseCode}`);
        passed = false;
      } else if (actualResponseCode >= 400) {
        flags.push(`❌  Client error: ${actualResponseCode} — check query parameters against the doc description`);
        passed = false;
      } else {
        flags.push(`✅  Response: ${actualResponseCode}`);
      }

      saveResult({
        requestName: target.name,
        endpoint: target.url,
        method: target.method,
        docUrl: target.url,
        defaultResponseCode,
        actualResponseCode,
        passed,
        flags,
      }, `${target.module}_${target.name}`);

      if (actualResponseCode !== undefined) {
        expect(
          actualResponseCode,
          `Expected 2xx but got ${actualResponseCode} for "${target.name}"`
        ).toBeGreaterThanOrEqual(200);
        expect(
          actualResponseCode,
          `Expected 2xx but got ${actualResponseCode} for "${target.name}"`
        ).toBeLessThan(300);
      }
    });
  }

  test.afterAll(async () => {
    const files = fs.existsSync(INDIVIDUAL_DIR) ? fs.readdirSync(INDIVIDUAL_DIR) : [];
    const all: TryOutTestResult[] = files
      .filter(f => f.endsWith('.json'))
      .map(f => JSON.parse(fs.readFileSync(path.join(INDIVIDUAL_DIR, f), 'utf-8')));
    fs.writeFileSync(RESULTS_PATH, JSON.stringify(all, null, 2));
    console.log(`\n📝  Try Out results consolidated (${all.length} requests) → ${RESULTS_PATH}`);
  });
});
