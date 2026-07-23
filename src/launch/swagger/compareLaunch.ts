import * as fs from 'fs';
import * as path from 'path';
import dotenv from 'dotenv';
import { ComparisonResult, Mismatch, DocRequest, TryOutData, TryOutTestResult, NewmanResult, PostmanRequest } from '../../../config/types';
import { fetchLaunchOpenApiSpec, parseSwaggerRequests } from './openApiSpec';

dotenv.config();

const REGION_HOSTS: Record<string, string> = {
  us: 'launch-api.contentstack.com', eu: 'eu-launch-api.contentstack.com', au: 'au-launch-api.contentstack.com',
  'azure-na': 'azure-na-launch-api.contentstack.com', 'azure-eu': 'azure-eu-launch-api.contentstack.com',
  'gcp-na': 'gcp-na-launch-api.contentstack.com', 'gcp-eu': 'gcp-eu-launch-api.contentstack.com',
};
const BASE_HOST = REGION_HOSTS[process.env.CS_REGION ?? 'us'] ?? 'launch-api.contentstack.com';

/**
 * Three-way comparison for the Launch API — same shape as
 * compareLytics.ts/comparePersonalize.ts, with the OpenAPI spec (fetched
 * live from /openapi) standing in for a Postman collection.
 */
export async function runComparisonLaunch(): Promise<ComparisonResult[]> {
  const scrapedPath = path.join(__dirname, '../../../reports/scraped-requests-launch.json');
  if (!fs.existsSync(scrapedPath)) {
    throw new Error('scraped-requests-launch.json not found — run `npm run scrape:launch` first');
  }
  const scraped: Array<{ doc: DocRequest; tryOut: TryOutData }> = JSON.parse(fs.readFileSync(scrapedPath, 'utf-8'));

  const tryOutResultsPath = path.join(__dirname, '../../../reports/tryout-results-launch.json');
  const tryOutResults: TryOutTestResult[] = fs.existsSync(tryOutResultsPath)
    ? JSON.parse(fs.readFileSync(tryOutResultsPath, 'utf-8'))
    : [];

  const newmanResultsPath = path.join(__dirname, '../../../reports/newman-results-launch.json');
  const newmanResults: NewmanResult[] = fs.existsSync(newmanResultsPath)
    ? JSON.parse(fs.readFileSync(newmanResultsPath, 'utf-8'))
    : [];

  const spec = await fetchLaunchOpenApiSpec(BASE_HOST);
  const swaggerRequests: PostmanRequest[] = parseSwaggerRequests(spec);

  const results: ComparisonResult[] = [];
  const matchedSwaggerNames = new Set<string>();

  for (const { doc, tryOut } of scraped) {
    const mismatches: Mismatch[] = [];

    const swaggerReq    = findByName(doc.name, swaggerRequests, r => r.name);
    if (swaggerReq) matchedSwaggerNames.add(swaggerReq.name);
    const newmanResult  = findByName(doc.name, newmanResults, r => r.requestName);
    const tryOutResult  = findByName(doc.name, tryOutResults, r => r.requestName);

    // ── 1. Param/header field gaps: Doc ↔ OpenAPI spec ─────────────────────
    if (swaggerReq) {
      const swaggerParamNames = new Set(swaggerReq.params.map(p => norm(p.key)));
      const docParamNames     = new Set(doc.params.map(p => norm(p.name)));

      const pathVarNames = new Set(
        Array.from((swaggerReq.url ?? '').matchAll(/\{(\w+)\}/g)).map(m => norm(m[1]))
      );

      for (const p of swaggerReq.params) {
        if (!docParamNames.has(norm(p.key))) {
          mismatches.push({
            type: 'missing_in_doc', field: p.key,
            source: 'OpenAPI spec → Doc',
            detail: `OpenAPI spec has param "${p.key}" — NOT found in the doc description`,
            severity: 'error',
          });
        }
      }
      for (const p of doc.params) {
        if (!swaggerParamNames.has(norm(p.name)) && !pathVarNames.has(norm(p.name))) {
          mismatches.push({
            type: 'missing_in_postman', field: p.name,
            source: 'Doc → OpenAPI spec',
            detail: `Doc has param "${p.name}" but the OpenAPI spec does not declare it`,
            severity: 'warning',
          });
        }
      }

      const GLOBAL_HEADERS = new Set(['authtoken', 'authorization', 'organizationuid', 'contenttype', 'xcsapiversion']);
      const docHeaderNames     = new Set(doc.headers.map(h => norm(h.name)));
      const swaggerHeaderNames = new Set(swaggerReq.headers.map(h => norm(h.key)));
      for (const h of swaggerReq.headers) {
        if (GLOBAL_HEADERS.has(norm(h.key))) continue;
        if (!docHeaderNames.has(norm(h.key))) {
          mismatches.push({
            type: 'missing_in_doc', field: h.key,
            source: 'OpenAPI spec → Doc (header)',
            detail: `OpenAPI spec has header "${h.key}" not documented`,
            severity: 'warning',
          });
        }
      }
      for (const h of doc.headers) {
        if (GLOBAL_HEADERS.has(norm(h.name))) continue;
        if (!swaggerHeaderNames.has(norm(h.name))) {
          mismatches.push({
            type: 'missing_in_postman', field: h.name,
            source: 'Doc → OpenAPI spec (header)',
            detail: `Doc lists header "${h.name}" not in the OpenAPI spec`,
            severity: 'warning',
          });
        }
      }
    } else {
      mismatches.push({
        type: 'missing_in_postman',
        source: 'Doc → OpenAPI spec',
        detail: `No matching operation found in the Launch OpenAPI spec for "${doc.name}"`,
        severity: 'warning',
      });
    }

    // ── 2. Request body field comparison (POST/PUT): OpenAPI schema ↔ doc's Sample Request ─
    if (doc.method === 'POST' || doc.method === 'PUT') {
      const swaggerBodyKeys = extractKeys(swaggerReq?.body?.raw);
      const docBodyKeys     = extractKeys(tryOut.bodyContent);

      if (swaggerBodyKeys && docBodyKeys) {
        const swSet = new Set(swaggerBodyKeys.map(norm));
        const dcSet = new Set(docBodyKeys.map(norm));
        for (const key of swaggerBodyKeys) {
          if (!dcSet.has(norm(key))) {
            mismatches.push({
              type: 'request_body_mismatch', field: key,
              source: 'OpenAPI schema → Doc Sample Request',
              detail: `OpenAPI request schema has field "${key}" that is missing from the doc's declared Sample Request`,
              severity: 'error',
            });
          }
        }
        for (const key of docBodyKeys) {
          if (!swSet.has(norm(key))) {
            mismatches.push({
              type: 'request_body_mismatch', field: key,
              source: 'Doc Sample Request → OpenAPI schema',
              detail: `Doc's Sample Request has field "${key}" that is missing from the OpenAPI request schema`,
              severity: 'error',
            });
          }
        }
      } else if (swaggerBodyKeys && !docBodyKeys) {
        mismatches.push({
          type: 'request_body_mismatch',
          source: 'OpenAPI schema → Doc (request body)',
          detail: `OpenAPI spec has a request body (${swaggerBodyKeys.join(', ')}) but the doc's Sample Request is empty or unavailable`,
          severity: 'warning',
        });
      } else if (!swaggerBodyKeys && docBodyKeys) {
        mismatches.push({
          type: 'request_body_mismatch',
          source: 'Doc → OpenAPI schema (request body)',
          detail: `Doc has a Sample Request (${docBodyKeys.join(', ')}) but the OpenAPI spec declares no request body`,
          severity: 'warning',
        });
      }
    }

    // ── 3. Response body field gaps: live execution ↔ doc's declared Sample Response ─
    const executionSkipped = !!newmanResult?.error && (
      newmanResult.error.includes('Not exercised live') || newmanResult.error.includes('No ') || newmanResult.error.includes('Could not obtain')
    );
    if (newmanResult && tryOutResult && !executionSkipped) {
      const liveKeys = newmanResult.responseBodyKeys;
      const docKeys  = tryOutResult.responseBodyKeys;

      if (liveKeys && docKeys) {
        const liveSet = new Set(liveKeys.map(norm));
        const dcSet   = new Set(docKeys.map(norm));
        for (const key of liveKeys) {
          if (!dcSet.has(norm(key))) {
            mismatches.push({
              type: 'response_body_mismatch', field: key,
              source: 'Live Swagger response → Doc Sample Response',
              detail: `Live execution response has field "${key}" that is missing from the doc's declared Sample Response`,
              severity: 'warning',
            });
          }
        }
        for (const key of docKeys) {
          if (!liveSet.has(norm(key))) {
            mismatches.push({
              type: 'response_body_mismatch', field: key,
              source: 'Doc Sample Response → Live Swagger response',
              detail: `Doc's Sample Response has field "${key}" that is missing from the actual live response`,
              severity: 'warning',
            });
          }
        }
      }

      if (!newmanResult.passed) {
        mismatches.push({
          type: 'newman_failure',
          source: 'Swagger execution',
          detail: `Live request returned ${newmanResult.responseCode}${newmanResult.error ? ` — ${newmanResult.error}` : ''}`,
          severity: 'error',
        });
      }
    } else if (!newmanResult) {
      mismatches.push({
        type: 'newman_failure',
        source: 'Swagger execution',
        detail: `No live execution result found for "${doc.name}" — request may not be covered by the runner's lifecycle`,
        severity: 'warning',
      });
    } else if (newmanResult && !newmanResult.passed) {
      mismatches.push({
        type: 'newman_failure',
        source: 'Swagger execution',
        detail: `Live request returned ${newmanResult.responseCode}${newmanResult.error ? ` — ${newmanResult.error}` : ''}`,
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

  // ── Coverage: OpenAPI operations missing from the docs ──────────────────
  for (const sw of swaggerRequests) {
    if (matchedSwaggerNames.has(sw.name)) continue;
    const docMatch = findByName(sw.name, scraped, s => s.doc.name);
    if (docMatch) continue;
    results.push({
      requestName: sw.name,
      endpoint:    sw.url ?? '',
      method:      sw.method ?? '',
      docUrl:      '',
      mismatches: [{
        type: 'missing_in_doc',
        source: 'OpenAPI spec → Doc',
        detail: `OpenAPI spec has operation "${sw.name}" (${sw.method ?? ''}) with no matching request in the docs`,
        severity: 'warning',
      }],
      status: 'warning',
    });
  }

  const outPath = path.join(__dirname, '../../../reports/comparison-results-launch.json');
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));

  const pass = results.filter(r => r.status === 'pass').length;
  const warn = results.filter(r => r.status === 'warning').length;
  const fail = results.filter(r => r.status === 'fail').length;
  console.log(`\n📊  Comparison done (Launch) — ✅ ${pass} pass  ⚠️ ${warn} warning  ❌ ${fail} fail`);
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

runComparisonLaunch().catch(console.error);
