import { chromium, Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import dotenv from 'dotenv';
import { DocRequest, DocParam, DocHeader, TryOutData, TryOutField } from '../../../config/types';

dotenv.config();

const BASE = 'https://www.contentstack.com/docs/developers/apis/image-delivery-api';

// Nav-derived module slugs (never guessed — see the CDA scraper's identical
// gotcha: guessed slugs 404 and produce false "no docs exist" findings).
// "Introduction" is excluded — it's a pure overview page with no Open Builder
// sections of its own.
const MODULES: Record<string, { skipAnchors: string[] }> = {
  'automate-optimization': { skipAnchors: [] },
  'control-quality':       { skipAnchors: [] },
  'convert-formats':       { skipAnchors: [] },
  'resize-images':         { skipAnchors: [] },
  'crop-images':           { skipAnchors: [] },
  'fit-mode':              { skipAnchors: [] },
  'trim-images':           { skipAnchors: [] },
  'reorient-images':       { skipAnchors: [] },
  'overlay-settings':      { skipAnchors: [] },
  'image-pad':             { skipAnchors: [] },
  'overlay-pad':           { skipAnchors: [] },
  'background-color':      { skipAnchors: [] },
  'device-pixel-ratio':    { skipAnchors: [] },
  'blur':                  { skipAnchors: [] },
  'frame':                 { skipAnchors: [] },
  'sharpen':               { skipAnchors: [] },
  'saturation':            { skipAnchors: [] },
  'contrast':              { skipAnchors: [] },
  'brightness':            { skipAnchors: [] },
  'resize-filter':         { skipAnchors: [] },
  'canvas':                { skipAnchors: [] },
};

export interface ScrapedRequest {
  doc: DocRequest;
  tryOut: TryOutData;
}

/**
 * Scrape a single module end-to-end: discover anchors, then extract every
 * request. Fully self-contained (own browser, own results array) so it can
 * safely run concurrently with other modules.
 */
async function scrapeModule(module: string, skipAnchors: string[]): Promise<ScrapedRequest[]> {
  const moduleUrl = `${BASE}/${module}`;
  const results: ScrapedRequest[] = [];
  console.log(`\n📂  Module: ${module}`);

  let anchors: Array<{ href: string; text: string }> = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    const anchorBrowser = await chromium.launch({ headless: true });
    try {
      const page = await anchorBrowser.newPage();
      await page.goto(moduleUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await page.waitForTimeout(1500);

      anchors = await page.evaluate((skip: string[]) => {
        const seen = new Set<string>();
        const found: Array<{ href: string; text: string }> = [];
        document.querySelectorAll('a[href^="#"]').forEach(a => {
          const href = a.getAttribute('href') ?? '';
          const text = (a as HTMLElement).innerText?.trim();
          if (!href || seen.has(href) || !text || text.length < 4 || text.length > 80) return;
          if (skip.includes(href)) return;
          if (!document.getElementById(href.slice(1))) return;
          seen.add(href);
          found.push({ href, text });
        });
        return found;
      }, skipAnchors);

      await anchorBrowser.close();
      break;
    } catch (err) {
      console.warn(`   ⚠️  [${module}] Attempt ${attempt}/3 to load module page failed: ${(err as Error).message}`);
      await anchorBrowser.close().catch(() => {});
    }
  }

  if (anchors.length === 0) {
    console.log(`   ⚠️  [${module}] No request anchors found — skipping`);
    return results;
  }

  console.log(`   [${module}] Found ${anchors.length} requests`);

  const BATCH = 8;
  let moduleBrowser = await chromium.launch({ headless: true });
  let workPage = await moduleBrowser.newPage();

  for (let i = 0; i < anchors.length; i++) {
    if (i % BATCH === 0) {
      if (i > 0) {
        await moduleBrowser.close().catch(() => {});
        moduleBrowser = await chromium.launch({ headless: true });
        workPage = await moduleBrowser.newPage();
      }
      console.log(`   🔄  [${module}] Fresh browser (batch ${Math.floor(i / BATCH) + 1})`);
    }

    const { href, text } = anchors[i];
    const fullUrl = `${moduleUrl}${href}`;
    console.log(`   → [${module}] ${text}`);

    try {
      await workPage.goto(fullUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 });
      await workPage.waitForTimeout(1000);

      const anchorId = href.replace('#', '');
      // Every Image Delivery request is a GET (transformation query params
      // appended to an asset URL) — no method badge to read, unlike CDA/CMA.
      const method: DocRequest['method'] = 'GET';
      const endpoint = await extractEndpoint(workPage, anchorId);
      const tryOut = await extractTryOut(workPage, text, anchorId);
      // Extract params AFTER Open Builder is clicked so div-based descriptions are visible
      const params = await extractParams(workPage, anchorId);
      const headers = await extractHeaders(workPage, anchorId);

      results.push({
        doc: {
          module,
          name: text,
          method,
          endpoint,
          description: '',
          params,
          headers,
          expectedStatusCodes: [200],
          docUrl: fullUrl,
        },
        tryOut,
      });

    } catch (err) {
      console.warn(`   ⚠️  [${module}] Skipped "${text}": ${(err as Error).message}`);
    }
  }

  await moduleBrowser.close().catch(() => {});
  return results;
}

