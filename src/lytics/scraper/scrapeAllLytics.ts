import { chromium, Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import dotenv from 'dotenv';
import { DocRequest, DocParam, DocHeader, TryOutData, TryOutField } from '../../../config/types';

dotenv.config();

const BASE = 'https://www.contentstack.com/docs/developers/apis/lytics-cdp-management-api';

// Module slugs come from the rendered left nav — confirmed live, do NOT guess.
const MODULES = ['projects', 'collaborators', 'roles'];

/**
 * Method badge + endpoint URL extraction — same DOM shape as the Automations/
 * Brand Kit scrapers (identical Developer Hub doc template). See
 * scrapeAllAutomations.ts for why the badge's first <span> is read
 * unconditionally rather than matched by class (DELETE uses a different
 * background-color class than GET/POST/PUT).
 */
async function extractMethodAndEndpoint(page: Page, anchorId: string): Promise<{ method: DocRequest['method']; endpoint: string }> {
  return page.evaluate((id: string): { method: DocRequest['method']; endpoint: string } => {
    const anchorEl = document.getElementById(id);
    const headingWrapper = anchorEl?.closest('.flex.items-center.justify-between');
    const row = headingWrapper?.nextElementSibling;
    const badgeText = row?.querySelector('span')?.textContent?.trim().toUpperCase() ?? '';
    const method = (['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].includes(badgeText) ? badgeText : 'GET') as DocRequest['method'];
    const endpoint = row?.querySelector('code')?.textContent?.trim() ?? '';
    return { method, endpoint };
  }, anchorId);
}

async function extractParamRows(page: Page, anchorId: string, headingText: string): Promise<DocParam[]> {
  return page.evaluate(({ id, heading }: { id: string; heading: string }): DocParam[] => {
    const seen = new Set<string>();
    const result: DocParam[] = [];

    const all = Array.from(document.querySelectorAll('body *'));
    const anchorEl = document.getElementById(id);
    let scoped: Element[] = all;
    if (anchorEl) {
      const startIdx = all.indexOf(anchorEl);
      if (startIdx !== -1) {
        const ownHeading = anchorEl.querySelector('h1,h2,h3,h4,h5,h6') as HTMLElement | null;
        const ownLevel = ownHeading ? parseInt(ownHeading.tagName[1], 10) : 2;
        let endIdx = all.length;
        for (let i = startIdx + 1; i < all.length; i++) {
          const el = all[i];
          const m = /^H([1-6])$/.exec(el.tagName);
          if (m && parseInt(m[1], 10) <= ownLevel && !anchorEl.contains(el)) { endIdx = i; break; }
        }
        scoped = all.slice(startIdx, endIdx);
      }
    }

    const h4s = (scoped.filter(el => el.tagName === 'H4') as HTMLElement[]);
    for (const h4 of h4s) {
      if (!h4.innerText.trim().startsWith(heading)) continue;
      const section = h4.parentElement?.parentElement;
      if (!section) continue;
      const rows = Array.from(section.querySelectorAll('.docs-label-primary'));
      for (const nameEl of rows) {
        const name = (nameEl as HTMLElement).innerText.trim();
        if (!name || seen.has(name)) continue;
        seen.add(name);
        const row = nameEl.closest('div');
        const requiredEl = row?.querySelector('.text-docs-amethyst-accent');
        const typeEl = row?.querySelector('.docs-caption.text-docs-teal');
        const descEl = row?.querySelector('.show-hide-params-desc, .docs-s-body-regular');
        const exampleEl = row?.querySelector('.docs-caption.text-docs-strong.font-mono');
        result.push({
          name,
          type: (typeEl as HTMLElement)?.innerText?.trim() ?? 'string',
          required: !!requiredEl,
          description: (descEl as HTMLElement)?.innerText?.trim() ?? '',
          defaultValue: (exampleEl as HTMLElement)?.innerText?.trim(),
        });
      }
    }
    return result;
  }, { id: anchorId, heading: headingText });
}

async function extractJsonAfterMarker(page: Page, anchorId: string, marker: string): Promise<string | undefined> {
  return page.evaluate(({ id, marker }: { id: string; marker: string }): string | undefined => {
    const all = Array.from(document.querySelectorAll('body *'));
    const anchorEl = document.getElementById(id);
    let scoped: Element[] = all;
    if (anchorEl) {
      const startIdx = all.indexOf(anchorEl);
      if (startIdx !== -1) {
        const ownHeading = anchorEl.querySelector('h1,h2,h3,h4,h5,h6') as HTMLElement | null;
        const ownLevel = ownHeading ? parseInt(ownHeading.tagName[1], 10) : 2;
        let endIdx = all.length;
        for (let i = startIdx + 1; i < all.length; i++) {
          const el = all[i];
          const m = /^H([1-6])$/.exec(el.tagName);
          if (m && parseInt(m[1], 10) <= ownLevel && !anchorEl.contains(el)) { endIdx = i; break; }
        }
        scoped = all.slice(startIdx, endIdx);
      }
    }
    const markerIdx = scoped.findIndex(el => el.children.length === 0 && el.textContent?.trim() === marker);
    if (markerIdx === -1) return undefined;
    for (let i = markerIdx + 1; i < scoped.length; i++) {
      const el = scoped[i];
      if ((el.tagName === 'PRE' || el.tagName === 'CODE') && el.textContent?.includes('{')) {
        try {
          const parsed = JSON.parse(el.textContent.trim());
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return el.textContent.trim();
        } catch { /* not JSON */ }
      }
    }
    return undefined;
  }, { id: anchorId, marker });
}

function extractKeys(raw: string | undefined): string[] | undefined {
  if (!raw?.trim()) return undefined;
  try {
    const parsed = JSON.parse(raw.trim());
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return Object.keys(parsed);
  } catch { /* not JSON */ }
  return undefined;
}

export interface ScrapedLyticsRequest {
  doc: DocRequest;
  tryOut: TryOutData & { responseBodyKeys?: string[] };
}

async function scrapeModule(browser: Awaited<ReturnType<typeof chromium.launch>>, module: string): Promise<ScrapedLyticsRequest[]> {
  const moduleUrl = `${BASE}/${module}`;
  const results: ScrapedLyticsRequest[] = [];
  const page = await browser.newPage();
  console.log(`\n📂  Module: ${module}`);

  try {
    // Anchor discovery is occasionally flaky on first load — same class of
    // client-render timing issue seen on every other product's scraper.
    let anchors: Array<{ href: string; text: string }> = [];
    for (let attempt = 1; attempt <= 3 && anchors.length === 0; attempt++) {
      await page.goto(moduleUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.waitForTimeout(1200 * attempt);

      anchors = await page.evaluate(() => {
        const seen = new Set<string>();
        const found: Array<{ href: string; text: string }> = [];
        document.querySelectorAll('a[href^="#"]').forEach(a => {
          const href = a.getAttribute('href') ?? '';
          const text = (a as HTMLElement).innerText?.trim();
          if (!href || seen.has(href) || !text || text.length < 4 || text.length > 80) return;
          if (!document.getElementById(href.slice(1))) return; // dead cross-reference anchor
          seen.add(href);
          found.push({ href, text });
        });
        return found;
      });

      if (anchors.length === 0) {
        console.warn(`   ⚠️  [${module}] Attempt ${attempt}/3 found 0 anchors — retrying`);
      }
    }

    console.log(`   [${module}] Found ${anchors.length} requests`);

    for (const { href, text } of anchors) {
      const anchorId = href.replace('#', '');
      console.log(`   → [${module}] ${text}`);

      const { method, endpoint } = await extractMethodAndEndpoint(page, anchorId);
      const urlParams = await extractParamRows(page, anchorId, 'URL Parameters');
      const queryParams = await extractParamRows(page, anchorId, 'Query Parameters');
      const headerRows = await extractParamRows(page, anchorId, 'Headers');
      const headers: DocHeader[] = headerRows.map(h => ({ name: h.name, required: h.required, description: h.description }));
      const requestBodyRaw = await extractJsonAfterMarker(page, anchorId, 'Sample Request');
      const responseBodyRaw = await extractJsonAfterMarker(page, anchorId, 'Sample Response');

      const doc: DocRequest = {
        module,
        name: text,
        method,
        endpoint,
        description: '',
        params: [...urlParams, ...queryParams],
        headers,
        requestBody: requestBodyRaw ? JSON.parse(requestBodyRaw) : undefined,
        expectedStatusCodes: [200],
        docUrl: `${moduleUrl}${href}`,
      };

      // Unlike Analytics/Automations/Brand Kit/GenAI/Knowledge Vault, this doc's
      // "Open Builder" panel IS live — confirmed by manually filling real
      // authtoken/organization_uid and clicking Send. This panel does NOT send
      // x-cs-api-version, which is documented optional but actually required
      // for routing (see README "Lytics" section) — so it 404s unless that
      // header is also filled in, same gotcha tests/lytics/tryout-lytics.spec.ts
      // works around. bodyContent below is still the raw doc Sample Request
      // text, used as a fallback baseline only if the live Try Out phase has
      // no result for this request.
      const tryOut: TryOutData & { responseBodyKeys?: string[] } = {
        requestName: text,
        params: (doc.params as TryOutField[]).map(p => ({ name: p.name, type: p.type, defaultValue: p.defaultValue })),
        headers: headers.map(h => ({ name: h.name, type: 'text' })),
        bodyContent: requestBodyRaw,
        defaultResponseCode: undefined,
        responseBodyKeys: extractKeys(responseBodyRaw),
      };
      (tryOut as any).responseBodyRaw = responseBodyRaw;

      results.push({ doc, tryOut });
    }
  } catch (err) {
    console.warn(`   ⚠️  [${module}] Failed: ${(err as Error).message}`);
  } finally {
    await page.close();
  }

  return results;
}

export async function scrapeAllLytics(): Promise<ScrapedLyticsRequest[]> {
  const browser = await chromium.launch({ headless: true });
  const results: ScrapedLyticsRequest[] = [];
  try {
    for (const module of MODULES) {
      results.push(...await scrapeModule(browser, module));
    }
  } finally {
    await browser.close();
  }

  const outPath = path.join(__dirname, '../../../reports/scraped-requests-lytics.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`\n✅  Scraped ${results.length} Lytics requests → ${outPath}`);

  // Unlike Automations/Brand Kit/etc., Lytics has a real live Try Out "Send"
  // button (confirmed) — no synthetic baseline is written here. Run
  // `npm run tryout:lytics` (tests/lytics/tryout-lytics.spec.ts) to produce
  // reports/tryout-results-lytics.json.

  return results;
}

scrapeAllLytics().catch(console.error);
