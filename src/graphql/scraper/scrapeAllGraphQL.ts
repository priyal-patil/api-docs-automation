import { chromium, Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import dotenv from 'dotenv';
import { DocRequest, TryOutData } from '../../../config/types';

dotenv.config();

const BASE = 'https://www.contentstack.com/docs/developers/apis/graphql-content-delivery-api';

// Only these 4 modules have runnable "Open Builder" (GraphiQL Explorer)
// examples — confirmed live; they map 1:1 to the 4 folders in the Postman
// collection. Introduction/Schema Generation/Non-Nullable Fields/Change Log/
// etc. are prose-only with no matching Postman requests.
const MODULES = ['queries', 'retrieving-referenced-entries-or-assets', 'query-operators', 'image-transformations'];

export interface ScrapedGraphQLRequest {
  doc: DocRequest;
  tryOut: TryOutData;
  explorerUrl: string;
}

/**
 * Unlike every other product's doc template, these pages are prose + code
 * examples, not structured Headers/URL-Parameter bullet lists — so this
 * extracts (title, query text) pairs instead of DocParam rows. Same
 * flattened-DOM + nearest-heading/nearest-PRE approach as every other
 * scraper (confirmed live: sibling-walking breaks across nested containers,
 * the flattened `body *` array + indexOf is what actually works here too).
 */
async function extractExamples(page: Page): Promise<Array<{ title: string; heading: string; query: string; href: string }>> {
  return page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('body *'));
    const links = all.filter(el => el.tagName === 'A' && (el as HTMLElement).innerText?.trim() === 'Open Builder') as HTMLAnchorElement[];

    const results: Array<{ title: string; heading: string; query: string; href: string }> = [];
    const seenTitles = new Set<string>();

    for (const link of links) {
      const href = link.getAttribute('href') ?? '';
      const titleMatch = /[?&]title=([^&]+)/.exec(href);
      const title = titleMatch ? decodeURIComponent(titleMatch[1].replace(/\+/g, ' ')) : '';
      if (!title || seenTitles.has(title)) continue; // dedupe — same example can appear more than once via multiple nav paths
      seenTitles.add(title);

      const idx = all.indexOf(link);
      let heading = '';
      for (let i = idx; i >= 0; i--) {
        if (/^H[1-6]$/.test(all[i].tagName)) { heading = (all[i] as HTMLElement).innerText.trim(); break; }
      }
      let query = '';
      for (let i = idx; i < all.length; i++) {
        if (/^H[1-6]$/.test(all[i].tagName) && i > idx) break; // next section — stop looking
        if (all[i].tagName === 'PRE' && all[i].textContent?.includes('{')) { query = all[i].textContent.trim(); break; }
      }

      results.push({ title, heading, query, href });
    }
    return results;
  });
}

async function scrapeModule(browser: Awaited<ReturnType<typeof chromium.launch>>, module: string): Promise<ScrapedGraphQLRequest[]> {
  const moduleUrl = `${BASE}/${module}`;
  const results: ScrapedGraphQLRequest[] = [];
  const page = await browser.newPage();
  console.log(`\n📂  Module: ${module}`);

  try {
    let examples: Array<{ title: string; heading: string; query: string; href: string }> = [];
    for (let attempt = 1; attempt <= 3 && examples.length === 0; attempt++) {
      await page.goto(moduleUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.waitForTimeout(1200 * attempt);
      examples = await extractExamples(page);
      if (examples.length === 0) {
        console.warn(`   ⚠️  [${module}] Attempt ${attempt}/3 found 0 examples — retrying`);
      }
    }

    console.log(`   [${module}] Found ${examples.length} examples`);

    for (const { title, heading, query, href } of examples) {
      console.log(`   → [${module}] ${title}`);

      const explorerUrl = `${BASE}/explorer/${href.split('/explorer/')[1] ?? `?title=${encodeURIComponent(title)}&locale=north-america`}`;

      const doc: DocRequest = {
        module,
        name: title,
        method: 'POST', // GraphQL Content Delivery API is always POST, confirmed live (single /stacks/{api_key} endpoint)
        endpoint: 'https://graphql.contentstack.com/stacks/{api_key}',
        description: heading,
        params: [],
        headers: [],
        requestBody: query ? { query } : undefined,
        expectedStatusCodes: [200],
        docUrl: `${moduleUrl}#${href.split('#')[1] ?? ''}`,
      };

      const tryOut: TryOutData = {
        requestName: title,
        params: [],
        headers: [],
        bodyContent: query,
      };

      results.push({ doc, tryOut, explorerUrl });
    }
  } catch (err) {
    console.warn(`   ⚠️  [${module}] Failed: ${(err as Error).message}`);
  } finally {
    await page.close();
  }

  return results;
}

export async function scrapeAllGraphQL(): Promise<ScrapedGraphQLRequest[]> {
  const browser = await chromium.launch({ headless: true });
  const results: ScrapedGraphQLRequest[] = [];
  try {
    for (const module of MODULES) {
      results.push(...await scrapeModule(browser, module));
    }
  } finally {
    await browser.close();
  }

  const outPath = path.join(__dirname, '../../../reports/scraped-requests-graphql.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`\n✅  Scraped ${results.length} GraphQL requests → ${outPath}`);

  return results;
}

scrapeAllGraphQL().catch(console.error);
