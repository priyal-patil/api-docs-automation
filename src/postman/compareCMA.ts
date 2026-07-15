import * as fs from 'fs';
import * as path from 'path';
import dotenv from 'dotenv';
import { fetchPostmanCollection } from './fetchCollection';
import { ComparisonResult, Mismatch, DocRequest, TryOutData, TryOutTestResult, NewmanResult, PostmanRequest } from '../../config/types';

dotenv.config();

/**
 * Three-way comparison for the Content Management API (CMA):
 *   A = Doc description (scraped params/headers)
 *   B = Try Out panel (fields + response body captured by Playwright)
 *   C = Postman collection definition + Newman execution results
 *
 * Checks:
 *  1. Param/header field gaps: Doc ↔ Try Out ↔ Postman
 *  2. Request body field gaps (non-GET): Postman body ↔ Try Out body
 *  3. Response body field gaps: Newman actual response ↔ Try Out actual response
 *  4. Newman execution failures (Postman request returned 4xx/5xx)
 *  5. Default error code shown in Try Out before Send is clicked
 */
// Universal auth/infra headers documented globally, not per endpoint (norm()-ed).
const GLOBAL_HEADERS = new Set([
  'apikey', 'authtoken', 'managementtoken',
  'contenttype', 'branch', 'authorization', 'xcsvariantuid',
]);

