import { chromium, Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import dotenv from 'dotenv';
import { DocRequest, DocParam, DocHeader, TryOutData, TryOutField } from '../../../config/types';

dotenv.config();

const BASE = 'https://www.contentstack.com/docs/developers/apis/content-management-api';

// API modules and the anchor patterns that identify real requests (not nav/misc links)
const MODULES: Record<string, { skipAnchors: string[] }> = {
  'stacks':         { skipAnchors: ['#authentication'] },
  'content-types':  { skipAnchors: ['#authentication'] },
  'global-fields':  { skipAnchors: ['#authentication'] },
  'entries':        { skipAnchors: ['#authentication'] },
  'assets':         { skipAnchors: ['#authentication'] },
  'taxonomy':       { skipAnchors: ['#authentication'] },
  'environment':    { skipAnchors: ['#authentication'] },  // note: singular in the doc URL
  'workflows':      { skipAnchors: ['#authentication'] },
  'languages':      { skipAnchors: ['#authentication'] },
  'roles':          { skipAnchors: ['#authentication'] },
  'webhooks':       { skipAnchors: ['#authentication'] },
  'audit-log':      { skipAnchors: ['#authentication'] },
  'publish-queue':  { skipAnchors: ['#authentication'] },
  'labels':         { skipAnchors: ['#authentication'] },
  'releases':       { skipAnchors: ['#authentication'] },
  'tokens':         { skipAnchors: ['#authentication'] },
  'extensions':     { skipAnchors: ['#authentication'] },
  'branches':       { skipAnchors: ['#authentication'] },
  'aliases':        { skipAnchors: ['#authentication'] },
  'bulk-operations':{ skipAnchors: ['#authentication'] },
  'entry-variants': { skipAnchors: ['#authentication'] },
  'variant-groups': { skipAnchors: ['#authentication'] },
  'metadata-for-entries-and-assets':                    { skipAnchors: ['#authentication'] },
  'embed-entries-and-assets-in-the-rich-text-editor':   { skipAnchors: ['#authentication'] },
  'job-status':     { skipAnchors: ['#authentication'] },
};
// Module slugs come from the rendered nav on the CMA docs index — do NOT guess
// slugs (e.g. metadata lives at "metadata-for-entries-and-assets", not "metadata").

export interface ScrapedRequest {
  doc: DocRequest;
  tryOut: TryOutData;
}

async function extractMethod(page: Page): Promise<DocRequest['method']> {
  const text = await page
    .locator('[class*="method-badge"], [class*="http-method"], [class*="method-label"], .swaggerButton')
    .first()
    .innerText()
    .catch(() => 'GET');
  const match = text.match(/\b(GET|POST|PUT|DELETE|PATCH)\b/i);
  return (match ? match[1].toUpperCase() : 'GET') as DocRequest['method'];
}

async function extractEndpoint(page: Page): Promise<string> {
  return page
    .locator('[class*="endpoint-url"], [class*="request-url"] code, [class*="api-url"] code')
    .first()
    .innerText()
    .catch(() => '');
}

async function extractParams(page: Page, anchorId: string): Promise<DocParam[]> {
  return page.evaluate((id: string): DocParam[] => {
    const result: DocParam[] = [];
    const HEADER_KEYS = new Set(['api_key', 'authtoken', 'management_token', 'branch', 'authorization', 'x-cs-variant-uid', 'organization_uid']);

    // Bound this request's own section: from its heading up to (but not including)
    // the next heading. CMA doc pages list every request in a module on ONE page,
    // so an unscoped table/div query can grab a DIFFERENT request's table entirely —
    // confirmed bug: every Assets endpoint on this page returned "Upload asset"'s
    // form-data table because it was simply the first "param" table found on the page.
    function sectionElements(): Element[] {
      const all = Array.from(document.querySelectorAll('body *'));
      // Some CMA doc pages reuse the SAME id twice: once as a small "up next"
      // preview heading (h5) embedded near the END of the PRECEDING section,
      // and once as the real h2 section further down. getElementById always
      // returns the FIRST match (the preview), so this section would silently
      // inherit whatever comes right after that preview — actually the
      // preceding section's own content. Confirmed live: "Create content type
      // with taxonomy" wrongly picked up "include_branch" from "Create content
      // type with custom asset field"'s Query Parameters this way. The real
      // section heading is always h2, so prefer the LAST element with this id.
      const candidates = Array.from(document.querySelectorAll(`[id="${id}"]`));
      const anchorEl = candidates.length > 1
        ? (candidates.find(el => el.querySelector('h2') && (el as HTMLElement).offsetParent !== null) ?? candidates.find(el => el.querySelector('h2')) ?? candidates[candidates.length - 1])
        : candidates[0];
      if (!anchorEl) return all;
      const startIdx = all.indexOf(anchorEl);
      if (startIdx === -1) return all;
      // Determine the level of THIS request's own title heading (usually h2,
      // nested inside the anchor div) — only a heading at that level or
      // shallower marks the start of the NEXT request. Sub-headings like
      // "URL Parameters" / "Query Parameters" / "Headers" are deeper (h4) and
      // belong to the CURRENT section, so they must not end it early.
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

    // Strategy 2: new div-based layout — find expanded "Query Parameters" sections
    // (visible after clicking Open Builder) and read .docs-label-primary param names.
    // Only read from sections that are currently expanded (grid-template-rows: 1fr),
    // and further restrict to panels within this request's own section.
    const expandedPanels = scoped.filter(el =>
      el.matches?.('.showhideWrapper, [class*="showhide"]')
    );
    const containers: Element[] = expandedPanels.length > 0 ? expandedPanels : scoped;

    for (const container of containers) {
      const h4s = Array.from(container.querySelectorAll('h4'));
      for (const h4 of h4s) {
        if (!(h4 as HTMLElement).innerText.includes('Query Parameters')) continue;
        // The h4's own closest('div') is only its tight title wrapper — it does
        // NOT contain the sibling div holding the actual param rows. Real
        // structure: <div (subsection)><div><h4/></div><div>...rows...</div></div>
        // so the correct scope is the h4's GRANDPARENT.
        const section = h4.parentElement?.parentElement;
        if (!section) continue;
        const paramRows = Array.from(section.querySelectorAll('.docs-label-primary'));
        for (const nameEl of paramRows) {
          const name = (nameEl as HTMLElement).innerText.trim();
          if (!name || HEADER_KEYS.has(name.toLowerCase())) continue;
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
        if (result.length > 0) return result; // take params from first expanded section found
      }
    }

    return result;
  }, anchorId);
}

async function extractHeaders(page: Page, anchorId: string): Promise<DocHeader[]> {
  return page.evaluate((id: string): DocHeader[] => {
    const result: DocHeader[] = [];

    // Same section-scoping as extractParams — see comment there, including the
    // duplicate-id "preview heading" fix (prefer the real h2 section).
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

    // Strategy 1: legacy HTML tables — only ones within this request's own section
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

    // Strategy 2: new div-based layout — same shape as extractParams's Strategy 2,
    // but looking for the "Headers" subsection instead of "Query Parameters". This
    // was previously missing entirely, which made doc.headers come back empty for
    // every request on pages using the new UI (e.g. api_key/authtoken/organization_uid
    // on Stacks endpoints were documented but never captured).
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
  let bodyContent: string | undefined;

  try {
    // Check for error code visible BEFORE clicking anything
    const preCode = await page
      .locator('.response-body .text-docs-strong span')
      .first()
      .innerText({ timeout: 1000 })
      .catch(() => '');
    if (preCode) {
      const code = parseInt(preCode.match(/\d{3}/)?.[0] ?? '0', 10);
      if (code >= 400) defaultResponseCode = code;
    }

    // Click the Open Builder button that belongs to THIS section (matched by anchor id),
    // not just the first one on the page — critical for long pages with many sections.
    const clicked = await page.evaluate((id: string): boolean => {
      // Prefer the real h2 section over a duplicate-id "preview" heading (h5)
      // some pages embed near the end of the PRECEDING section — see the
      // identical fix + explanation in extractParams's sectionElements().
      const idCandidates = Array.from(document.querySelectorAll(`[id="${id}"]`));
      const section = idCandidates.length > 1
        ? (idCandidates.find(el => el.querySelector('h2')) ?? idCandidates[idCandidates.length - 1])
        : idCandidates[0];
      if (!section) return false;
      // The "Open Builder" button is a DIRECT child of the flex row that contains the heading.
      // Using querySelector finds nested buttons (like the copy-link button) first — wrong.
      const row = section.closest('.flex.items-center.justify-between');
      if (row) {
        const directBtn = Array.from(row.children).find(
          el => el.tagName === 'BUTTON' && (el as HTMLElement).innerText?.trim() === 'Open Builder'
        ) as HTMLButtonElement | undefined;
        if (directBtn) { directBtn.click(); return true; }
      }
      // Fallback: find the nearest Open Builder button after this section
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
      // Fallback to first visible Open Builder (works for single-request pages)
      const openBtn = page.locator('button:has-text("Open Builder")').first();
      if (await openBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await openBtn.click();
      }
    }
    await page.waitForTimeout(1200);

    // Read all data-param-key fields including their pre-filled default values
    const fields = await page.evaluate((): Array<{ name: string; type: string; defaultValue: string }> => {
      return Array.from(document.querySelectorAll('input[data-param-key]')).map(el => ({
        name: el.getAttribute('data-param-key') ?? '',
        type: (el as HTMLInputElement).type ?? 'text',
        defaultValue: (el as HTMLInputElement).value ?? '',
      })).filter(f => f.name);
    });

    // Split into params vs headers based on known CMA header names
    const HEADER_KEYS = new Set(['api_key', 'authtoken', 'management_token', 'branch', 'authorization', 'x-cs-variant-uid', 'organization_uid']);
    for (const f of fields) {
      if (HEADER_KEYS.has(f.name)) headers.push(f);
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

  return { requestName, params, headers, bodyContent, defaultResponseCode };
}

/**
 * Scrape a single module end-to-end: discover anchors, then extract every
 * request. Fully self-contained (own browsers, own results array) so it can
 * safely run concurrently with other modules — nothing is shared across
 * modules until the caller merges the returned arrays.
 */
async function scrapeModule(module: string, skipAnchors: string[]): Promise<ScrapedRequest[]> {
  const moduleUrl = `${BASE}/${module}`;
  const results: ScrapedRequest[] = [];
  console.log(`\n📂  Module: ${module}`);

  // Use a short-lived browser just to discover anchor links on the module page.
  // Retry up to 3 times — page-load timeouts on one module must not kill the run.
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
          // Some pages contain cross-reference links to anchors that don't
          // exist on THIS page (e.g. a mention of a request documented on a
          // different module's page). Navigating to a dead anchor leaves our
          // section-scoping with nothing to bound to, so it falls back to
          // scanning the whole page — silently contaminating the result with
          // an unrelated request's params. Skip anchors that don't resolve here.
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

  // Restart the entire browser every 8 requests to prevent memory exhaustion
  const BATCH = 8;
  let moduleBrowser = await chromium.launch({ headless: true });
  let workPage = await moduleBrowser.newPage();

  for (let i = 0; i < anchors.length; i++) {
    // Restart browser at start of each batch
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

      const method = await extractMethod(workPage);
      const endpoint = await extractEndpoint(workPage);
      const anchorId = href.replace('#', '');
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

export async function scrapeAllCMA(): Promise<ScrapedRequest[]> {
  // Modules are fully independent (own browsers, own doc pages) so they can
  // run concurrently. Capped at 4 — headless Chromium instances are memory-
  // hungry, and going higher risks the same OOM crashes the per-batch browser
  // restart was built to avoid.
  const CONCURRENCY = 4;
  const moduleEntries = Object.entries(MODULES);
  const perModuleResults = await runWithConcurrency(
    moduleEntries,
    CONCURRENCY,
    ([module, { skipAnchors }]) => scrapeModule(module, skipAnchors)
  );
  const results = perModuleResults.flat();

  const outPath = path.join(__dirname, '../../../reports/scraped-requests-cma.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`\n✅  Scraped ${results.length} individual requests → ${outPath}`);

  return results;
}

scrapeAllCMA().catch(console.error);
