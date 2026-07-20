import * as fs from 'fs';
import * as path from 'path';
import { ComparisonResult, Mismatch, DocRequest, TryOutData, TryOutTestResult } from '../../../config/types';

/**
 * Two-way comparison (no Postman collection exists for this API — everything
 * runs against the doc's own live Try Out panel):
 *   A = Doc description (scraped params)
 *   B = Try Out panel (fields scraped + live execution result from Playwright)
 *
 * Checks:
 *  1. Param field gaps: Doc ↔ Try Out
 *  2. 4xx/5xx shown in the Try Out panel BEFORE Send is clicked (scrape-time
 *     AND live-run-time — the scraper and the tryout spec each observe this
 *     independently)
 *  3. 4xx/5xx returned AFTER Send is clicked (live run only — this is the
 *     closest equivalent to Newman's execution-failure check in the other
 *     modules, since there is no Postman/Newman phase here)
 */
export async function runComparisonImageDelivery(): Promise<ComparisonResult[]> {
  const scrapedPath = path.join(__dirname, '../../../reports/scraped-requests-imagedelivery.json');
  if (!fs.existsSync(scrapedPath)) {
    throw new Error('scraped-requests-imagedelivery.json not found — run `npm run scrape:imagedelivery` first');
  }
  const scraped: Array<{ doc: DocRequest; tryOut: TryOutData }> = JSON.parse(
    fs.readFileSync(scrapedPath, 'utf-8')
  );

  const tryOutResultsPath = path.join(__dirname, '../../../reports/tryout-results-imagedelivery.json');
  const tryOutResults: TryOutTestResult[] = fs.existsSync(tryOutResultsPath)
    ? JSON.parse(fs.readFileSync(tryOutResultsPath, 'utf-8'))
    : [];

  const results: ComparisonResult[] = [];

  for (const { doc, tryOut } of scraped) {
    const mismatches: Mismatch[] = [];
    const tryOutResult = findByName(doc.name, tryOutResults, r => r.requestName);

    // ── 1. Param/header field gaps: Doc ↔ Try Out ─────────────────────────
    // Merged rather than compared param-to-param and header-to-header: this
    // doc set's "Headers" subsection (e.g. Automate Optimization's `accept`)
    // renders in the SAME data-param-key input list as query params in the
    // Try Out builder — the scraper has no reliable way to tell them apart
    // on this doc platform (unlike CDA's fixed HEADER_KEYS set), so the only
    // meaningful check is "every doc-described field ↔ every Try Out field",
    // regardless of which bucket each side puts it in.
    // Only compare when the scraper actually found doc description fields —
    // an empty set means the scraper found nothing to compare against (not
    // that the endpoint genuinely has zero fields), so skip rather than
    // false-flag every Try Out field as "extra".
    const docFields = [...doc.params, ...doc.headers.map(h => ({ ...h, type: 'header' }))];
    const tryOutFields = [...tryOut.params, ...tryOut.headers];
    if (docFields.length > 0) {
      const tryOutFieldNames = new Set(tryOutFields.map(p => norm(p.name)));
      for (const p of docFields) {
        if (!tryOutFieldNames.has(norm(p.name))) {
          mismatches.push({
            type: 'missing_in_tryout', field: p.name,
            source: 'Doc → Try Out',
            detail: `Doc describes param "${p.name}" but it is NOT present in the Try Out panel`,
            severity: p.required ? 'error' : 'warning',
          });
        }
      }
      const docFieldNames = new Set(docFields.map(p => norm(p.name)));
      for (const f of tryOutFields) {
        if (!docFieldNames.has(norm(f.name))) {
          mismatches.push({
            type: 'extra_in_tryout', field: f.name,
            source: 'Try Out → Doc',
            detail: `Try Out panel has field "${f.name}" not mentioned in doc description`,
            severity: 'warning',
          });
        }
      }
    } else {
      mismatches.push({
        type: 'missing_in_doc',
        source: 'Doc → Try Out',
        detail: `Scraper found no description params for "${doc.name}" to compare against the Try Out panel`,
        severity: 'info',
      });
    }

    // ── 2. Default error code shown BEFORE Send is clicked ─────────────────
    // Checked at scrape time (tryOut.defaultResponseCode) and independently
    // at live-run time (tryOutResult.defaultResponseCode) — either source
    // catching a 4xx/5xx is a doc bug worth flagging.
    if (tryOut.defaultResponseCode && tryOut.defaultResponseCode >= 400) {
      mismatches.push({
        type: 'default_error_response',
        source: 'Try Out panel (scrape time)',
        detail: `Try Out panel showed ${tryOut.defaultResponseCode} as default before Send is clicked (observed during scraping)`,
        severity: 'error',
      });
    }
    if (tryOutResult?.defaultResponseCode && tryOutResult.defaultResponseCode >= 400) {
      mismatches.push({
        type: 'default_error_response',
        source: 'Try Out panel (live run)',
        detail: `Try Out panel showed ${tryOutResult.defaultResponseCode} as default before Send is clicked (observed during live Try Out run)`,
        severity: 'error',
      });
    }

    // ── 3. Error returned AFTER Send is clicked (live run) ──────────────────
    if (tryOutResult?.actualResponseCode !== undefined && !tryOutResult.passed) {
      mismatches.push({
        type: 'tryout_execution_failure',
        source: 'Try Out panel (live run)',
        detail: `Try Out panel returned ${tryOutResult.actualResponseCode} after clicking Send Request`,
        severity: 'error',
      });
    } else if (!tryOutResult) {
      mismatches.push({
        type: 'tryout_execution_failure',
        source: 'Try Out panel (live run)',
        detail: `No live Try Out result found for "${doc.name}" — run npm run tryout:imagedelivery`,
        severity: 'warning',
      });
    }

    const errors   = mismatches.filter(m => m.severity === 'error').length;
    const warnings = mismatches.filter(m => m.severity === 'warning').length;

    results.push({
      requestName: doc.name,
      endpoint:    doc.endpoint,
      method:      doc.method,
      docUrl:      doc.docUrl,
      mismatches,
      status: errors > 0 ? 'fail' : warnings > 0 ? 'warning' : 'pass',
    });
  }

  const outPath = path.join(__dirname, '../../../reports/comparison-results-imagedelivery.json');
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));

  const pass = results.filter(r => r.status === 'pass').length;
  const warn = results.filter(r => r.status === 'warning').length;
  const fail = results.filter(r => r.status === 'fail').length;
  console.log(`\n📊  Comparison done — ✅ ${pass} pass  ⚠️ ${warn} warning  ❌ ${fail} fail`);
  console.log(`📝  Results → ${outPath}`);

  return results;
}

function norm(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function sortedWords(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9 ]/g, '').split(/\s+/).sort().join('');
}

function findByName<T>(
  docName: string,
  list: T[],
  getName: (item: T) => string
): T | undefined {
  const target = norm(docName);
  const targetSorted = sortedWords(docName);
  return list.find(item => norm(getName(item)) === target)
    ?? list.find(item => {
        const n = norm(getName(item));
        return n.includes(target) || target.includes(n);
      })
    ?? list.find(item => sortedWords(getName(item)) === targetSorted);
}

runComparisonImageDelivery().catch(console.error);
