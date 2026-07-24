import * as fs from 'fs';
import * as path from 'path';
import { ComparisonResult, Mismatch, DocRequest, TryOutData, TryOutTestResult, NewmanResult, PostmanRequest } from '../../../config/types';

/**
 * Three-way comparison for the GraphQL Content Delivery API — reframed for
 * GraphQL's shape (query field sets, not REST params/headers):
 *   A = Doc's declared query text (scraped from the doc page)
 *   B = Live Try Out (GraphiQL Explorer) — real executed query, default
 *       sample-stack credentials (confirmed live, see README "GraphQL" section)
 *   C = Postman collection's query text + live Newman execution
 *
 * Checks:
 *  1. Field-set comparison: Doc query ↔ Postman query (extractGraphQLFields()
 *     below — a lightweight tokenizer, not a full GraphQL parser, same
 *     "good enough" spirit as extractKeys() for JSON elsewhere in this repo)
 *  2. Response field comparison: live Try Out response ↔ live Newman response
 *     (both hit the same real API — should agree)
 *  3. Execution failures on either side
 *  4. Coverage: Postman requests with no matching doc title, and vice versa
 */

const scrapedPath = path.join(__dirname, '../../../reports/scraped-requests-graphql.json');
const tryOutResultsPath = path.join(__dirname, '../../../reports/tryout-results-graphql.json');
const newmanResultsPath = path.join(__dirname, '../../../reports/newman-results-graphql.json');
const postmanCachePath = path.join(__dirname, '../../../reports/postman-collection-graphql.json');

export async function runComparisonGraphQL(): Promise<ComparisonResult[]> {
  if (!fs.existsSync(scrapedPath)) {
    throw new Error('scraped-requests-graphql.json not found — run `npm run scrape:graphql` first');
  }
  const scraped: Array<{ doc: DocRequest; tryOut: TryOutData; explorerUrl: string }> = JSON.parse(fs.readFileSync(scrapedPath, 'utf-8'));

  const tryOutResults: TryOutTestResult[] = fs.existsSync(tryOutResultsPath)
    ? JSON.parse(fs.readFileSync(tryOutResultsPath, 'utf-8')) : [];
  const newmanResults: NewmanResult[] = fs.existsSync(newmanResultsPath)
    ? JSON.parse(fs.readFileSync(newmanResultsPath, 'utf-8')) : [];
  const postmanRequests: PostmanRequest[] = fs.existsSync(postmanCachePath)
    ? JSON.parse(fs.readFileSync(postmanCachePath, 'utf-8'))
    : (() => { throw new Error('postman-collection-graphql.json not found — run `npm run newman:graphql` first'); })();

  const results: ComparisonResult[] = [];
  const matchedPostmanNames = new Set<string>();

  for (const { doc, tryOut } of scraped) {
    const mismatches: Mismatch[] = [];

    const postmanReq   = findByName(doc.name, postmanRequests, r => r.name);
    if (postmanReq) matchedPostmanNames.add(postmanReq.name);
    const newmanResult = findByName(doc.name, newmanResults, r => r.requestName);
    const tryOutResult = findByName(doc.name, tryOutResults, r => r.requestName);

    // ── 1. Field-set comparison: Doc query ↔ Postman query ──────────────────
    if (postmanReq) {
      const postmanQuery = (postmanReq.body as any)?.graphql?.query ?? postmanReq.body?.raw;
      const docFields     = extractGraphQLFields(tryOut.bodyContent);
      const postmanFields = extractGraphQLFields(postmanQuery);

      if (docFields && postmanFields) {
        const dcSet = new Set(docFields);
        const pmSet = new Set(postmanFields);
        for (const f of postmanFields) {
          if (!dcSet.has(f)) {
            mismatches.push({
              type: 'request_body_mismatch', field: f,
              source: 'Postman query → Doc query',
              detail: `Postman's query references field/argument "${f}" not found in the doc's declared query`,
              severity: 'warning',
            });
          }
        }
        for (const f of docFields) {
          if (!pmSet.has(f)) {
            mismatches.push({
              type: 'request_body_mismatch', field: f,
              source: 'Doc query → Postman query',
              detail: `Doc's declared query references field/argument "${f}" not found in Postman's query`,
              severity: 'warning',
            });
          }
        }
      } else if (!postmanQuery) {
        mismatches.push({
          type: 'request_body_mismatch',
          source: 'Doc → Postman',
          detail: 'Postman request has no GraphQL query body',
          severity: 'error',
        });
      }
    } else {
      mismatches.push({
        type: 'missing_in_postman',
        source: 'Doc → Postman',
        detail: `No matching request found in the GraphQL Postman collection for "${doc.name}"`,
        severity: 'warning',
      });
    }

    // ── 2. Response field comparison: live Try Out ↔ live Newman ─────────────
    if (newmanResult && tryOutResult) {
      const liveKeys = newmanResult.responseBodyKeys;
      const tryKeys  = tryOutResult.responseBodyKeys;

      if (liveKeys && tryKeys) {
        const liveSet = new Set(liveKeys);
        const trySet  = new Set(tryKeys);
        for (const key of liveKeys) {
          if (!trySet.has(key)) {
            mismatches.push({
              type: 'response_body_mismatch', field: key,
              source: 'Newman response → Try Out response',
              detail: `Postman (Newman) response has top-level field "${key}" missing from the Try Out (Explorer) response`,
              severity: 'warning',
            });
          }
        }
        for (const key of tryKeys) {
          if (!liveSet.has(key)) {
            mismatches.push({
              type: 'response_body_mismatch', field: key,
              source: 'Try Out response → Newman response',
              detail: `Try Out (Explorer) response has top-level field "${key}" missing from the Postman (Newman) response`,
              severity: 'warning',
            });
          }
        }
      }

      if (!newmanResult.passed) {
        mismatches.push({
          type: 'newman_failure',
          source: 'Postman (Newman)',
          detail: `Postman request returned ${newmanResult.responseCode}${newmanResult.error ? ` — ${newmanResult.error}` : ''}`,
          severity: 'error',
        });
      }
      if (!tryOutResult.passed) {
        mismatches.push({
          type: 'tryout_execution_failure',
          source: 'Try Out (Explorer)',
          detail: `Try Out execution failed: ${tryOutResult.flags?.join(' | ') ?? 'unknown error'}`,
          severity: 'error',
        });
      }
    } else {
      if (!newmanResult) {
        mismatches.push({ type: 'newman_failure', source: 'Postman (Newman)', detail: `No Newman result found for "${doc.name}"`, severity: 'warning' });
      }
      if (!tryOutResult) {
        mismatches.push({ type: 'tryout_execution_failure', source: 'Try Out (Explorer)', detail: `No Try Out result found for "${doc.name}"`, severity: 'warning' });
      }
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

  // ── Coverage: Postman requests missing from the docs ────────────────────
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
        detail: `Postman collection has request "${pm.name}" with no matching request in the docs`,
        severity: 'warning',
      }],
      status: 'warning',
    });
  }

  const outPath = path.join(__dirname, '../../../reports/comparison-results-graphql.json');
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));

  const pass = results.filter(r => r.status === 'pass').length;
  const warn = results.filter(r => r.status === 'warning').length;
  const fail = results.filter(r => r.status === 'fail').length;
  console.log(`\n📊  Comparison done (GraphQL) — ✅ ${pass} pass  ⚠️ ${warn} warning  ❌ ${fail} fail`);
  console.log(`📝  Results → ${outPath}`);

  return results;
}

