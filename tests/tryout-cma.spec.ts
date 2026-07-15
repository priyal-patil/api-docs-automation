import { test, expect, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import dotenv from 'dotenv';
import { TryOutTestResult } from '../config/types';

dotenv.config();

const API_KEY          = process.env.CS_API_KEY          ?? '';
const MANAGEMENT_TOKEN = process.env.CS_MANAGEMENT_TOKEN ?? '';

// globalSetup.ts fetches these live from the QA stack (it gets reseeded
// independently of this project, so hardcoded UIDs go stale silently and
// every dependent Try Out test starts failing with a misleading 404/422).
// Hardcoded values below are last-resort fallbacks if that fetch failed.
import { LIVE_DATA_PATH } from './globalSetup';
const liveData: Record<string, string> = fs.existsSync(LIVE_DATA_PATH)
  ? JSON.parse(fs.readFileSync(LIVE_DATA_PATH, 'utf-8'))
  : {};

const TEST_CONTENT_TYPE_UID  = liveData.content_type_uid || process.env.CS_CMA_CONTENT_TYPE_UID || 'ref_child_ct_93257';
const TEST_ENVIRONMENT       = liveData.environment       || process.env.CS_CMA_ENVIRONMENT      || 'apienv';
const TEST_ENTRY_UID         = liveData.entry_uid         || process.env.CS_ENTRY_UID            || 'blt1a7ef281849aa427';
const TEST_ASSET_UID         = liveData.asset_uid         || process.env.CS_ASSET_UID            || 'bltd790f81f7644980e';
const TEST_TAXONOMY_UID      = liveData.taxonomy_uid      || process.env.CS_CMA_TAXONOMY_UID     || 'test';
const TEST_TERM_UID          = liveData.term_uid          || process.env.CS_TERM_UID             || 'test3m';
const TEST_GLOBAL_FIELD_UID  = liveData.global_field_uid  || process.env.CS_CMA_GLOBAL_FIELD_UID || 'seo_settings_43634';

// Modules that return 422 due to no published content on the test stack — warn instead of fail
const SKIP_422_MODULES: string[] = [];

// Requests where the Try Out panel uses hardcoded sample-stack tokens or proxied credentials
// that cannot be overridden via input fields — warn instead of fail
const SKIP_ERROR_REQUESTS = new Set<string>([]);

const scrapedPath = path.join(__dirname, '../reports/scraped-requests-cma.json');
const scrapedRequests = fs.existsSync(scrapedPath)
  ? JSON.parse(fs.readFileSync(scrapedPath, 'utf-8'))
  : [];

const RESULTS_PATH  = path.join(__dirname, '../reports/tryout-results-cma.json');
const INDIVIDUAL_DIR = path.join(__dirname, '../reports/individual-cma');

// Each test saves to its own file — retry just overwrites that one file, never touches others
function saveResult(result: TryOutTestResult): void {
  fs.mkdirSync(INDIVIDUAL_DIR, { recursive: true });
  const safeName = result.requestName.replace(/[^a-z0-9]/gi, '_').toLowerCase();
  fs.writeFileSync(
    path.join(INDIVIDUAL_DIR, `${safeName}.json`),
    JSON.stringify(result, null, 2)
  );
}

// ── Fill a field by its data-param-key attribute ─────────────────────────────
async function fillParamField(page: Page, key: string, value: string): Promise<boolean> {
  try {
    const field = page.locator(`input[data-param-key="${key}"]`).first();
    if (await field.isVisible({ timeout: 3000 })) {
      await field.clear();
      await field.fill(value);
      return true;
    }
  } catch {}
  return false;
}

// ── Read all param keys visible in the Try Out panel ─────────────────────────
async function readTryOutParamKeys(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('input[data-param-key]'))
      .map(el => el.getAttribute('data-param-key') ?? '')
      .filter(Boolean)
  );
}

// ── Read the response code from the response-body panel ──────────────────────
async function readResponseCode(page: Page): Promise<number | undefined> {
  try {
    // Selector confirmed from debug: .response-body .text-docs-strong span
    const text = await page
      .locator('.response-body .text-docs-strong span')
      .first()
      .innerText({ timeout: 10000 });
    const match = text.match(/\d{3}/);
    return match ? parseInt(match[0], 10) : undefined;
  } catch {
    return undefined;
  }
}

