import * as fs from 'fs';
import * as path from 'path';
import dotenv from 'dotenv';
import { fetchPostmanCollection } from '../../shared/postman/fetchCollection';
import { ComparisonResult, Mismatch, DocRequest, TryOutData, TryOutTestResult, NewmanResult, PostmanRequest } from '../../../config/types';

dotenv.config();

const POSTMAN_ANALYTICS_COLLECTION_ID = process.env.POSTMAN_ANALYTICS_COLLECTION_ID ?? '';

/**
 * Three-way comparison for Analytics API (no live Try Out execution exists):
 *   A = Doc description (scraped params/headers)
 *   B = Doc's static Sample Response (stands in for a live "Try Out" result)
 *   C = Postman collection definition + Newman execution results
 *
 * Checks:
 *  1. Param/header field gaps: Doc ↔ Postman
 *  2. Response body field gaps: Newman actual response ↔ doc's declared Sample Response
 *  3. Newman execution failures (Postman request returned 4xx/5xx)
 *  4. Coverage: endpoints in docs but missing from Postman, and vice versa
 */
export async function runComparisonAnalytics(): Promise<ComparisonResult[]> {
  const scrapedPath = path.join(__dirname, '../../../reports/scraped-requests-analytics.json');
  if (!fs.existsSync(scrapedPath)) {
    throw new Error('scraped-requests-analytics.json not found — run `npm run scrape:analytics` first');
  }
  const scraped: Array<{ doc: DocRequest; tryOut: TryOutData }> = JSON.parse(fs.readFileSync(scrapedPath, 'utf-8'));

  const tryOutResultsPath = path.join(__dirname, '../../../reports/tryout-results-analytics.json');
  const tryOutResults: TryOutTestResult[] = fs.existsSync(tryOutResultsPath)
    ? JSON.parse(fs.readFileSync(tryOutResultsPath, 'utf-8'))
    : [];

  const newmanResultsPath = path.join(__dirname, '../../../reports/newman-results-analytics.json');
  const newmanResults: NewmanResult[] = fs.existsSync(newmanResultsPath)
    ? JSON.parse(fs.readFileSync(newmanResultsPath, 'utf-8'))
    : [];

  let postmanRequests: PostmanRequest[] = [];
  const cachedPostman = path.join(__dirname, '../../../reports/postman-collection-analytics.json');
  try {
    postmanRequests = await fetchPostmanCollection(POSTMAN_ANALYTICS_COLLECTION_ID, 'postman-collection-analytics.json');
  } catch {
    if (fs.existsSync(cachedPostman)) {
      console.warn('⚠️  Using cached Analytics Postman collection (live fetch failed)');
      postmanRequests = JSON.parse(fs.readFileSync(cachedPostman, 'utf-8'));
    } else {
      throw new Error('Postman collection unavailable — check POSTMAN_API_KEY and POSTMAN_ANALYTICS_COLLECTION_ID');
    }
  }

  const results: ComparisonResult[] = [];
  const matchedPostmanNames = new Set<string>();

  for (const { doc } of scraped) {
    const mismatches: Mismatch[] = [];

    const postmanReq   = findByName(doc.name, postmanRequests, r => r.name);
    if (postmanReq) matchedPostmanNames.add(postmanReq.name);
    const newmanResult = findByName(doc.name, newmanResults, r => r.requestName);
    const tryOutResult = findByName(doc.name, tryOutResults, r => r.requestName);

    // ── 1. Param/header field gaps: Doc ↔ Postman ─────────────────────────
    if (postmanReq) {
      const postmanActiveParamNames = new Set(postmanReq.params.filter(p => !p.disabled).map(p => norm(p.key)));
      const postmanAllParamNames    = new Set(postmanReq.params.map(p => norm(p.key)));
      const docParamNames           = new Set(doc.params.map(p => norm(p.name)));

      // Path variables (e.g. {{jobId}}) live in the URL, not as query params
      const pathVarNames = new Set(
        Array.from((postmanReq.url ?? '').matchAll(/\{\{(\w+)\}\}/g)).map(m => norm(m[1]))
      );

      // Note (not a collection defect): from/to ship as example literal dates
      // (2024-01-31 / 2024-03-31), same as any other placeholder value in the
      // collection — a real user supplies their own dates. Those exact example
      // dates do now 400 ("An internal server error occurred", data window
      // aged past them) if run as-is, so this test run rewrites them to a live
      // rolling window. Informational only — does not affect pass/fail status.
      for (const p of postmanReq.params) {
        if ((norm(p.key) === 'from' || norm(p.key) === 'to') && /^\d{4}-\d{2}-\d{2}$/.test(p.value ?? '')) {
          mismatches.push({
            type: 'known_collection_issue', field: p.key,
            source: 'Postman collection',
            detail: `Postman collection's example "${p.key}"="${p.value}" is a placeholder date, not a real value — this test run substitutes a live rolling window before executing (the example itself would now 400 if run unmodified, since the data window has aged past it).`,
            severity: 'info',
          });
        }
      }

      for (const p of postmanReq.params.filter(p => !p.disabled)) {
        if (!docParamNames.has(norm(p.key)) && norm(p.key) !== 'orguid') {
          mismatches.push({
            type: 'missing_in_doc', field: p.key,
            source: 'Postman → Doc',
            detail: `Postman has param "${p.key}" — NOT found in the doc description`,
            severity: 'error',
          });
        }
      }
      for (const p of doc.params) {
        if (!postmanAllParamNames.has(norm(p.name)) && !pathVarNames.has(norm(p.name))) {
          mismatches.push({
            type: 'missing_in_postman', field: p.name,
            source: 'Doc → Postman',
            detail: `Doc has param "${p.name}" but the Postman collection does not have it (even as disabled)`,
            severity: 'warning',
          });
        }
      }

      const GLOBAL_HEADERS = new Set(['authtoken', 'contenttype']);
      const docHeaderNames     = new Set(doc.headers.map(h => norm(h.name)));
      const postmanHeaderNames = new Set(postmanReq.headers.map(h => norm(h.key)));
      for (const h of postmanReq.headers) {
        if (GLOBAL_HEADERS.has(norm(h.key))) continue;
        if (!docHeaderNames.has(norm(h.key))) {
          mismatches.push({
            type: 'missing_in_doc', field: h.key,
            source: 'Postman → Doc (header)',
            detail: `Postman has header "${h.key}" not documented`,
            severity: 'warning',
          });
        }
      }
      for (const h of doc.headers) {
        if (GLOBAL_HEADERS.has(norm(h.name))) continue;
        if (!postmanHeaderNames.has(norm(h.name))) {
          mismatches.push({
            type: 'missing_in_postman', field: h.name,
            source: 'Doc → Postman (header)',
            detail: `Doc lists header "${h.name}" not in Postman collection`,
            severity: 'warning',
          });
        }
      }
    } else {
      mismatches.push({
        type: 'missing_in_postman',
        source: 'Doc → Postman',
        detail: `No matching request found in the Analytics Postman collection for "${doc.name}"`,
        severity: 'warning',
      });
    }

    // ── 2. Response body field gaps: Newman ↔ doc's declared Sample Response ─
    const newmanHadUnresolved = newmanResult?.error?.includes('Unresolved variable');
    if (newmanResult && tryOutResult && !newmanHadUnresolved) {
      const newmanKeys = newmanResult.responseBodyKeys;
      const docKeys     = tryOutResult.responseBodyKeys;

      if (newmanKeys && docKeys) {
        const nmSet = new Set(newmanKeys.map(norm));
        const dcSet = new Set(docKeys.map(norm));

        for (const key of newmanKeys) {
          if (!dcSet.has(norm(key))) {
            mismatches.push({
              type: 'response_body_mismatch', field: key,
              source: 'Newman response → Doc Sample Response',
              detail: `Postman (Newman) response has field "${key}" that is missing from the doc's declared Sample Response`,
              severity: 'warning',
            });
          }
        }
        for (const key of docKeys) {
          if (!nmSet.has(norm(key))) {
            mismatches.push({
              type: 'response_body_mismatch', field: key,
              source: 'Doc Sample Response → Newman response',
              detail: `Doc's Sample Response has field "${key}" that is missing from the actual Postman (Newman) response`,
              severity: 'warning',
            });
          }
        }
      }

      if (!newmanResult.passed) {
        const isNoTestData = newmanResult.error?.includes('Unresolved variable');
        mismatches.push({
          type: 'newman_failure',
          source: 'Postman (Newman)',
          detail: isNoTestData
            ? `Postman request returned ${newmanResult.responseCode} — URL has unresolved {{jobId}} (no live job available)`
            : `Postman request returned ${newmanResult.responseCode}${newmanResult.error ? ` — ${newmanResult.error}` : ''} when executed via Newman`,
          severity: isNoTestData ? 'warning' : 'error',
        });
      }
    } else if (!newmanResult) {
      mismatches.push({
        type: 'newman_failure',
        source: 'Newman',
        detail: `No Newman result found for "${doc.name}" — request may not be in the Postman collection`,
        severity: 'warning',
      });
    } else if (newmanResult && !newmanResult.passed) {
      const isNoTestData = newmanResult.error?.includes('Unresolved variable');
      mismatches.push({
        type: 'newman_failure',
        source: 'Postman (Newman)',
        detail: isNoTestData
          ? `Postman request returned ${newmanResult.responseCode} — URL has unresolved {{jobId}} (no live job available)`
          : `Postman request returned ${newmanResult.responseCode}${newmanResult.error ? ` — ${newmanResult.error}` : ''} when executed via Newman`,
        severity: isNoTestData ? 'warning' : 'error',
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

  // ── Coverage: Postman requests missing from the docs ───────────────────
  for (const pm of postmanRequests) {
    if (matchedPostmanNames.has(pm.name)) continue;
    const docMatch = findByName(pm.name, scraped, s => s.doc.name);
    if (docMatch) continue;
    results.push({
      requestName: pm.name,
      endpoint:    pm.url ?? '',
      method:      pm.method ?? '',
      docUrl:      '',
      mismatches: [{
        type: 'missing_in_doc',
        source: 'Postman → Doc',
        detail: `Postman collection has request "${pm.name}" (${pm.method ?? ''}) with no matching request in the docs`,
        severity: 'warning',
      }],
      status: 'warning',
    });
  }

  const outPath = path.join(__dirname, '../../../reports/comparison-results-analytics.json');
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));

  const pass = results.filter(r => r.status === 'pass').length;
  const warn = results.filter(r => r.status === 'warning').length;
  const fail = results.filter(r => r.status === 'fail').length;
  console.log(`\n📊  Comparison done (Analytics) — ✅ ${pass} pass  ⚠️ ${warn} warning  ❌ ${fail} fail`);
  console.log(`📝  Results → ${outPath}`);

  return results;
}

function norm(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function sortedWords(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9 ]/g, '').split(/\s+/).sort().join('');
}

function findByName<T>(docName: string, list: T[], getName: (item: T) => string): T | undefined {
  const target = norm(docName);
  const targetSorted = sortedWords(docName);
  return list.find(item => norm(getName(item)) === target)
    ?? list.find(item => {
        const n = norm(getName(item));
        return n.includes(target) || target.includes(n);
      })
    ?? list.find(item => sortedWords(getName(item)) === targetSorted);
}

runComparisonAnalytics().catch(console.error);
