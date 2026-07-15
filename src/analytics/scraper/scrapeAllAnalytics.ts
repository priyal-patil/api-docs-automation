import { chromium, Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import dotenv from 'dotenv';
import { DocRequest, DocParam, DocHeader, TryOutData, TryOutField, TryOutTestResult } from '../../../config/types';

dotenv.config();

const BASE = 'https://www.contentstack.com/docs/developers/apis/analytics-api';

// Analytics API has one request per page (unlike CDA/CMA's one-page-per-module
// with many anchors) — confirmed live: 7 "create job" endpoints + Retrieve Data.
// Slugs come from the rendered left nav — do NOT guess them.
const PAGES = [
  'subscription-usage',
  'device-usage',
  'usage-analytics',
  'top-urls',
  'status-code',
  'cache-usage',
  'sdk-usage',
  'retrieve-data',
];

const HEADER_KEYS = new Set(['authtoken']);

export interface ScrapedAnalyticsRequest {
  doc: DocRequest;
  tryOut: TryOutData;
}

async function extractEndpoint(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = Array.from(document.querySelectorAll('main code')).find(c => c.textContent?.includes('https://'));
    return el?.textContent?.trim() ?? '';
  });
}

/**
 * Analytics doc pages render every param/header row TWICE (identical content,
 * identical DOM path) — a responsive-layout duplicate, not a distinct
 * "Try Out panel" copy (confirmed: clicking "Open Builder" adds only a region
 * selector + response preview, no new fields). So doc params/headers and
 * "Try Out" params/headers are the same data — dedupe by name.
 */
async function extractParamRows(page: Page, headingText: string): Promise<DocParam[]> {
  return page.evaluate((heading: string): DocParam[] => {
    const seen = new Set<string>();
    const result: DocParam[] = [];
    const h4s = Array.from(document.querySelectorAll('main h4'));
    for (const h4 of h4s) {
      if (!(h4 as HTMLElement).innerText.trim().startsWith(heading)) continue;
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
  }, headingText);
}

/** The doc's static declared response — the source of truth to compare live Newman output against. */
async function extractSampleResponseKeys(page: Page): Promise<string[] | undefined> {
  return page.evaluate((): string[] | undefined => {
    const all = Array.from(document.querySelectorAll('main *'));
    const marker = all.find(el => el.children.length === 0 && el.textContent?.trim() === 'Sample Response');
    if (!marker) return undefined;
    const markerIdx = all.indexOf(marker);
    for (let i = markerIdx + 1; i < all.length; i++) {
      const el = all[i];
      if ((el.tagName === 'PRE' || el.tagName === 'CODE') && el.textContent?.includes('{')) {
        try {
          const parsed = JSON.parse(el.textContent.trim());
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return Object.keys(parsed);
        } catch { /* not JSON */ }
      }
    }
    return undefined;
  });
}

async function scrapePage(browser: Awaited<ReturnType<typeof chromium.launch>>, slug: string): Promise<ScrapedAnalyticsRequest | null> {
  const docUrl = `${BASE}/${slug}`;
  console.log(`   → [analytics] ${slug}`);
  const page = await browser.newPage();
  try {
    await page.goto(docUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(1000);

    const name = (await page.locator('main h1').first().innerText().catch(() => slug)).trim();
    const endpoint = await extractEndpoint(page);
    const params = await extractParamRows(page, 'Query Parameters');
    const urlParams = await extractParamRows(page, 'URL Parameters');
    const headersAll = await extractParamRows(page, 'Headers');
    const headers: DocHeader[] = headersAll.map(h => ({ name: h.name, required: h.required, description: h.description }));
    const sampleResponseKeys = await extractSampleResponseKeys(page);

    const doc: DocRequest = {
      module: 'analytics',
      name,
      method: 'GET',
      endpoint,
      description: '',
      params: [...urlParams, ...params],
      headers,
      expectedStatusCodes: [200],
      docUrl,
    };

    // No live Try Out execution exists for this API (no Send button) — the
    // "Try Out" fields are identical to the doc's own static param list.
    const tryOut: TryOutData & { responseBodyKeys?: string[] } = {
      requestName: name,
      params: (doc.params as TryOutField[]).map(p => ({ name: p.name, type: p.type, defaultValue: p.defaultValue })),
      headers: headers.map(h => ({ name: h.name, type: 'text' })),
      bodyContent: undefined,
      defaultResponseCode: undefined,
      responseBodyKeys: sampleResponseKeys,
    };

    return { doc, tryOut };
  } catch (err) {
    console.warn(`   ⚠️  [analytics] Skipped "${slug}": ${(err as Error).message}`);
    return null;
  } finally {
    await page.close();
  }
}

export async function scrapeAllAnalytics(): Promise<ScrapedAnalyticsRequest[]> {
  const browser = await chromium.launch({ headless: true });
  const results: ScrapedAnalyticsRequest[] = [];
  try {
    for (const slug of PAGES) {
      const scraped = await scrapePage(browser, slug);
      if (scraped) results.push(scraped);
    }
  } finally {
    await browser.close();
  }

  const outPath = path.join(__dirname, '../../../reports/scraped-requests-analytics.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`\n✅  Scraped ${results.length} Analytics requests → ${outPath}`);

  // Synthetic "Try Out results" file — there is no live Send button to execute,
  // so the doc's static Sample Response stands in as the baseline for the
  // response-body comparison against live Newman output (see compareAnalytics.ts).
  const tryOutResults: TryOutTestResult[] = results.map(({ doc, tryOut }) => ({
    requestName: doc.name,
    endpoint: doc.endpoint,
    method: doc.method,
    docUrl: doc.docUrl,
    responseBodyKeys: (tryOut as any).responseBodyKeys,
    passed: true,
    flags: ['ℹ️  Analytics API docs have no Try Out "Send" button — static doc Sample Response used as baseline'],
  }));
  const tryOutPath = path.join(__dirname, '../../../reports/tryout-results-analytics.json');
  fs.writeFileSync(tryOutPath, JSON.stringify(tryOutResults, null, 2));
  console.log(`✅  Wrote synthetic Try Out baseline → ${tryOutPath}`);

  return results;
}

scrapeAllAnalytics().catch(console.error);
