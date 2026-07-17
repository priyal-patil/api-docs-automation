import * as fs from 'fs';
import * as path from 'path';
import dotenv from 'dotenv';
import { fetchPostmanCollection } from '../../shared/postman/fetchCollection';
import { ComparisonResult, Mismatch, DocRequest, TryOutData, TryOutTestResult, NewmanResult, PostmanRequest } from '../../../config/types';

dotenv.config();

const POSTMAN_GENAI_COLLECTION_ID = process.env.POSTMAN_GENAI_COLLECTION_ID ?? '';

/**
 * Three-way comparison for Generative AI API (no live Try Out execution
 * exists, same as Analytics/Automations/Brand Kit). Only one endpoint exists
 * (GenAI), and its response is a streaming SSE body, not JSON — response-body
 * comparison is skipped gracefully wherever response keys are unavailable
 * (the same fallback already used when any field can't be parsed).
 *
 * Checks:
 *  1. Param/header field gaps: Doc ↔ Postman
 *  2. Request body field gaps: Postman body ↔ doc's declared Sample Request
 *  3. Newman execution failures (Postman request returned 4xx/5xx)
 *  4. Coverage: endpoints in docs but missing from Postman, and vice versa
 */
export async function runComparisonGenAI(): Promise<ComparisonResult[]> {
  const scrapedPath = path.join(__dirname, '../../../reports/scraped-requests-genai.json');
  if (!fs.existsSync(scrapedPath)) {
    throw new Error('scraped-requests-genai.json not found — run `npm run scrape:genai` first');
  }
  const scraped: Array<{ doc: DocRequest; tryOut: TryOutData }> = JSON.parse(fs.readFileSync(scrapedPath, 'utf-8'));

  const tryOutResultsPath = path.join(__dirname, '../../../reports/tryout-results-genai.json');
  const tryOutResults: TryOutTestResult[] = fs.existsSync(tryOutResultsPath)
    ? JSON.parse(fs.readFileSync(tryOutResultsPath, 'utf-8'))
    : [];

  const newmanResultsPath = path.join(__dirname, '../../../reports/newman-results-genai.json');
  const newmanResults: NewmanResult[] = fs.existsSync(newmanResultsPath)
    ? JSON.parse(fs.readFileSync(newmanResultsPath, 'utf-8'))
    : [];

  let postmanRequests: PostmanRequest[] = [];
  const cachedPostman = path.join(__dirname, '../../../reports/postman-collection-genai.json');
  try {
    postmanRequests = await fetchPostmanCollection(POSTMAN_GENAI_COLLECTION_ID, 'postman-collection-genai.json');
  } catch {
    if (fs.existsSync(cachedPostman)) {
      console.warn('⚠️  Using cached Generative AI Postman collection (live fetch failed)');
      postmanRequests = JSON.parse(fs.readFileSync(cachedPostman, 'utf-8'));
    } else {
      throw new Error('Postman collection unavailable — check POSTMAN_API_KEY and POSTMAN_GENAI_COLLECTION_ID');
    }
  }

  const results: ComparisonResult[] = [];
  const matchedPostmanNames = new Set<string>();

  for (const { doc, tryOut } of scraped) {
    const mismatches: Mismatch[] = [];

    const postmanReq   = findByName(doc.name, postmanRequests, r => r.name);
    if (postmanReq) matchedPostmanNames.add(postmanReq.name);
    const newmanResult = findByName(doc.name, newmanResults, r => r.requestName);
    const tryOutResult = findByName(doc.name, tryOutResults, r => r.requestName);

    // ── 1. Param/header field gaps: Doc ↔ Postman ─────────────────────────
    if (postmanReq) {
      const postmanAllParamNames = new Set(postmanReq.params.map(p => norm(p.key)));
      const docParamNames        = new Set(doc.params.map(p => norm(p.name)));

      const pathVarNames = new Set(
        Array.from((postmanReq.url ?? '').matchAll(/\{\{(\w+)\}\}/g)).map(m => norm(m[1]))
      );

      for (const p of postmanReq.params.filter(p => !p.disabled)) {
        if (!docParamNames.has(norm(p.key))) {
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

      // Global auth headers documented once, not per-endpoint — skip them here.
      const GLOBAL_HEADERS = new Set(['authtoken', 'organizationuid', 'contenttype', 'authorization', 'brandkituid']);
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
        detail: `No matching request found in the Generative AI Postman collection for "${doc.name}"`,
        severity: 'warning',
      });
    }

    // ── 2. Request body field comparison (POST): Postman ↔ doc's Sample Request ─
    if (doc.method === 'POST' || doc.method === 'PUT') {
      const postmanBodyKeys = extractKeys(postmanReq?.body?.raw);
      const docBodyKeys     = extractKeys(tryOut.bodyContent);

      if (postmanBodyKeys && docBodyKeys) {
        const pmSet = new Set(postmanBodyKeys.map(norm));
        const dcSet = new Set(docBodyKeys.map(norm));
        for (const key of postmanBodyKeys) {
          if (!dcSet.has(norm(key))) {
            mismatches.push({
              type: 'request_body_mismatch', field: key,
              source: 'Postman request body → Doc Sample Request',
              detail: `Postman request body has field "${key}" that is missing from the doc's declared Sample Request`,
              severity: 'error',
            });
          }
        }
        for (const key of docBodyKeys) {
          if (!pmSet.has(norm(key))) {
            mismatches.push({
              type: 'request_body_mismatch', field: key,
              source: 'Doc Sample Request → Postman request body',
              detail: `Doc's Sample Request has field "${key}" that is missing from the Postman request body`,
              severity: 'error',
            });
          }
        }
      } else if (postmanBodyKeys && !docBodyKeys) {
        mismatches.push({
          type: 'request_body_mismatch',
          source: 'Postman → Doc (request body)',
          detail: `Postman has a request body (${postmanBodyKeys.join(', ')}) but the doc's Sample Request is empty or unavailable`,
          severity: 'warning',
        });
      } else if (!postmanBodyKeys && docBodyKeys) {
        mismatches.push({
          type: 'request_body_mismatch',
          source: 'Doc → Postman (request body)',
          detail: `Doc has a Sample Request (${docBodyKeys.join(', ')}) but Postman has no request body`,
          severity: 'warning',
        });
      }
    }

    // ── 3. Response body field gaps: Newman ↔ doc's declared Sample Response ─
    // Skipped gracefully for GenAI — its response is a streaming SSE body,
    // not JSON, so neither side will have parseable keys most of the time.
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
            ? `Postman request returned ${newmanResult.responseCode} — URL has an unresolved {{variable}} (no test data available)`
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
          ? `Postman request returned ${newmanResult.responseCode} — URL has an unresolved {{variable}} (no test data available)`
          : `Postman request returned ${newmanResult.responseCode}${newmanResult.error ? ` — ${newmanResult.error}` : ''} when executed via Newman`,
        severity: isNoTestData ? 'warning' : 'error',
      });
    }

    // ── 4. Known doc bug (confirmed live, not auto-detectable from Postman) ─
    // brand_kit_uid is documented as optional but the API 400s "is required"
    // without it. Postman collections don't carry a required/optional flag
    // on headers, so this can't be caught by the diff above — flagged directly.
    const brandKitHeader = doc.headers.find(h => norm(h.name) === 'brandkituid');
    if (brandKitHeader && !brandKitHeader.required) {
      mismatches.push({
        type: 'required_mismatch', field: 'brand_kit_uid',
        source: 'Doc vs live API behavior',
        detail: `Doc marks "brand_kit_uid" as optional, but the live API returns 400 "brand_kit_uid is required" without it — confirmed by direct testing.`,
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

  const outPath = path.join(__dirname, '../../../reports/comparison-results-genai.json');
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));

  const pass = results.filter(r => r.status === 'pass').length;
  const warn = results.filter(r => r.status === 'warning').length;
  const fail = results.filter(r => r.status === 'fail').length;
  console.log(`\n📊  Comparison done (Generative AI) — ✅ ${pass} pass  ⚠️ ${warn} warning  ❌ ${fail} fail`);
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

function extractKeys(raw: string | undefined | null): string[] | undefined {
  if (!raw?.trim()) return undefined;
  try {
    const parsed = JSON.parse(raw.trim());
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return Object.keys(parsed);
  } catch { /* not JSON */ }
  return undefined;
}

runComparisonGenAI().catch(console.error);
