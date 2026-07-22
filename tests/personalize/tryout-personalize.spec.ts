import { test, expect, Page } from '@playwright/test';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import dotenv from 'dotenv';
import { TryOutTestResult } from '../../config/types';

dotenv.config();

const PROJECT_UID    = process.env.PERSONALIZE_PROJECT_UID ?? '';
const CS_QA_EMAIL    = process.env.CS_QA_EMAIL ?? '';
const CS_QA_PASSWORD = process.env.CS_QA_PASSWORD ?? '';
const STATIC_AUTHTOKEN = process.env.CS_AUTHTOKEN ?? '';

const REGION_HOSTS: Record<string, string> = {
  us: 'personalize-api.contentstack.com', eu: 'eu-personalize-api.contentstack.com', au: 'au-personalize-api.contentstack.com',
  'azure-na': 'azure-na-personalize-api.contentstack.com', 'azure-eu': 'azure-eu-personalize-api.contentstack.com',
  'gcp-na': 'gcp-na-personalize-api.contentstack.com', 'gcp-eu': 'gcp-eu-personalize-api.contentstack.com',
};
const BASE_HOST = REGION_HOSTS[process.env.CS_REGION ?? 'us'] ?? 'personalize-api.contentstack.com';

const RESULTS_PATH   = path.join(__dirname, '../../reports/tryout-results-personalize.json');
const INDIVIDUAL_DIR = path.join(__dirname, '../../reports/individual-personalize');

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

async function resolveAuthtoken(): Promise<string> {
  if (CS_QA_EMAIL && CS_QA_PASSWORD) {
    const res = await axios.post('https://api.contentstack.io/v3/user-session', { user: { email: CS_QA_EMAIL, password: CS_QA_PASSWORD } });
    return res.data?.user?.authtoken ?? STATIC_AUTHTOKEN;
  }
  return STATIC_AUTHTOKEN;
}

/**
 * One-time attempt to seed a real Attribute uid to fill into the "uid" /
 * "versionUid" path-param fields for the ID-dependent requests below — same
 * "fetch live, fall back to a placeholder" convention as Lytics/CDA.
 * Each resource type (Attribute/Audience/Event/Experience/Version) has its
 * own {uid} path param sharing the same name — an Attribute's uid doesn't
 * work for an Audience/Event/Experience endpoint, so one of EACH is seeded
 * (mirroring runSwaggerPersonalize.ts's lifecycle) and picked per-module below.
 */
const seeded: Record<string, string> = {
  attributes: 'test-attribute-uid',
  audiences: 'test-audience-uid',
  events: 'test-event-uid',
  experiences: 'test-experience-uid',
};
let seededVersionUid = 'test-version-uid';

test.beforeAll(async () => {
  const authtoken = await resolveAuthtoken();
  const headers = { authtoken, 'x-project-uid': PROJECT_UID, 'Content-Type': 'application/json' };
  const seed = async (label: string, module: string, url: string, body: unknown) => {
    try {
      const res = await axios.post(url, body, { headers, validateStatus: () => true });
      const uid = res.data?.uid;
      if (uid) { seeded[module] = uid; console.log(`✅  Seeded a real ${label} ${uid} for ID-dependent Try Out tests`); return uid; }
      console.warn(`⚠️  Could not seed a real ${label} (status ${res.status}: ${JSON.stringify(res.data)}) — falling back to a placeholder id`);
    } catch (err) {
      console.warn(`⚠️  Could not seed a real ${label}: ${(err as Error).message} — falling back to a placeholder id`);
    }
    return undefined;
  };

  const suffix = Date.now();
  const attributeUid = await seed('attribute', 'attributes', `https://${BASE_HOST}/attributes`, {
    name: `Tryout Seed ${suffix}`, key: `tryoutSeed${suffix}`,
  });
  await seed('event', 'events', `https://${BASE_HOST}/events`, { key: `tryoutSeedEvent${suffix}` });
  await seed('audience', 'audiences', `https://${BASE_HOST}/audiences`, {
    name: `Tryout Seed Audience ${suffix}`,
    definition: attributeUid
      ? { __type: 'RuleCombination', combinationType: 'AND', rules: [{ __type: 'Rule', attribute: { __type: 'CustomAttributeReference', ref: attributeUid }, attributeMatchCondition: 'HAS_ANY_VALUE', invertCondition: false }] }
      : { __type: 'RuleCombination', combinationType: 'AND', rules: [{ __type: 'Rule', attribute: { __type: 'PresetAttributeReference', ref: 'COUNTRY' }, attributeMatchCondition: 'HAS_ANY_VALUE', invertCondition: false }] },
  });
  const experienceUid = await seed('experience', 'experiences', `https://${BASE_HOST}/experiences`, {
    name: `Tryout Seed Experience ${suffix}`, __type: 'SEGMENTED',
  });

  if (experienceUid) {
    try {
      const versionsRes = await axios.get(`https://${BASE_HOST}/experiences/${experienceUid}/versions`, { headers, validateStatus: () => true });
      const list = Array.isArray(versionsRes.data) ? versionsRes.data : [];
      // Creating an Experience auto-provisions a default DRAFT version (confirmed live — see README "Personalize" section).
      if (list[0]?.uid) { seededVersionUid = list[0].uid; console.log(`✅  Using auto-created default version ${seededVersionUid}`); }
    } catch (err) {
      console.warn(`⚠️  Could not fetch the auto-created experience version: ${(err as Error).message}`);
    }
  }
});

const scrapedPath = path.join(__dirname, '../../reports/scraped-requests-personalize.json');
const scrapedRequests = fs.existsSync(scrapedPath) ? JSON.parse(fs.readFileSync(scrapedPath, 'utf-8')) : [];

test.describe('Phase 2 — Personalize Live Try Out Panel Tests', () => {
  const targets = scrapedRequests.map((r: any) => ({
    name: r.doc.name,
    module: r.doc.module,
    url: r.doc.docUrl,
    method: r.doc.method,
  }));

  // Request names can repeat across modules (e.g. none currently, but stay consistent with CDA's convention)
  const nameCounts: Record<string, number> = {};
  for (const t of targets) nameCounts[t.name] = (nameCounts[t.name] ?? 0) + 1;

  for (const target of targets) {
    const title = nameCounts[target.name] > 1 ? `Try Out: [${target.module}] ${target.name}` : `Try Out: ${target.name}`;
    test(title, async ({ page }) => {
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

      // ── Fill credentials + path params (same data-param-key convention as CDA/CMA/Lytics) ──
      // "uid" means a different resource per module/request — Experiences module
      // covers both plain Experience requests AND nested Experience Version
      // requests (which also need {uid}=experienceUid + {versionUid}), and
      // Experience Analytics needs {uid}=experienceUid + a "version" query param.
      const isVersionOrAnalytics = /version|analytics/i.test(target.name);
      const uidForModule = isVersionOrAnalytics || target.module === 'experience-analytics'
        ? seeded['experiences']
        : (seeded[target.module] ?? 'test-uid');

      const authtoken = await resolveAuthtoken();
      await fillParamField(page, 'authtoken', authtoken);
      await fillParamField(page, 'x-project-uid', PROJECT_UID);
      await fillParamField(page, 'uid', uidForModule);
      await fillParamField(page, 'versionUid', seededVersionUid);
      await fillParamField(page, 'version', seededVersionUid);

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
        // Some 4xx here are genuine business rules exercised against a
        // placeholder/seeded uid (e.g. "only one draft version allowed") —
        // see README "Personalize" section — recorded honestly either way.
        flags.push(`❌  Client error: ${actualResponseCode} — check credentials, required params, or a genuine business rule`);
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
