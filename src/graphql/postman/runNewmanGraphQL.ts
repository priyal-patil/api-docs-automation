import * as newman from 'newman';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import dotenv from 'dotenv';
import { fetchPostmanCollection } from '../../shared/postman/fetchCollection';
import { NewmanResult } from '../../../config/types';

dotenv.config();

const POSTMAN_API_KEY               = process.env.POSTMAN_API_KEY ?? '';
const POSTMAN_GRAPHQL_COLLECTION_ID = process.env.POSTMAN_GRAPHQL_COLLECTION_ID ?? '';

// Per explicit user instruction: use the DEFAULT sample-stack credentials
// already pre-filled in the doc's own GraphiQL Explorer (confirmed live —
// these are real, working, and return genuine sample e-commerce data, e.g.
// "iPhone 7 128GB"), rather than our own QA stack (which lacks the
// product/category/etc. content model these 90 examples query against).
const BASE_HOST      = 'graphql.contentstack.com';
const SAMPLE_API_KEY = 'blt02f7b45378b008ee';
const SAMPLE_ACCESS_TOKEN = 'cs5b69faf35efdebd91d08bcf4';
const SAMPLE_ENVIRONMENT  = 'production';
// Confirmed live in the Explorer's Headers tab default (comma-separated
// example UIDs) — first one used for the two Variant-titled requests, which
// the Postman collection ships with x-cs-variant-uid DISABLED by default
// (see enableVariantHeader() below — a real, confirmed doc/collection
// discrepancy: the Explorer enables this header by default, Postman doesn't).
const SAMPLE_VARIANT_UID = 'csa639040f051b6db6';

function buildEnvironment(): object {
  const values = [
    { key: 'base_url',     value: BASE_HOST,           enabled: true },
    { key: 'api_key',      value: SAMPLE_API_KEY,      enabled: true },
    { key: 'environment',  value: SAMPLE_ENVIRONMENT,  enabled: true },
    { key: 'access_token', value: SAMPLE_ACCESS_TOKEN, enabled: true },
    { key: 'x-cs-variant-uid', value: SAMPLE_VARIANT_UID, enabled: true },
  ];
  return { id: 'auto-env-graphql', name: 'Auto GraphQL Test Environment', values };
}

/**
 * The Postman collection ships x-cs-variant-uid DISABLED on every request,
 * including the two that the collection's own header description says
 * require it ("Get Entry List with Variants", "Get Single Entry with
 * Variant"). Re-enable it only for those two — same "fix known disabled-
 * header issue" pattern as enableAuthHeaders() in every other Newman runner.
 */
function enableVariantHeaderForVariantRequests(items: any[]): void {
  for (const item of items) {
    if (item.item) { enableVariantHeaderForVariantRequests(item.item); continue; }
    if (!/variant/i.test(item.name ?? '')) continue;
    const headers: any[] = item.request?.header ?? [];
    for (const h of headers) {
      if (h.key === 'x-cs-variant-uid' && h.disabled) h.disabled = false;
    }
  }
}

function extractKeys(raw: string | undefined): string[] | undefined {
  if (!raw?.trim()) return undefined;
  try {
    const parsed = JSON.parse(raw.trim());
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return Object.keys(parsed);
  } catch { /* not JSON */ }
  return undefined;
}

export async function runNewmanGraphQL(): Promise<NewmanResult[]> {
  if (!POSTMAN_API_KEY || !POSTMAN_GRAPHQL_COLLECTION_ID) {
    throw new Error('POSTMAN_API_KEY and POSTMAN_GRAPHQL_COLLECTION_ID must be set in .env');
  }

  console.log('\n📥  Fetching GraphQL Postman collection...');
  const rawResp = await axios.get(
    `https://api.getpostman.com/collections/${POSTMAN_GRAPHQL_COLLECTION_ID}`,
    { headers: { 'X-Api-Key': POSTMAN_API_KEY } }
  );
  const collection = rawResp.data.collection;
  enableVariantHeaderForVariantRequests(collection.item ?? []);

  // Also produce the flattened, cached PostmanRequest[] the comparator reads —
  // same convention as every other product's fetchPostmanCollection() call.
  await fetchPostmanCollection(POSTMAN_GRAPHQL_COLLECTION_ID, 'postman-collection-graphql.json');

  console.log('\n🏃  Running Newman against the GraphQL Postman collection (89 read-only queries against the doc\'s default sample stack — no test-data lifecycle needed)...');

  const results: NewmanResult[] = [];

  await new Promise<void>((resolve, reject) => {
    newman.run(
      {
        collection,
        environment: buildEnvironment() as any,
        reporters: ['cli'],
        insecure: false,
        timeoutRequest: 20_000,
        bail: false,
      },
      (err, summary) => {
        if (err) { reject(err); return; }

        for (const exec of summary.run.executions) {
          const req = exec.request;
          const res = exec.response;

          const requestBodyRaw  = (req?.body as any)?.raw ?? (req?.body as any)?.graphql?.query ?? undefined;
          const responseBodyRaw = res ? (res as any).text() : undefined;
          const url             = req?.url?.toString() ?? '';
          const code             = (res as any)?.code ?? 0;
          const passed           = code >= 200 && code < 300;

          results.push({
            requestName:      exec.item.name,
            method:           req?.method ?? 'POST',
            url,
            requestBodyRaw:   requestBodyRaw?.substring(0, 2000),
            requestBodyKeys:  undefined, // GraphQL body isn't a flat JSON object — comparator extracts field names from the query text itself
            responseCode:     code,
            responseBodyRaw:  responseBodyRaw?.substring(0, 2000),
            responseBodyKeys: extractKeys(responseBodyRaw),
            passed,
            error: passed ? undefined : (exec as any).requestError?.message ?? `HTTP ${code}`,
          });
        }
        resolve();
      }
    );
  });

  const outPath = path.join(__dirname, '../../../reports/newman-results-graphql.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));

  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  console.log(`\n✅  Newman (GraphQL): ${passed} passed, ${failed} failed → ${outPath}`);

  return results;
}

runNewmanGraphQL().catch(console.error);
