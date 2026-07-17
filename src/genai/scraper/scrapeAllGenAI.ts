import { chromium, Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import dotenv from 'dotenv';
import { DocRequest, DocParam, DocHeader, TryOutData, TryOutField, TryOutTestResult } from '../../../config/types';

dotenv.config();

const BASE = 'https://www.contentstack.com/docs/developers/apis/generative-ai-api';

// Only one module page, one endpoint — confirmed live via the rendered nav.
const MODULES = ['generative-ai'];

export interface ScrapedGenAIRequest {
  doc: DocRequest;
  tryOut: TryOutData & { responseBodyKeys?: string[] };
}

/** Same doc framework as Automations/Brand Kit — method+endpoint row is the next sibling of the heading wrapper. */
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

/**
 * Finds the JSON code block immediately following a text marker, scoped to
 * this request's own section, and returns the RAW text. For GenAI the
 * "Sample Response" marker is followed by literal text ("Streaming
 * dictionary response"), not JSON — extractKeys() below correctly returns
 * undefined for it, and the comparator skips response-body comparison
 * gracefully, same as it already does when a field is unavailable elsewhere.
 */
async function extractTextAfterMarker(page: Page, anchorId: string, marker: string): Promise<string | undefined> {
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
      if (el.tagName === 'PRE' || el.tagName === 'CODE') {
        const text = el.textContent?.trim();
        if (text) return text;
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
  } catch { /* not JSON — e.g. GenAI's streaming response placeholder text */ }
  return undefined;
}

async function scrapeModule(browser: Awaited<ReturnType<typeof chromium.launch>>, module: string): Promise<ScrapedGenAIRequest[]> {
  const moduleUrl = `${BASE}/${module}`;
  const results: ScrapedGenAIRequest[] = [];
  const page = await browser.newPage();
  console.log(`\n📂  Module: ${module}`);

  try {
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
          if (!href || seen.has(href) || !text || text.length < 2 || text.length > 80) return;
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
      const requestBodyRaw = await extractTextAfterMarker(page, anchorId, 'Sample Request');
      const responseBodyRaw = await extractTextAfterMarker(page, anchorId, 'Sample Response');
      const requestBodyKeys = extractKeys(requestBodyRaw);

      const doc: DocRequest = {
        module,
        name: text,
        method,
        endpoint,
        description: '',
        params: [...urlParams, ...queryParams],
        headers,
        requestBody: requestBodyKeys ? JSON.parse(requestBodyRaw!) : undefined,
        expectedStatusCodes: [200],
        docUrl: `${moduleUrl}${href}`,
      };

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

export async function scrapeAllGenAI(): Promise<ScrapedGenAIRequest[]> {
  const browser = await chromium.launch({ headless: true });
  const results: ScrapedGenAIRequest[] = [];
  try {
    for (const module of MODULES) {
      results.push(...await scrapeModule(browser, module));
    }
  } finally {
    await browser.close();
  }

  const outPath = path.join(__dirname, '../../../reports/scraped-requests-genai.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`\n✅  Scraped ${results.length} Generative AI requests → ${outPath}`);

  const tryOutResults: TryOutTestResult[] = results.map(({ doc, tryOut }) => ({
    requestName: doc.name,
    endpoint: doc.endpoint,
    method: doc.method,
    docUrl: doc.docUrl,
    responseBodyKeys: tryOut.responseBodyKeys,
    passed: true,
    flags: ['ℹ️  Generative AI API docs have no Try Out "Send" button — static doc Sample Response used as baseline (response is a streaming, non-JSON body — no keys to compare)'],
  }));
  const tryOutPath = path.join(__dirname, '../../../reports/tryout-results-genai.json');
  fs.writeFileSync(tryOutPath, JSON.stringify(tryOutResults, null, 2));
  console.log(`✅  Wrote synthetic Try Out baseline → ${tryOutPath}`);

  return results;
}

scrapeAllGenAI().catch(console.error);