/** Run async tasks with a concurrency cap — simple pool, no external deps. */
async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  async function runNext(): Promise<void> {
    const i = nextIndex++;
    if (i >= items.length) return;
    results[i] = await worker(items[i]);
    await runNext();
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => runNext()));
  return results;
}

async function scrapeAllImageDelivery(): Promise<ScrapedRequest[]> {
  const CONCURRENCY = 4;
  const moduleEntries = Object.entries(MODULES);
  const perModuleResults = await runWithConcurrency(
    moduleEntries,
    CONCURRENCY,
    ([module, { skipAnchors }]) => scrapeModule(module, skipAnchors)
  );
  const results = perModuleResults.flat();

  const outPath = path.join(__dirname, '../../../reports/scraped-requests-imagedelivery.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`\n✅  Scraped ${results.length} individual requests → ${outPath}`);

  return results;
}

// Endpoint URL — the static code block shown before Open Builder is even
// clicked (contains {stack_api_key}/{asset_uid} placeholders).
async function extractEndpoint(page: Page, anchorId: string): Promise<string> {
  return page.evaluate((id: string): string => {
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
    const codeEl = scoped.find(el => el.tagName === 'CODE' && (el.textContent ?? '').includes('://')) as HTMLElement | undefined;
    return codeEl?.innerText?.trim() ?? '';
  }, anchorId);
}

async function extractParams(page: Page, anchorId: string): Promise<DocParam[]> {
  return page.evaluate((id: string): DocParam[] => {
    const result: DocParam[] = [];

    function sectionElements(): Element[] {
      const all = Array.from(document.querySelectorAll('body *'));
      const anchorEl = document.getElementById(id);
      if (!anchorEl) return all;
      const startIdx = all.indexOf(anchorEl);
      if (startIdx === -1) return all;
      const ownHeading = anchorEl.querySelector('h1,h2,h3,h4,h5,h6') as HTMLElement | null;
      const ownLevel = ownHeading ? parseInt(ownHeading.tagName[1], 10) : 2;
      let endIdx = all.length;
      for (let i = startIdx + 1; i < all.length; i++) {
        const el = all[i];
        const m = /^H([1-6])$/.exec(el.tagName);
        if (m && parseInt(m[1], 10) <= ownLevel && !anchorEl.contains(el)) { endIdx = i; break; }
      }
      return all.slice(startIdx, endIdx);
    }
    const scoped = sectionElements();

    // Legacy HTML tables (unused on this doc set so far, kept for parity with CDA)
    const tables = scoped.filter(el => el.tagName === 'TABLE') as HTMLTableElement[];
    for (const table of tables) {
      const ths = Array.from(table.querySelectorAll('th')).map(
        (th: Element) => (th as HTMLElement).innerText.toLowerCase()
      );
      const isParam = ths.some(h => h.includes('param') || h.includes('key') || h.includes('name'));
      const isHeader = ths.some(h => h.includes('header'));
      if (!isParam || isHeader) continue;
      const rows = Array.from(table.querySelectorAll('tbody tr'));
      for (const row of rows) {
        const cells = Array.from(row.querySelectorAll('td')).map(
          (td: Element) => (td as HTMLElement).innerText.trim()
        );
        if (cells.length < 2) continue;
        result.push({
          name: cells[0] ?? '',
          type: cells[1] ?? 'string',
          required: cells.some(c => c.toLowerCase().includes('required')),
          description: cells[cells.length - 1] ?? '',
        });
      }
    }
    if (result.length > 0) return result;

    // Div-based layout — "Query Parameters" subsection, expanded after Open Builder
    const expandedPanels = scoped.filter(el =>
      el.matches?.('.showhideWrapper, [class*="showhide"]')
    );
    const containers: Element[] = expandedPanels.length > 0 ? expandedPanels : scoped;

    for (const container of containers) {
      const h4s = Array.from(container.querySelectorAll('h4'));
      for (const h4 of h4s) {
        if (!h4.innerText.includes('Query Parameters')) continue;
        const section = h4.parentElement?.parentElement;
        if (!section) continue;
        const paramRows = Array.from(section.querySelectorAll('.docs-label-primary'));
        for (const nameEl of paramRows) {
          const name = (nameEl as HTMLElement).innerText.trim();
          if (!name) continue;
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
        if (result.length > 0) return result;
      }
    }

    return result;
  }, anchorId);
}

// Image Delivery query parameters carry no header-equivalent (auth is via the
// asset URL itself + a delivery-token-scoped `environment` param, not a
// header) — always returns [] today, kept for shape parity with CDA/CMA and
// in case a future module (e.g. Canvas) adds one.
async function extractHeaders(page: Page, anchorId: string): Promise<DocHeader[]> {
  return page.evaluate((id: string): DocHeader[] => {
    const result: DocHeader[] = [];
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

    const tables = scoped.filter(el => el.tagName === 'TABLE') as HTMLTableElement[];
    for (const table of tables) {
      const ths = Array.from(table.querySelectorAll('th')).map(
        (th: Element) => (th as HTMLElement).innerText.toLowerCase()
      );
      if (!ths.some(h => h.includes('header'))) continue;
      const rows = Array.from(table.querySelectorAll('tbody tr'));
      for (const row of rows) {
        const cells = Array.from(row.querySelectorAll('td')).map(
          (td: Element) => (td as HTMLElement).innerText.trim()
        );
        if (cells.length < 2) continue;
        result.push({
          name: cells[0] ?? '',
          required: cells.some(c => c.toLowerCase().includes('required')),
          description: cells[cells.length - 1] ?? '',
        });
      }
    }
    if (result.length > 0) return result;

    const expandedPanels = scoped.filter(el =>
      el.matches?.('.showhideWrapper, [class*="showhide"]')
    );
    const containers: Element[] = expandedPanels.length > 0 ? expandedPanels : scoped;

    for (const container of containers) {
      const h4s = Array.from(container.querySelectorAll('h4'));
      for (const h4 of h4s) {
        if (!(h4 as HTMLElement).innerText.includes('Headers')) continue;
        const section = h4.parentElement?.parentElement;
        if (!section) continue;
        const nameEls = Array.from(section.querySelectorAll('.docs-label-primary'));
        for (const nameEl of nameEls) {
          const name = (nameEl as HTMLElement).innerText.trim();
          if (!name) continue;
          const row = nameEl.closest('div');
          const requiredEl = row?.querySelector('.text-docs-amethyst-accent');
          const descEl = row?.querySelector('.show-hide-params-desc, .docs-s-body-regular');
          result.push({
            name,
            required: !!requiredEl,
            description: (descEl as HTMLElement)?.innerText?.trim() ?? '',
          });
        }
        if (result.length > 0) return result;
      }
    }

    return result;
  }, anchorId);
}

async function extractTryOut(page: Page, requestName: string, anchorId: string): Promise<TryOutData> {
  let defaultResponseCode: number | undefined;
  const params: TryOutField[] = [];
  const headers: TryOutField[] = [];

  try {
    // Check for a "ResponseNNN" heading visible BEFORE clicking anything —
    // confirmed live this never appears pre-Send on this doc platform (no
    // stale-session default like CDA/CMA sometimes show), but check anyway
    // for parity with the "before Send" requirement.
    const preCode = await readResponseHeadingCode(page);
    if (preCode && preCode >= 400) defaultResponseCode = preCode;

    // Click the Open Builder button that belongs to THIS section (matched by
    // anchor id) — same row-scoped approach as the CDA scraper.
    const clicked = await page.evaluate((id: string): boolean => {
      const section = document.getElementById(id);
      if (!section) return false;
      const row = section.closest('.flex.items-center.justify-between');
      if (row) {
        const directBtn = Array.from(row.children).find(
          el => el.tagName === 'BUTTON' && (el as HTMLElement).innerText?.trim() === 'Open Builder'
        ) as HTMLButtonElement | undefined;
        if (directBtn) { directBtn.click(); return true; }
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
    }, anchorId);

    if (!clicked) {
      const openBtn = page.locator('button:has-text("Open Builder")').first();
      if (await openBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await openBtn.click();
      }
    }
    await page.waitForTimeout(1200);

    // Read all data-param-key fields including their pre-filled example values
    const fields = await page.evaluate((): Array<{ name: string; type: string; defaultValue: string }> => {
      return Array.from(document.querySelectorAll('input[data-param-key]')).map(el => ({
        name: el.getAttribute('data-param-key') ?? '',
        type: (el as HTMLInputElement).type ?? 'text',
        defaultValue: (el as HTMLInputElement).value ?? (el as HTMLInputElement).placeholder ?? '',
      })).filter(f => f.name);
    });

    // Every field on this doc set is a query param — there is no header
    // equivalent (see extractHeaders comment above).
    for (const f of fields) params.push(f);

  } catch {
    // Panel unavailable
  }

  return { requestName, params, headers, defaultResponseCode };
}

// The Response code lives in a heading whose own text is "Response" + the
// status code glued together (e.g. "Response200", "Response422") — confirmed
// live via DOM inspection; this doc platform has no `.response-body` panel
// like CDA/CMA, since a successful call returns a rendered <img>, not JSON.
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

scrapeAllImageDelivery().catch(console.error);
