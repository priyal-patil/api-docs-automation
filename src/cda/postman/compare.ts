import * as fs from 'fs';
import * as path from 'path';
import dotenv from 'dotenv';
import { fetchPostmanCollection } from '../../shared/postman/fetchCollection';
import { ComparisonResult, Mismatch, DocRequest, TryOutData, TryOutTestResult, NewmanResult, PostmanRequest } from '../../../config/types';

dotenv.config();

/**
 * Three-way comparison:
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
export async function runComparison(): Promise<ComparisonResult[]> {
  // ── Load scraped data ────────────────────────────────────────────────────
  const scrapedPath = path.join(__dirname, '../../../reports/scraped-requests.json');
  if (!fs.existsSync(scrapedPath)) {
    throw new Error('scraped-requests.json not found — run `npm run scrape` first');
  }
  const scraped: Array<{ doc: DocRequest; tryOut: TryOutData }> = JSON.parse(
    fs.readFileSync(scrapedPath, 'utf-8')
  );

  // ── Load Try Out execution results (response bodies captured by Playwright) ──
  const tryOutResultsPath = path.join(__dirname, '../../../reports/tryout-results.json');
  const tryOutResults: TryOutTestResult[] = fs.existsSync(tryOutResultsPath)
    ? JSON.parse(fs.readFileSync(tryOutResultsPath, 'utf-8'))
    : [];

  // ── Load Newman execution results ────────────────────────────────────────
  const newmanResultsPath = path.join(__dirname, '../../../reports/newman-results.json');
  const newmanResults: NewmanResult[] = fs.existsSync(newmanResultsPath)
    ? JSON.parse(fs.readFileSync(newmanResultsPath, 'utf-8'))
    : [];

  // ── Fetch Postman collection definitions ────────────────────────────────
  let postmanRequests: PostmanRequest[] = [];
  const cachedPostman = path.join(__dirname, '../../../reports/postman-collection.json');
  try {
    postmanRequests = await fetchPostmanCollection();
  } catch {
    if (fs.existsSync(cachedPostman)) {
      console.warn('⚠️  Using cached Postman collection (live fetch failed)');
      postmanRequests = JSON.parse(fs.readFileSync(cachedPostman, 'utf-8'));
    } else {
      throw new Error('Postman collection unavailable — check POSTMAN_API_KEY and POSTMAN_CDA_COLLECTION_ID');
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

    const docParamNames     = new Set(effectiveDocParams.map(p => norm(p.name)));
    const tryOutParamNames  = new Set(tryOut.params.map(p => norm(p.name)));
    const docHeaderNames    = new Set(doc.headers.map(h => norm(h.name)));
    const tryOutHeaderNames = new Set(tryOut.headers.map(h => norm(h.name)));

    // Only compare Doc ↔ Try Out when the scraper found actual doc tables
    if (doc.params.length > 0) {
      for (const p of doc.params) {
        if (!tryOutParamNames.has(norm(p.name)) && !tryOutHeaderNames.has(norm(p.name))) {
          mismatches.push({
            type: 'missing_in_tryout', field: p.name,
            source: 'Doc → Try Out',
            detail: `Doc describes param "${p.name}" but it is NOT present in the Try Out panel`,
            severity: p.required ? 'error' : 'warning',
          });
        }
      }
      for (const f of tryOut.params) {
        if (!docParamNames.has(norm(f.name)) && !docHeaderNames.has(norm(f.name))) {
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
      // Active params (enabled) — used to detect params Postman actively sends but aren't in docs
      const postmanActiveParamNames = new Set(
        postmanReq.params.filter(p => !p.disabled).map(p => norm(p.key))
      );
      // All params (enabled + disabled) — used to detect params docs describe but aren't in Postman at all.
      // A disabled param means "supported but not sent by default", NOT "unsupported".
      const postmanAllParamNames = new Set(
        postmanReq.params.map(p => norm(p.key))
      );

      // Extract path variable names from Postman URL (e.g. {{entry_uid}} → entry_uid).
      // These are NOT query params — they live in the URL path — so we must not flag
      // them as "missing in Postman" when the doc/Try Out panel lists them as inputs.
      const pathVarNames = new Set(
        Array.from((postmanReq.url ?? '').matchAll(/\{\{(\w+)\}\}/g)).map(m => norm(m[1]))
      );

      // Postman active params missing from doc/tryout (only flag actively-sent params).
      // Cross-check headers too — a param in Postman can be documented as a header
      // in the doc/Try Out panel (e.g. organization_uid) without being a real gap.
      for (const p of postmanReq.params.filter(p => !p.disabled)) {
        const n = norm(p.key);
        if (!docParamNames.has(n) && !tryOutParamNames.has(n)
            && !docHeaderNames.has(n) && !tryOutHeaderNames.has(n)) {
          mismatches.push({
            type: 'missing_in_doc', field: p.key,
            source: 'Postman → Doc/Try Out',
            detail: `Postman has param "${p.key}" — NOT found in doc or Try Out panel`,
            severity: 'error',
          });
        }
      }
      // Doc/tryout params missing from Postman entirely — skip path variables and disabled-but-present params
      for (const p of effectiveDocParams) {
        if (!postmanAllParamNames.has(norm(p.name)) && !pathVarNames.has(norm(p.name))) {
          mismatches.push({
            type: 'missing_in_postman', field: p.name,
            source: 'Doc/Try Out → Postman',
            detail: `Doc/Try Out has param "${p.name}" but Postman collection does not have it (even as disabled)`,
            severity: 'warning',
          });
        }
      }

      // Headers — skip universal auth/infra headers documented globally, not per endpoint.
      // Stored as norm()-ed values (lowercase, alphanumeric only).
      const GLOBAL_HEADERS = new Set([
        'apikey', 'accesstoken', 'deliverytoken', 'authtoken', 'managementtoken',
        'contenttype', 'branch', 'authorization', 'xcsvariantuid',
      ]);
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
        const apiError = extractApiError(newmanResult.responseBodyRaw);
        mismatches.push({
          type: 'newman_failure',
          source: 'Postman (Newman)',
          detail: isNoTestData
            ? `Postman request returned ${newmanResult.responseCode} — URL has unresolved {{variable}} (no test data for this UID)`
            : `Postman request returned ${newmanResult.responseCode}${apiError ? ` — ${apiError}` : newmanResult.error ? ` — ${newmanResult.error}` : ''} when executed via Newman`,
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
      const apiError = extractApiError(newmanResult.responseBodyRaw);
      mismatches.push({
        type: 'newman_failure',
        source: 'Postman (Newman)',
        detail: isNoTestData
          ? `Postman request returned ${newmanResult.responseCode} — URL has unresolved {{variable}} (no test data for this UID)`
          : `Postman request returned ${newmanResult.responseCode}${apiError ? ` — ${apiError}` : newmanResult.error ? ` — ${newmanResult.error}` : ''} when executed via Newman`,
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

  // ── Reverse direction: Postman requests missing from the docs ─────────────
  // Double-check with the reverse fuzzy match before flagging to avoid noise
  // from name-ordering differences.
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

  const outPath = path.join(__dirname, '../../../reports/comparison-results.json');
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

// Pull the actual API error message/code out of a Newman response body so the
// report is self-explanatory instead of just "returned 422".
function extractApiError(raw: string | undefined): string | undefined {
  if (!raw?.trim()) return undefined;
  try {
    const parsed = JSON.parse(raw.trim());
    const parts: string[] = [];
    if (parsed.error_message) parts.push(parsed.error_message);
    if (parsed.errors && typeof parsed.errors === 'object') {
      for (const [field, msgs] of Object.entries(parsed.errors)) {
        const msgText = Array.isArray(msgs) ? msgs.join(', ') : String(msgs);
        parts.push(`${field}: ${msgText}`);
      }
    }
    return parts.length ? parts.join(' — ') : undefined;
  } catch { return undefined; }
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

runComparison().catch(console.error);
