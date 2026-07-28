import { chromium, Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import dotenv from 'dotenv';
import { DocRequest, DocParam, DocHeader, TryOutData, TryOutField } from '../../../config/types';

dotenv.config();

const BASE = 'https://www.contentstack.com/docs/developers/apis/administration-api';

// Module slugs come from the rendered nav on the Administration API docs index —
// do NOT guess slugs. "Introduction" has no runnable request examples, so it's
// excluded, same convention as every other product line's Overview/Introduction page.
const MODULES: Record<string, { skipAnchors: string[] }> = {
  'user-session':  { skipAnchors: ['#authentication'] },
  'users':         { skipAnchors: ['#authentication'] },
  'organizations': { skipAnchors: ['#authentication'] },
  'teams':         { skipAnchors: ['#authentication'] },
};

// Headers documented globally across Administration API requests, confirmed live
// via the "Open Builder" panel's data-param-key inputs on all 4 modules.
const HEADER_KEYS = new Set(['authtoken', 'organization_uid', 'stack_api_key', 'content-type']);

export interface ScrapedRequest {
  doc: DocRequest;
  tryOut: TryOutData;
}

// Method badges here are plain <span> elements with no distinguishing class
// (confirmed live — just utility classes like "bg-docs-green-5"), and every
// request on the module's page has one, so an unscoped page-wide query always
// returns the FIRST request's method. Must scope to this request's own section,
// same convention as extractParams/extractHeaders.
async function extractMethodAndEndpoint(page: Page, anchorId: string): Promise<{ method: DocRequest['method']; endpoint: string }> {
  return page.evaluate((id: string) => {
    const all = Array.from(document.querySelectorAll('body *'));
    const candidates = Array.from(document.querySelectorAll(`[id="${id}"]`));
    const anchorEl = candidates.length > 1
      ? (candidates.find(el => el.querySelector('h2') && (el as HTMLElement).offsetParent !== null) ?? candidates.find(el => el.querySelector('h2')) ?? candidates[candidates.length - 1])
      : candidates[0];
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
    const methodEl = scoped.find(el => el.children.length === 0 && /^(GET|POST|PUT|DELETE|PATCH)$/.test(el.textContent?.trim() ?? ''));
    const urlEl = scoped.find(el => el.children.length === 0 && /^https?:\/\//.test(el.textContent?.trim() ?? ''));
    const method = (methodEl?.textContent?.trim() ?? 'GET') as DocRequest['method'];
    const endpoint = urlEl?.textContent?.trim() ?? '';
    return { method, endpoint };
  }, anchorId);
}

async function extractParams(page: Page, anchorId: string): Promise<DocParam[]> {
  return page.evaluate((id: string): DocParam[] => {
    const result: DocParam[] = [];

    function sectionElements(): Element[] {
      const all = Array.from(document.querySelectorAll('body *'));
      const candidates = Array.from(document.querySelectorAll(`[id="${id}"]`));
      const anchorEl = candidates.length > 1
        ? (candidates.find(el => el.querySelector('h2') && (el as HTMLElement).offsetParent !== null) ?? candidates.find(el => el.querySelector('h2')) ?? candidates[candidates.length - 1])
        : candidates[0];
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

    // Strategy 1: legacy HTML tables — only ones within this request's own section
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

    // Strategy 2: new div-based layout — find expanded "Query Parameters"/"URL
    // Parameters" sections (visible after clicking Open Builder) and read
    // .docs-label-primary param names.
    const expandedPanels = scoped.filter(el =>
      el.matches?.('.showhideWrapper, [class*="showhide"]')
    );
    const containers: Element[] = expandedPanels.length > 0 ? expandedPanels : scoped;

    // Re-declared inline — this whole function body runs inside the browser via
    // page.evaluate(), so it cannot see the outer Node-scope HEADER_KEYS constant.
    const headerKeysInline = new Set(['authtoken', 'organization_uid', 'stack_api_key', 'content-type']);

    for (const container of containers) {
      const h4s = Array.from(container.querySelectorAll('h4'));
      for (const h4 of h4s) {
        const title = (h4 as HTMLElement).innerText;
        if (!title.includes('Query Parameters') && !title.includes('URL Parameters')) continue;
        const section = h4.parentElement?.parentElement;
        if (!section) continue;
        const paramRows = Array.from(section.querySelectorAll('.docs-label-primary'));
        for (const nameEl of paramRows) {
          const name = (nameEl as HTMLElement).innerText.trim();
          if (!name || headerKeysInline.has(name.toLowerCase())) continue;
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
async function extractHeaders(page: Page, anchorId: string): Promise<DocHeader[]> {
  return page.evaluate((id: string): DocHeader[] => {
    const result: DocHeader[] = [];

    const all = Array.from(document.querySelectorAll('body *'));
    const idCandidates = Array.from(document.querySelectorAll(`[id="${id}"]`));
    const anchorEl = idCandidates.length > 1
      ? (idCandidates.find(el => el.querySelector('h2')) ?? idCandidates[idCandidates.length - 1])
      : idCandidates[0];
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

/**
 * Reads the Try Out panel's fields WITHOUT executing anything — this doc page
 * has no Send/Execute button (confirmed live), so the panel is purely a static,
 * pre-filled representation of the request. Click Open Builder, wait for render,
 * then read every data-param-key input's default value and the request body.
 */
async function extractTryOut(page: Page, requestName: string, anchorId: string): Promise<TryOutData> {
  const params: TryOutField[] = [];
  const headers: TryOutField[] = [];
  let bodyContent: string | undefined;

  try {
    const clicked = await page.evaluate((id: string): boolean => {
      const idCandidates = Array.from(document.querySelectorAll(`[id="${id}"]`));
      const section = idCandidates.length > 1
        ? (idCandidates.find(el => el.querySelector('h2')) ?? idCandidates[idCandidates.length - 1])
        : idCandidates[0];
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
    await page.waitForTimeout(1000);

    const fields = await page.evaluate((): Array<{ name: string; type: string; defaultValue: string }> => {
      return Array.from(document.querySelectorAll('input[data-param-key]')).map(el => ({
        name: el.getAttribute('data-param-key') ?? '',
        type: (el as HTMLInputElement).type ?? 'text',
        defaultValue: (el as HTMLInputElement).value ?? '',
      })).filter(f => f.name);
    });

    for (const f of fields) {
      if (HEADER_KEYS.has(f.name.toLowerCase())) headers.push(f);
      else params.push(f);
    }

    bodyContent = await page
      .locator('textarea[class*="body"], [class*="body-editor"] textarea')
      .first()
      .innerText()
      .catch(() => undefined);

  } catch {
    // Panel unavailable
  }

  return { requestName, params, headers, bodyContent };
}

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
      const { method, endpoint } = await extractMethodAndEndpoint(workPage, anchorId);
      const tryOut = await extractTryOut(workPage, text, anchorId);
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

export async function scrapeAllAdministration(): Promise<ScrapedRequest[]> {
  const CONCURRENCY = 4;
  const moduleEntries = Object.entries(MODULES);
  const perModuleResults = await runWithConcurrency(
    moduleEntries,
    CONCURRENCY,
    ([module, { skipAnchors }]) => scrapeModule(module, skipAnchors)
  );
  const results = perModuleResults.flat();

  const outPath = path.join(__dirname, '../../../reports/scraped-requests-administration.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`\n✅  Scraped ${results.length} individual requests → ${outPath}`);

  return results;
}

scrapeAllAdministration().catch(console.error);