export async function runComparisonCMA(): Promise<ComparisonResult[]> {
  // ── Load scraped data ────────────────────────────────────────────────────
  const scrapedPath = path.join(__dirname, '../../reports/scraped-requests-cma.json');
  if (!fs.existsSync(scrapedPath)) {
    throw new Error('scraped-requests-cma.json not found — run `npm run scrape:cma` first');
  }
  const scraped: Array<{ doc: DocRequest; tryOut: TryOutData }> = JSON.parse(
    fs.readFileSync(scrapedPath, 'utf-8')
  );

  // ── Load Try Out execution results (response bodies captured by Playwright) ──
  const tryOutResultsPath = path.join(__dirname, '../../reports/tryout-results-cma.json');
  const tryOutResults: TryOutTestResult[] = fs.existsSync(tryOutResultsPath)
    ? JSON.parse(fs.readFileSync(tryOutResultsPath, 'utf-8'))
    : [];

  // ── Load Newman execution results ────────────────────────────────────────
  const newmanResultsPath = path.join(__dirname, '../../reports/newman-results-cma.json');
  const newmanResults: NewmanResult[] = fs.existsSync(newmanResultsPath)
    ? JSON.parse(fs.readFileSync(newmanResultsPath, 'utf-8'))
    : [];

  // ── Fetch Postman collection definitions ────────────────────────────────
  let postmanRequests: PostmanRequest[] = [];
  const cachedPostman = path.join(__dirname, '../../reports/postman-collection-cma.json');
  try {
    postmanRequests = await fetchPostmanCollection(
      '32962131-18e02df1-9ca6-4e37-a686-6763aaf81129',
      'postman-collection-cma.json'
    );
  } catch {
    if (fs.existsSync(cachedPostman)) {
      console.warn('⚠️  Using cached Postman CMA collection (live fetch failed)');
      postmanRequests = JSON.parse(fs.readFileSync(cachedPostman, 'utf-8'));
    } else {
      throw new Error('Postman CMA collection unavailable — check POSTMAN_API_KEY');
    }
  }

  const results: ComparisonResult[] = [];
  // Track which Postman requests were matched by a doc request, so we can
  // report collection requests that are missing from the docs afterwards.
  const matchedPostmanNames = new Set<string>();

  for (const { doc, tryOut } of scraped) {
    const mismatches: Mismatch[] = [];

    // Find matching records in each source by request name
    const postmanReq   = findByName(doc.name, postmanRequests, r => r.name);
    if (postmanReq) matchedPostmanNames.add(postmanReq.name);
    const newmanResult = findByName(doc.name, newmanResults, r => r.requestName);
    const tryOutResult = findByName(doc.name, tryOutResults, r => r.requestName);

    // ── 1. Param/header field gaps: Doc ↔ Try Out ↔ Postman ──────────────
    //
    // When doc.params is empty (scraper found no HTML table), fall back to
    // tryOut.params as the canonical param reference — the Try Out panel
    // is the doc's own interactive representation of accepted parameters.
    const effectiveDocParams = doc.params.length > 0 ? doc.params : tryOut.params.map(f => ({
      name: f.name, type: f.type, required: false, description: '',
    }));

    const docParamNames    = new Set(effectiveDocParams.map(p => normParam(p.name)));
    const tryOutParamNames = new Set(tryOut.params.map(p => normParam(p.name)));

    // Postman-derived name sets (empty when no matching Postman request) — computed
    // upfront so the Doc ↔ Try Out checks can also use them to suppress noise.
    // Path variables (e.g. {{entry_uid}}) live in the URL path, not query params.
    const postmanAllParamNames = new Set((postmanReq?.params ?? []).map(p => norm(p.key)));
    const postmanHeaderNames   = new Set((postmanReq?.headers ?? []).map(h => norm(h.key)));
    const pathVarNames = new Set(
      Array.from((postmanReq?.url ?? '').matchAll(/\{\{(\w+)\}\}/g)).map(m => norm(m[1]))
    );
    const docHeaderNames = new Set(doc.headers.map(h => norm(h.name)));

    // Only compare Doc ↔ Try Out when the scraper found actual doc tables
    if (doc.params.length > 0) {
      for (const p of doc.params) {
        // Body/form-data fields (asset[upload]) are entered in the body editor, not as param inputs
        if (isBodyField(p.name)) continue;
        if (GLOBAL_HEADERS.has(normParam(p.name))) continue;
        if (!tryOutParamNames.has(normParam(p.name))) {
          mismatches.push({
            type: 'missing_in_tryout', field: p.name,
            source: 'Doc → Try Out',
            detail: `Doc describes param "${p.name}" but it is NOT present in the Try Out panel`,
            severity: p.required ? 'error' : 'warning',
          });
        }
      }
      for (const f of tryOut.params) {
        // Skip global headers and URL path variables — the panel shows them as inputs
        // but the doc's param table legitimately documents them elsewhere
        if (GLOBAL_HEADERS.has(normParam(f.name))) continue;
        if (pathVarNames.has(normParam(f.name))) continue;
        if (!docParamNames.has(normParam(f.name))) {
          mismatches.push({
            type: 'extra_in_tryout', field: f.name,
            source: 'Try Out → Doc',
            detail: `Try Out panel has field "${f.name}" not mentioned in doc description`,
            severity: 'warning',
          });
        }
      }
    }

    if (postmanReq) {
      // Postman active params missing from doc/tryout (only flag actively-sent params).
      // Cross-check doc headers too — docs sometimes list the same name as a header.
      for (const p of postmanReq.params.filter(p => !p.disabled)) {
        if (!docParamNames.has(norm(p.key)) && !tryOutParamNames.has(norm(p.key))
            && !docHeaderNames.has(norm(p.key))) {
          mismatches.push({
            type: 'missing_in_doc', field: p.key,
            source: 'Postman → Doc/Try Out',
            detail: `Postman has param "${p.key}" — NOT found in doc or Try Out panel`,
            severity: 'error',
          });
        }
      }
      // Doc/tryout params missing from Postman entirely — skip path variables,
      // disabled-but-present params, global headers, body/form-data fields, and
      // names Postman carries as a *header* instead of a query param.
      for (const p of effectiveDocParams) {
        const n = normParam(p.name);
        if (isBodyField(p.name)) continue;
        if (GLOBAL_HEADERS.has(n)) continue;
        if (postmanAllParamNames.has(n) || pathVarNames.has(n) || postmanHeaderNames.has(n)) continue;
        mismatches.push({
          type: 'missing_in_postman', field: p.name,
          source: 'Doc/Try Out → Postman',
          detail: `Doc/Try Out has param "${p.name}" but Postman collection does not have it (even as disabled)`,
          severity: 'warning',
        });
      }

      // Headers — skip universal auth/infra headers documented globally, not per endpoint.
      // Cross-check the other source's params too: the same name documented as a param
      // (or sent by Postman as a query param) is a representation difference, not a gap.
      for (const h of postmanReq.headers) {
        const n = norm(h.key);
        if (GLOBAL_HEADERS.has(n)) continue;
        if (docHeaderNames.has(n) || docParamNames.has(n) || tryOutParamNames.has(n)) continue;
        mismatches.push({
          type: 'missing_in_doc', field: h.key,
          source: 'Postman → Doc (header)',
          detail: `Postman has header "${h.key}" not documented`,
          severity: 'warning',
        });
      }
      for (const h of doc.headers) {
        const n = norm(h.name);
        if (GLOBAL_HEADERS.has(n)) continue;
        if (postmanHeaderNames.has(n) || postmanAllParamNames.has(n) || pathVarNames.has(n)) continue;
        mismatches.push({
          type: 'missing_in_postman', field: h.name,
          source: 'Doc → Postman (header)',
          detail: `Doc lists header "${h.name}" not in Postman collection`,
          severity: 'warning',
        });
      }
    } else {
      mismatches.push({
        type: 'missing_in_postman',
        source: 'Doc → Postman',
        detail: `No matching request found in Postman collection for "${doc.name}"`,
        severity: 'warning',
      });
    }

    // ── 2. Request body field comparison (non-GET): Postman ↔ Try Out ────
    if (doc.method !== 'GET') {
      const postmanBodyKeys = extractKeys(postmanReq?.body?.raw);
      const tryOutBodyKeys  = extractKeys(tryOut.bodyContent);

      if (postmanBodyKeys && tryOutBodyKeys) {
        const pmSet = new Set(postmanBodyKeys.map(norm));
        const toSet = new Set(tryOutBodyKeys.map(norm));

        // Fields in Postman request body but missing from Try Out panel body
        for (const key of postmanBodyKeys) {
          if (!toSet.has(norm(key))) {
            mismatches.push({
              type: 'request_body_mismatch', field: key,
              source: 'Postman request body → Try Out request body',
              detail: `Postman request body has field "${key}" that is missing from the Try Out panel body`,
              severity: 'error',
            });
          }
        }
        // Fields in Try Out body but missing from Postman request body
        for (const key of tryOutBodyKeys) {
          if (!pmSet.has(norm(key))) {
            mismatches.push({
              type: 'request_body_mismatch', field: key,
              source: 'Try Out request body → Postman request body',
              detail: `Try Out panel body has field "${key}" that is missing from Postman request body`,
              severity: 'error',
            });
          }
        }
      } else if (postmanBodyKeys && !tryOutBodyKeys) {
        mismatches.push({
          type: 'request_body_mismatch',
          source: 'Postman → Try Out (request body)',
          detail: `Postman has a request body (${postmanBodyKeys.join(', ')}) but Try Out panel body is empty or unavailable`,
          severity: 'warning',
        });
      } else if (!postmanBodyKeys && tryOutBodyKeys) {
        mismatches.push({
          type: 'request_body_mismatch',
          source: 'Try Out → Postman (request body)',
          detail: `Try Out panel has a request body (${tryOutBodyKeys.join(', ')}) but Postman has none`,
          severity: 'warning',
        });
      }
    }

    // ── 3. Response body field comparison: Newman result ↔ Try Out result ─
    // Skip response comparison when Newman had an unresolved variable — the error body
    // (error_message, error_code, errors) is not meaningful to compare against Try Out.
    const newmanHadUnresolved = newmanResult?.error?.includes('Unresolved variable');
    if (newmanResult && tryOutResult && !newmanHadUnresolved) {
      const newmanKeys  = newmanResult.responseBodyKeys;
      const tryOutKeys  = tryOutResult.responseBodyKeys;

      if (newmanKeys && tryOutKeys) {
        const nmSet = new Set(newmanKeys.map(norm));
        const toSet = new Set(tryOutKeys.map(norm));

        // Fields in Newman response missing from Try Out response
        for (const key of newmanKeys) {
          if (!toSet.has(norm(key))) {
            mismatches.push({
              type: 'response_body_mismatch', field: key,
              source: 'Newman response → Try Out response',
              detail: `Postman (Newman) response has field "${key}" that is missing from the Try Out panel response`,
              severity: 'warning',
            });
          }
        }
        // Fields in Try Out response missing from Newman response
        for (const key of tryOutKeys) {
          if (!nmSet.has(norm(key))) {
            mismatches.push({
              type: 'response_body_mismatch', field: key,
              source: 'Try Out response → Newman response',
              detail: `Try Out panel response has field "${key}" that is missing from the Postman (Newman) response`,
              severity: 'warning',
            });
          }
        }
      }

      // Newman execution failure
      if (!newmanResult.passed) {
        const isNoTestData = newmanResult.error?.includes('Unresolved variable');
        mismatches.push({
          type: 'newman_failure',
          source: 'Postman (Newman)',
          detail: isNoTestData
            ? `Postman request returned ${newmanResult.responseCode} — URL has unresolved {{variable}} (no test data for this UID)`
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
    }

    // Newman failure check when there is no tryOutResult (handles cases not caught above)
    if (newmanResult && !tryOutResult && !newmanResult.passed) {
      const isNoTestData = newmanResult.error?.includes('Unresolved variable');
      mismatches.push({
        type: 'newman_failure',
        source: 'Postman (Newman)',
        detail: isNoTestData
          ? `Postman request returned ${newmanResult.responseCode} — URL has unresolved {{variable}} (no test data for this UID)`
          : `Postman request returned ${newmanResult.responseCode}${newmanResult.error ? ` — ${newmanResult.error}` : ''} when executed via Newman`,
        severity: isNoTestData ? 'warning' : 'error',
      });
    }

    // ── 4. Default error code shown in Try Out before Send is clicked ─────
    if (tryOut.defaultResponseCode && tryOut.defaultResponseCode >= 400) {
      mismatches.push({
        type: 'default_error_response',
        source: 'Try Out panel',
        detail: `Try Out panel shows ${tryOut.defaultResponseCode} as default before Send is clicked`,
        severity: 'error',
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

  // ── 5. Reverse direction: Postman requests missing from the docs ──────────
  // Doc modules with no scrapeable anchors (e.g. Metadata) would flood this
  // check with noise, so double-check the reverse fuzzy match before flagging.
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

  const outPath = path.join(__dirname, '../../reports/comparison-results-cma.json');
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));

  const pass = results.filter(r => r.status === 'pass').length;
  const warn = results.filter(r => r.status === 'warning').length;
  const fail = results.filter(r => r.status === 'fail').length;
  console.log(`\n📊  CMA Comparison done — ✅ ${pass} pass  ⚠️ ${warn} warning  ❌ ${fail} fail`);
  console.log(`📝  Results → ${outPath}`);

  return results;
}

function norm(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Doc param tables append qualifiers like "asset[upload] (mandatory)" — strip them
// so the name can match Postman/Try Out fields.
function stripQualifier(name: string): string {
  return name.replace(/\s*\((mandatory|optional|required)\)\s*$/i, '').trim();
}

function normParam(name: string): string {
  return norm(stripQualifier(name));
}

// "asset[upload]"-style names are multipart form-data BODY fields documented in the
// params table — they are not query params and never appear as Try Out inputs or
// Postman query entries, so param-level comparisons must skip them.
function isBodyField(name: string): boolean {
  return /\[.+\]/.test(stripQualifier(name));
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
  // 1. Exact normalised match
  return list.find(item => norm(getName(item)) === target)
    // 2. Substring containment
    ?? list.find(item => {
        const n = norm(getName(item));
        return n.includes(target) || target.includes(n);
      })
    // 3. Same words in any order (catches "Equals Within Group Operator" vs "Equals Operator Within Group")
    ?? list.find(item => sortedWords(getName(item)) === targetSorted);
}

function extractKeys(raw: string | undefined | null): string[] | undefined {
  if (!raw?.trim()) return undefined;
  try {
    const parsed = JSON.parse(raw.trim());
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return Object.keys(parsed);
    }
  } catch { /* not JSON */ }
  return undefined;
}

runComparisonCMA().catch(console.error);