// ── Check default response code before clicking Send ─────────────────────────
async function checkDefaultResponseCode(page: Page): Promise<number | undefined> {
  try {
    const text = await page
      .locator('.response-body .text-docs-strong span')
      .first()
      .innerText({ timeout: 2000 });
    const match = text.match(/\d{3}/);
    const code = match ? parseInt(match[0], 10) : undefined;
    return code && code >= 400 ? code : undefined;
  } catch {
    return undefined;
  }
}

// ── Main test suite ───────────────────────────────────────────────────────────
test.describe('Phase 2 — Live Try Out Panel Tests (CMA)', () => {

  const targets = scrapedRequests.length > 0
    ? scrapedRequests.map((r: any) => ({
        name: r.doc.name,
        url: r.doc.docUrl,
        method: r.doc.method,
      }))
    : [
        { name: 'Content Types', url: 'https://www.contentstack.com/docs/developers/apis/content-management-api/#get-all-content-types', method: 'GET' },
      ];

  for (const target of targets) {
    test(`Try Out: ${target.name}`, async ({ page }) => {
      const flags: string[] = [];
      let defaultResponseCode: number | undefined;
      let actualResponseCode: number | undefined;
      let passed = true;

      await page.goto(target.url, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2000);

      // ── Step 1: Check default response code BEFORE opening Try Out ─────────
      defaultResponseCode = await checkDefaultResponseCode(page);
      if (defaultResponseCode) {
        flags.push(`⚠️  Page shows ${defaultResponseCode} by default before Send is clicked`);
        passed = false;
      }

      // ── Step 2: Find and click the correct Open Builder for this section ──
      // Use the anchor ID from the URL to locate the exact section heading,
      // then find the Open Builder button that is a DIRECT sibling of that heading —
      // same approach as the scraper, to avoid clicking the wrong button on long pages.
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
            // Fallback: scan siblings for the nearest Open Builder
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
        // Fallback: first visible Open Builder on page (works for single-section pages)
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
          });
          return;
        }
        await openBtn.click();
      }

      await page.waitForTimeout(1500);

      // ── Step 3: Check default code again after panel opens ─────────────────
      const panelDefaultCode = await checkDefaultResponseCode(page);
      if (panelDefaultCode) {
        flags.push(`⚠️  Try Out panel shows ${panelDefaultCode} as default before Send Request is clicked`);
        passed = false;
      }

      // ── Step 4: Read all visible param keys in the panel ───────────────────
      const visibleParamKeys = await readTryOutParamKeys(page);
      flags.push(`ℹ️  Try Out fields: ${visibleParamKeys.join(', ') || 'none found'}`);

      // ── Step 5: Fill credentials (headers use data-param-key too) ──────────
      await fillParamField(page, 'api_key',          API_KEY);
      await fillParamField(page, 'authtoken',         MANAGEMENT_TOKEN);
      await fillParamField(page, 'management_token',  MANAGEMENT_TOKEN);

      // ── Step 6: Fill common optional params + required path params ─────────
      await fillParamField(page, 'include_count', 'true');
      await fillParamField(page, 'limit', '10');
      await fillParamField(page, 'skip', '0');
      await fillParamField(page, 'locale', 'en-us');
      // Path params — UIDs must match real objects in the test stack
      await fillParamField(page, 'content_type_uid', TEST_CONTENT_TYPE_UID);
      await fillParamField(page, 'content_type_id',  TEST_CONTENT_TYPE_UID);
      await fillParamField(page, 'entry_uid',         TEST_ENTRY_UID);
      await fillParamField(page, 'asset_uid',         TEST_ASSET_UID);
      await fillParamField(page, 'taxonomy_uid',      TEST_TAXONOMY_UID);
      await fillParamField(page, 'term_uid',          TEST_TERM_UID);
      await fillParamField(page, 'global_field_uid',  TEST_GLOBAL_FIELD_UID);
      await fillParamField(page, 'environment',       TEST_ENVIRONMENT);
      await fillParamField(page, 'init',              'true');
      await fillParamField(page, 'x-cs-variant-uid',  'test_variant_uid');

      // ── Step 7: Click Send Request ─────────────────────────────────────────
      const sendBtn = page.locator('button.swaggerButton').first();
      const hasSendBtn = await sendBtn.isVisible({ timeout: 3000 }).catch(() => false);

      if (!hasSendBtn) {
        flags.push('❌  Send Request button (swaggerButton) not found');
        passed = false;
        saveResult({ requestName: target.name, endpoint: target.url, method: target.method, docUrl: target.url, defaultResponseCode, actualResponseCode, passed, flags });
        return;
      }

      await sendBtn.click();

      // ── Step 8: Wait for response and read the code ────────────────────────
      await page.waitForTimeout(6000);
      actualResponseCode = await readResponseCode(page);

      // ── Step 9: Assert 2xx ─────────────────────────────────────────────────
      const isSkippedRequest  = SKIP_ERROR_REQUESTS.has(target.name);
      const isNoContentModule = SKIP_422_MODULES.includes(target.name);

      if (actualResponseCode === undefined) {
        flags.push('❌  Could not read response code from panel after Send — selector may have changed');
        passed = false;
      } else if (actualResponseCode >= 500) {
        flags.push(`❌  Server error: ${actualResponseCode}`);
        passed = false;
      } else if (actualResponseCode >= 400) {
        if (isSkippedRequest) {
          flags.push(`⚠️  ${actualResponseCode} — known limitation: sample token or proxied credentials cannot be overridden`);
          // Don't mark as failed — environment constraint, not a doc issue
        } else if (actualResponseCode === 422 && isNoContentModule) {
          flags.push(`⚠️  422 — test stack has no published entries for this module`);
        } else {
          flags.push(`❌  Client error: ${actualResponseCode} — check credentials or required params`);
          passed = false;
        }
      } else {
        flags.push(`✅  Response: ${actualResponseCode}`);
      }

      // ── Step 10: Capture full response body ───────────────────────────────
      const responseBodyRaw = await page
        .locator('.response-body pre, .response-body code')
        .first()
        .innerText()
        .catch(() => '');

      let responseBodyKeys: string[] | undefined;
      if (responseBodyRaw.trim()) {
        try {
          const parsed = JSON.parse(responseBodyRaw.trim());
          responseBodyKeys = Object.keys(parsed);
        } catch {
          try {
            const inner = responseBodyRaw.trim().match(/\{[\s\S]*\}/)?.[0] ?? '';
            if (inner) responseBodyKeys = Object.keys(JSON.parse(inner));
          } catch { /* not JSON */ }
        }
      }

      if (!responseBodyRaw.trim()) {
        flags.push('⚠️  Response body is empty');
      } else if (actualResponseCode && actualResponseCode >= 400) {
        flags.push(`ℹ️  Error body: ${responseBodyRaw.substring(0, 200)}`);
      }

      // Save to file immediately — survives Playwright worker retries
      saveResult({
        requestName: target.name,
        endpoint: target.url,
        method: target.method,
        docUrl: target.url,
        defaultResponseCode,
        actualResponseCode,
        responseBodyRaw: responseBodyRaw.substring(0, 2000),
        responseBodyKeys,
        passed,
        flags,
      });

      // Assert — skip hard fail for known env constraints and no-content modules
      if (actualResponseCode !== undefined && !isSkippedRequest && !(actualResponseCode === 422 && isNoContentModule)) {
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
    // Consolidate all individual result files into one JSON
    const files = fs.existsSync(INDIVIDUAL_DIR) ? fs.readdirSync(INDIVIDUAL_DIR) : [];
    const all: TryOutTestResult[] = files
      .filter(f => f.endsWith('.json'))
      .map(f => JSON.parse(fs.readFileSync(path.join(INDIVIDUAL_DIR, f), 'utf-8')));
    fs.writeFileSync(RESULTS_PATH, JSON.stringify(all, null, 2));
    console.log(`\n📝  CMA Try Out results consolidated (${all.length} requests) → ${RESULTS_PATH}`);
  });
});