/**
 * Lightweight GraphQL field/argument-name extractor — NOT a full GraphQL
 * parser. Strips string literals (so locale values like "en-us" aren't
 * mistaken for field names), then tokenizes remaining identifiers, dropping
 * GraphQL keywords. Deliberately captures both selection fields AND argument
 * names (e.g. "locale", "where") in one set — useful for a 3-way diff where
 * either kind of mismatch matters, same "good enough" spirit as this repo's
 * existing extractKeys() JSON helper.
 */
function extractGraphQLFields(query: string | undefined): string[] | undefined {
  if (!query?.trim()) return undefined;
  const KEYWORDS = new Set(['query', 'mutation', 'subscription', 'fragment', 'on', 'true', 'false', 'null']);
  const noStrings = query.replace(/"(?:[^"\\]|\\.)*"/g, '""');
  // Strip the operation name (e.g. "query EqualsOperator {" / "query GetFoo(" ) —
  // it's an arbitrary GraphQL operation label, not a field/argument reference,
  // and Postman names its operations while the doc's examples are anonymous
  // ("query {"), which was producing pure-noise mismatches.
  const noOpName = noStrings.replace(/\b(query|mutation|subscription)\s+[A-Za-z_][A-Za-z0-9_]*/g, '$1');
  const tokens = noOpName.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
  const seen = new Set<string>();
  for (const t of tokens) {
    if (KEYWORDS.has(t)) continue;
    seen.add(t);
  }
  return seen.size ? Array.from(seen) : undefined;
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

runComparisonGraphQL().catch(console.error);
