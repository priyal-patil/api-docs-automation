import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { TryOutTestResult } from '../../config/types';

const RESULTS_PATH   = path.join(__dirname, '../../reports/tryout-results-graphql.json');
const INDIVIDUAL_DIR = path.join(__dirname, '../../reports/individual-graphql');

function saveResult(result: TryOutTestResult, fileKey?: string): void {
  fs.mkdirSync(INDIVIDUAL_DIR, { recursive: true });
  // NOT lowercased (unlike every other product's saveResult) — confirmed live
  // the doc has two case-differing titles under the same module ("Try 'IN'
  // Operator" vs "Try 'In' Operator") that would otherwise collide and
  // silently drop one result.
  const safeName = (fileKey ?? result.requestName).replace(/[^a-zA-Z0-9]/g, '_');
  fs.writeFileSync(path.join(INDIVIDUAL_DIR, `${safeName}.json`), JSON.stringify(result, null, 2));
}

const scrapedPath = path.join(__dirname, '../../reports/scraped-requests-graphql.json');
const scrapedRequests = fs.existsSync(scrapedPath) ? JSON.parse(fs.readFileSync(scrapedPath, 'utf-8')) : [];

/**
 * Per explicit user instruction: the Explorer's default values (sample-stack
 * api_key/access_token/environment/x-cs-variant-uid) are already correct and
 * working (confirmed live — real e-commerce sample data comes back) — no
 * need to open the param tabs or click Apply. Just navigate and click the
 * Execute icon directly.
 *
 * The response panel renders via a canvas-based Monaco editor (confirmed
 * live — innerHTML has real content but textContent/view-lines are empty),
 * so DOM-scraping the response is unreliable. Instead this instruments
 * window.fetch via page.addInitScript BEFORE navigation (runs on every new
 * document, so it's active from first paint) and reads the real captured
 * network response after clicking Execute — the same technique already
 * proven live for Lytics/this API's own investigation.
 */
test.describe('Phase 2 — GraphQL Live Try Out (GraphiQL Explorer) Tests', () => {
  const targets = scrapedRequests.map((r: any, i: number) => ({
    name: r.doc.name,
    module: r.doc.module,
    explorerUrl: r.explorerUrl,
    docUrl: r.doc.docUrl,
    index: i,
  }));

  for (const target of targets) {
    test(`Try Out: ${target.name}`, async ({ page }) => {
      const flags: string[] = [];
      let actualResponseCode: number | undefined;
      let passed = true;

      await page.addInitScript(() => {
        (window as any).__fetchLog = [];
        const orig = window.fetch;
        window.fetch = function (...args: Parameters<typeof fetch>) {
          const p = orig.apply(this, args);
          p.then(r => r.clone().text().then(t => (window as any).__fetchLog.push({ url: String(args[0]), status: r.status, body: t.slice(0, 4000) })))
           .catch(() => {});
          return p;
        };
      });

      await page.goto(target.explorerUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2000);

      const executeBtn = page.locator('.graphiql-execute-button:visible').first();
      // isVisible() does not auto-wait/retry despite accepting a timeout — it
      // checks once and returns immediately, which flaked under parallel
      // worker load (page still rendering). waitFor() actually polls.
      const hasExecuteBtn = await executeBtn.waitFor({ state: 'visible', timeout: 10000 }).then(() => true).catch(() => false);

      if (!hasExecuteBtn) {
        flags.push('❌  Execute button not found — explorer page may not have loaded correctly');
        passed = false;
        saveResult({ requestName: target.name, endpoint: target.explorerUrl, method: 'POST', docUrl: target.docUrl, passed, flags }, `${target.index}_${target.module}_${target.name}`);
        return;
      }

      await executeBtn.click();
      await page.waitForTimeout(4000);

      const fetchLog: Array<{ url: string; status: number; body: string }> = await page.evaluate(() => (window as any).__fetchLog ?? []);
      const graphqlCall = fetchLog.find(f => f.url.includes('graphql.contentstack.com/stacks'));

      let responseBodyRaw: string | undefined;
      let responseBodyKeys: string[] | undefined;

      if (!graphqlCall) {
        flags.push('❌  Could not capture the live GraphQL response — Execute click may not have fired a real request');
        passed = false;
      } else {
        actualResponseCode = graphqlCall.status;
        responseBodyRaw = graphqlCall.body;
        try {
          const parsed = JSON.parse(graphqlCall.body);
          // GraphQL responses nest under "data" (and/or "errors") — flatten
          // one level so response-body comparison deals with actual field
          // names (e.g. "all_product"), not just the literal word "data".
          responseBodyKeys = parsed.data ? Object.keys(parsed.data) : Object.keys(parsed);
          if (parsed.errors) {
            flags.push(`❌  GraphQL errors in response: ${JSON.stringify(parsed.errors).slice(0, 300)}`);
            passed = false;
          }
        } catch { /* not JSON */ }

        if (actualResponseCode && actualResponseCode >= 400) {
          flags.push(`❌  HTTP ${actualResponseCode}`);
          passed = false;
        } else if (passed) {
          flags.push(`✅  Response: ${actualResponseCode}`);
        }
      }

      saveResult({
        requestName: target.name,
        endpoint: target.explorerUrl,
        method: 'POST',
        docUrl: target.docUrl,
        actualResponseCode,
        responseBodyRaw: responseBodyRaw?.substring(0, 2000),
        responseBodyKeys,
        passed,
        flags,
      }, `${target.index}_${target.module}_${target.name}`);

      if (actualResponseCode !== undefined) {
        expect(actualResponseCode, `Expected 2xx but got ${actualResponseCode} for "${target.name}"`).toBeGreaterThanOrEqual(200);
        expect(actualResponseCode, `Expected 2xx but got ${actualResponseCode} for "${target.name}"`).toBeLessThan(300);
      }
    });
  }

  // Consolidation happens in a standalone step after `playwright test` exits — see consolidateTryout.ts.
});
