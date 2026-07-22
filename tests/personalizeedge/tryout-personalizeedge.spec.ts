import { test, expect, Page } from '@playwright/test';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import dotenv from 'dotenv';
import { TryOutTestResult } from '../../config/types';

dotenv.config();

const PROJECT_UID = process.env.PERSONALIZE_PROJECT_UID ?? '';

const REGION_HOSTS: Record<string, string> = {
  us: 'personalize-edge.contentstack.com', eu: 'eu-personalize-edge.contentstack.com', au: 'au-personalize-edge.contentstack.com',
  'azure-na': 'azure-na-personalize-edge.contentstack.com', 'azure-eu': 'azure-eu-personalize-edge.contentstack.com',
  'gcp-na': 'gcp-na-personalize-edge.contentstack.com', 'gcp-eu': 'gcp-eu-personalize-edge.contentstack.com',
};
const BASE_HOST = REGION_HOSTS[process.env.CS_REGION ?? 'us'] ?? 'personalize-edge.contentstack.com';

const RESULTS_PATH   = path.join(__dirname, '../../reports/tryout-results-personalizeedge.json');
const INDIVIDUAL_DIR = path.join(__dirname, '../../reports/individual-personalizeedge');

function saveResult(result: TryOutTestResult, fileKey?: string): void {
  fs.mkdirSync(INDIVIDUAL_DIR, { recursive: true });
  const safeName = (fileKey ?? result.requestName).replace(/[^a-z0-9]/gi, '_').toLowerCase();
  fs.writeFileSync(path.join(INDIVIDUAL_DIR, `${safeName}.json`), JSON.stringify(result, null, 2));
}

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

async function readResponseCode(page: Page): Promise<number | undefined> {
  try {
    const text = await page.locator('.response-body .text-docs-strong span').first().innerText({ timeout: 10000 });
    const match = text.match(/\d{3}/);
    return match ? parseInt(match[0], 10) : undefined;
  } catch {
    return undefined;
  }
}

async function checkDefaultResponseCode(page: Page): Promise<number | undefined> {
  try {
    const text = await page.locator('.response-body .text-docs-strong span').first().innerText({ timeout: 2000 });
    const match = text.match(/\d{3}/);
    const code = match ? parseInt(match[0], 10) : undefined;
    return code && code >= 400 ? code : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Personalize Edge needs NO authtoken at all (public edge API, confirmed
 * live) — just a real user UID, obtained by calling Get Manifest without one
 * first and reading it back from the response header.
 */
let seededUserUid = 'test-user-uid';

test.beforeAll(async () => {
  try {
    const res = await axios.get(`https://${BASE_HOST}/manifest`, {
      headers: { 'x-project-uid': PROJECT_UID }, validateStatus: () => true,
    });
    const uid = res.headers['x-cs-personalize-user-uid'];
    if (uid) { seededUserUid = uid; console.log(`✅  Seeded a real user UID ${uid} for ID-dependent Try Out tests`); }
    else console.warn(`⚠️  Could not seed a real user UID (status ${res.status}) — Try Out tests will use a placeholder`);
  } catch (err) {
    console.warn(`⚠️  Could not seed a real user UID: ${(err as Error).message} — falling back to a placeholder`);
  }
});

const scrapedPath = path.join(__dirname, '../../reports/scraped-requests-personalizeedge.json');
const scrapedRequests = fs.existsSync(scrapedPath) ? JSON.parse(fs.readFileSync(scrapedPath, 'utf-8')) : [];

test.describe('Phase 2 — Personalize Edge Live Try Out Panel Tests', () => {
  const targets = scrapedRequests.map((r: any) => ({
    name: r.doc.name,
    module: r.doc.module,
    url: r.doc.docUrl,
    method: r.doc.method,
  }));

  for (const target of targets) {
    test(`Try Out: ${target.name}`, async ({ page }) => {
      const flags: string[] = [];
      let defaultResponseCode: number | undefined;
      let actualResponseCode: number | undefined;
      let passed = true;

      await page.goto(target.url, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2000);

      defaultResponseCode = await checkDefaultResponseCode(page);
      if (defaultResponseCode) {
        flags.push(`⚠️  Page shows ${defaultResponseCode} by default before Send is clicked`);
        passed = false;
      }

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
          saveResult({ requestName: target.name, endpoint: target.url, method: target.method, docUrl: target.url, defaultResponseCode, passed: true, flags }, `${target.module}_${target.name}`);
          return;
        }
        await openBtn.click();
      }

      await page.waitForTimeout(1500);

      const panelDefaultCode = await checkDefaultResponseCode(page);
      if (panelDefaultCode) {
        flags.push(`⚠️  Try Out panel shows ${panelDefaultCode} as default before Send Request is clicked`);
        passed = false;
      }

      // ── Fill params — no auth token needed for this public API ──
      await fillParamField(page, 'x-project-uid', PROJECT_UID);
      await fillParamField(page, 'x-cs-personalize-user-uid', seededUserUid);

      const sendBtn = page.locator('button.swaggerButton, button:has-text("Send Request")').first();
      const hasSendBtn = await sendBtn.isVisible({ timeout: 3000 }).catch(() => false);

      if (!hasSendBtn) {
        flags.push('❌  Send Request button not found');
        passed = false;
        saveResult({ requestName: target.name, endpoint: target.url, method: target.method, docUrl: target.url, defaultResponseCode, actualResponseCode, passed, flags }, `${target.module}_${target.name}`);
        return;
      }

      await sendBtn.click();
      await page.waitForTimeout(6000);
      actualResponseCode = await readResponseCode(page);

      if (actualResponseCode === undefined) {
        flags.push('❌  Could not read response code from panel after Send — selector may have changed');
        passed = false;
      } else if (actualResponseCode >= 500) {
        flags.push(`❌  Server error: ${actualResponseCode}`);
        passed = false;
      } else if (actualResponseCode >= 400) {
        flags.push(`❌  Client error: ${actualResponseCode} — check required params`);
        passed = false;
      } else {
        flags.push(`✅  Response: ${actualResponseCode}`);
      }

      const responseBodyRaw = await page.locator('.response-body pre, .response-body code').first().innerText().catch(() => '');
      let responseBodyKeys: string[] | undefined;
      if (responseBodyRaw.trim()) {
        try {
          responseBodyKeys = Object.keys(JSON.parse(responseBodyRaw.trim()));
        } catch {
          try {
            const inner = responseBodyRaw.trim().match(/\{[\s\S]*\}/)?.[0] ?? '';
            if (inner) responseBodyKeys = Object.keys(JSON.parse(inner));
          } catch { /* not JSON */ }
        }
      }

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
      }, `${target.module}_${target.name}`);

      if (actualResponseCode !== undefined) {
        expect(actualResponseCode, `Expected 2xx but got ${actualResponseCode} for "${target.name}"`).toBeGreaterThanOrEqual(200);
        expect(actualResponseCode, `Expected 2xx but got ${actualResponseCode} for "${target.name}"`).toBeLessThan(300);
      }
    });
  }

  // Consolidation happens in a standalone step after `playwright test` exits — see consolidateTryout.ts.
});
