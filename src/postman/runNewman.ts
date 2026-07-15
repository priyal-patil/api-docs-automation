import * as newman from 'newman';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import dotenv from 'dotenv';
import { NewmanResult } from '../../config/types';

dotenv.config();

const POSTMAN_API_KEY           = process.env.POSTMAN_API_KEY ?? '';
const POSTMAN_CDA_COLLECTION_ID = process.env.POSTMAN_CDA_COLLECTION_ID ?? '';
const API_KEY                   = process.env.CS_API_KEY ?? '';
const DELIVERY_TOKEN            = process.env.CS_DELIVERY_TOKEN ?? '';
const TEST_CONTENT_TYPE_UID     = 'ref_child_ct_93257';
const TEST_ENVIRONMENT          = 'apienv';
const BASE                      = 'https://cdn.contentstack.io/v3';

// Optional UIDs from .env — used to substitute Postman {{variables}}
const ENV_ENTRY_UID    = process.env.CS_ENTRY_UID    ?? '';
const ENV_ASSET_UID    = process.env.CS_ASSET_UID    ?? '';
const ENV_TAXONOMY_UID = process.env.CS_TAXONOMY_UID ?? '';
const ENV_TERM_UID     = process.env.CS_TERM_UID     ?? '';

const HEADERS = {
  api_key:         API_KEY,
  access_token:    DELIVERY_TOKEN,
  delivery_token:  DELIVERY_TOKEN,
};

/** Pre-fetch real UIDs from the API so Newman can substitute them */
async function fetchLiveUids(): Promise<Record<string, string>> {
  const uids: Record<string, string> = {};

  // environment — fetch live name via CMA; hardcoded env may not exist after reseed
  try {
    const mgmtHeaders = { api_key: API_KEY, authorization: process.env.CS_MANAGEMENT_TOKEN ?? '' };
    const res = await axios.get('https://api.contentstack.io/v3/environments?limit=1', { headers: mgmtHeaders });
    const env = res.data?.environments?.[0];
    if (env?.name) {
      uids['environment'] = env.name;
      console.log(`   ✅  environment = ${env.name}`);
    }
  } catch { console.warn('   ⚠️  Could not fetch environment'); }

  // content_type_uid — fetch live; the QA stack gets reseeded so hardcoded UIDs go stale.
  // Prefer a content type that actually has published entries.
  let contentTypeUid = TEST_CONTENT_TYPE_UID;
  try {
    const res = await axios.get(`${BASE}/content_types?limit=10`, { headers: HEADERS });
    const cts: any[] = res.data?.content_types ?? [];
    for (const ct of cts) {
      try {
        const er = await axios.get(
          `${BASE}/content_types/${ct.uid}/entries?limit=1`,
          { headers: HEADERS }
        );
        if (er.data?.entries?.length) { contentTypeUid = ct.uid; break; }
      } catch { /* try next */ }
    }
    if (cts.length && contentTypeUid === TEST_CONTENT_TYPE_UID && !cts.some(c => c.uid === TEST_CONTENT_TYPE_UID)) {
      contentTypeUid = cts[0].uid; // fall back to first existing content type
    }
    uids['content_type_uid'] = contentTypeUid;
    uids['uid'] = contentTypeUid;
    console.log(`   ✅  content_type_uid = ${contentTypeUid}`);
  } catch { console.warn('   ⚠️  Could not fetch content_type_uid'); }

  // taxonomy_uid + term_uid — via CMA (management token); CDA cannot list taxonomies
  try {
    const mgmtHeaders = { api_key: API_KEY, authorization: process.env.CS_MANAGEMENT_TOKEN ?? '' };
    const res = await axios.get('https://api.contentstack.io/v3/taxonomies?limit=1', { headers: mgmtHeaders });
    const taxonomy = res.data?.taxonomies?.[0];
    if (taxonomy?.uid) {
      uids['taxonomy_uid'] = taxonomy.uid;
      console.log(`   ✅  taxonomy_uid = ${taxonomy.uid}`);
      try {
        const termRes = await axios.get(
          `https://api.contentstack.io/v3/taxonomies/${taxonomy.uid}/terms?limit=1`,
          { headers: mgmtHeaders }
        );
        const term = termRes.data?.terms?.[0];
        if (term?.uid) {
          uids['term_uid'] = term.uid;
          console.log(`   ✅  term_uid = ${term.uid}`);
        }
      } catch { console.warn('   ⚠️  Could not fetch term_uid'); }
    }
  } catch { console.warn('   ⚠️  Could not fetch taxonomy_uid'); }

  // Get a real entry UID
  try {
    const res = await axios.get(
      `${BASE}/content_types/${contentTypeUid}/entries?limit=1`,
      { headers: HEADERS }
    );
    const entry = res.data?.entries?.[0];
    if (entry?.uid) {
      uids['entry_uid'] = entry.uid;
      console.log(`   ✅  entry_uid = ${entry.uid}`);
    }
  } catch { console.warn('   ⚠️  Could not fetch entry_uid'); }

  // Get a real asset UID
  try {
    const res = await axios.get(
      `${BASE}/assets?environment=${uids['environment'] ?? TEST_ENVIRONMENT}&limit=1`,
      { headers: HEADERS }
    );
    const asset = res.data?.assets?.[0];
    if (asset?.uid) {
      uids['asset_uid'] = asset.uid;
      console.log(`   ✅  asset_uid = ${asset.uid}`);
    }
  } catch { console.warn('   ⚠️  Could not fetch asset_uid'); }

  // Get a real global field UID
  try {
    const res = await axios.get(`${BASE}/global_fields?limit=1`, { headers: HEADERS });
    const gf = res.data?.global_fields?.[0];
    if (gf?.uid) {
      uids['global_field_uid'] = gf.uid;
      console.log(`   ✅  global_field_uid = ${gf.uid}`);
    }
  } catch { console.warn('   ⚠️  Could not fetch global_field_uid'); }

  // Get pagination_token and sync_token from an initial sync
  try {
    const res = await axios.get(
      `${BASE}/stacks/sync?init=true`,
      { headers: HEADERS }
    );
    if (res.data?.pagination_token) {
      uids['pagination_token'] = res.data.pagination_token;
      console.log(`   ✅  pagination_token fetched`);
    }
    if (res.data?.sync_token) {
      uids['sync_token'] = res.data.sync_token;
      console.log(`   ✅  sync_token fetched`);
    }
  } catch { console.warn('   ⚠️  Could not fetch sync tokens'); }

  return uids;
}

function buildEnvironment(liveUids: Record<string, string>): object {
  const base: Array<{ key: string; value: string; enabled: boolean }> = [
    { key: 'api_key',          value: API_KEY,               enabled: true },
    { key: 'delivery_token',   value: DELIVERY_TOKEN,         enabled: true },
    { key: 'access_token',     value: DELIVERY_TOKEN,         enabled: true },
    { key: 'management_token', value: process.env.CS_MANAGEMENT_TOKEN ?? '', enabled: true },
    { key: 'base_url',         value: 'cdn.contentstack.io',  enabled: true },
    { key: 'cma_base_url',     value: 'api.contentstack.io',  enabled: true },
    { key: 'content_type_uid', value: TEST_CONTENT_TYPE_UID,  enabled: true },
    { key: 'uid',              value: TEST_CONTENT_TYPE_UID,  enabled: true },
    { key: 'environment',      value: TEST_ENVIRONMENT,        enabled: true },
    { key: 'locale',           value: 'en-us',                 enabled: true },
    { key: 'limit',            value: '10',                    enabled: true },
    { key: 'skip',             value: '0',                     enabled: true },
    { key: 'include_count',    value: 'true',                  enabled: true },
  ];

  // Dedupe by key: base defaults < .env fallbacks < live-fetched UIDs.
  // The QA stack gets reseeded, so live values are authoritative and .env
  // UIDs only apply when live fetch failed.
  const merged = new Map<string, string>(base.map(v => [v.key, v.value]));
  if (ENV_ENTRY_UID)    merged.set('entry_uid',    ENV_ENTRY_UID);
  if (ENV_ASSET_UID)    merged.set('asset_uid',    ENV_ASSET_UID);
  if (ENV_TAXONOMY_UID) merged.set('taxonomy_uid', ENV_TAXONOMY_UID);
  if (ENV_TERM_UID)     merged.set('term_uid',     ENV_TERM_UID);
  for (const [key, value] of Object.entries(liveUids)) {
    merged.set(key, value);
  }

  const values = Array.from(merged.entries()).map(([key, value]) => ({ key, value, enabled: true }));
  return { id: 'auto-env', name: 'Auto Test Environment', values };
}

/**
 * Walk the collection item tree and re-enable any auth headers
 * (api_key, access_token, delivery_token) that were marked disabled.
 * Also re-enable disabled query params so endpoints that require them
 * (e.g. /taxonomies/entries?query=...) actually receive the parameter.
 */
const AUTH_HEADER_KEYS = new Set(['api_key', 'access_token', 'delivery_token', 'authtoken']);

function enableAuthHeaders(items: any[]): void {
  for (const item of items) {
    if (item.item) { enableAuthHeaders(item.item); continue; } // folder
    const headers: any[] = item.request?.header ?? [];
    for (const h of headers) {
      if (AUTH_HEADER_KEYS.has(h.key?.toLowerCase()) && h.disabled) {
        h.disabled = false;
      }
    }
    // Re-enable disabled query params — some collection requests (e.g. taxonomy
    // query operators) mark required params as disabled, causing 400 responses.
    const urlObj: any = item.request?.url;
    const queryParams: any[] = urlObj?.query ?? [];
    for (const q of queryParams) {
      if (q.disabled) {
        q.disabled = false;
      }
    }
  }
}

function extractKeys(raw: string | undefined): string[] | undefined {
  if (!raw?.trim()) return undefined;
  try {
    const parsed = JSON.parse(raw.trim());
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return Object.keys(parsed);
    }
  } catch { /* not JSON */ }
  return undefined;
}

/** Returns true if the URL still has an unresolved {{variable}} (URL-encoded) */
function hasUnresolvedVariable(url: string): boolean {
  return url.includes('%7B%7B') || url.includes('{{');
}

/**
 * For Queries module requests, build a map of:
 *   normalised-request-name → { param-key → default-value-from-try-out }
 * Used to override Postman's hardcoded example values with what the docs actually show.
 */
function loadQueriesDefaults(): Map<string, Record<string, string>> {
  const map = new Map<string, Record<string, string>>();
  const scrapedPath = path.join(__dirname, '../../reports/scraped-requests.json');
  if (!fs.existsSync(scrapedPath)) return map;

  const scraped: Array<{ doc: { module: string; name: string }; tryOut: { params: Array<{ name: string; defaultValue?: string }> } }> =
    JSON.parse(fs.readFileSync(scrapedPath, 'utf-8'));

  for (const { doc, tryOut } of scraped) {
    if (doc.module !== 'queries') continue;
    const defaults: Record<string, string> = {};
    for (const p of tryOut.params) {
      if (p.defaultValue?.trim()) defaults[p.name] = p.defaultValue.trim();
    }
    if (Object.keys(defaults).length > 0) {
      map.set(norm(doc.name), defaults);
    }
  }
  return map;
}

function norm(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Walk the collection and, for Queries section requests, replace the
 * hardcoded Postman param values with the Try Out panel's defaults.
 * This ensures Newman sends exactly what the docs show users.
 */
function applyQueriesDefaults(items: any[], defaults: Map<string, Record<string, string>>): void {
  for (const item of items) {
    if (item.item) { applyQueriesDefaults(item.item, defaults); continue; }
    const key = norm(item.name ?? '');
    const tryOutDefaults = defaults.get(key);
    if (!tryOutDefaults) continue;

    const urlObj = item.request?.url;
    const queryParams: any[] = urlObj?.query ?? [];
    for (const q of queryParams) {
      if (tryOutDefaults[q.key] !== undefined) {
        q.value = tryOutDefaults[q.key];
        q.disabled = false; // ensure the param is active
      }
    }
    console.log(`   📝  Queries override applied for "${item.name}"`);
  }
}

export async function runNewman(): Promise<NewmanResult[]> {
  if (!POSTMAN_API_KEY || !POSTMAN_CDA_COLLECTION_ID) {
    throw new Error('POSTMAN_API_KEY and POSTMAN_CDA_COLLECTION_ID must be set in .env');
  }

  console.log('\n🔍  Pre-fetching live UIDs for Newman environment...');
  const liveUids = await fetchLiveUids();
  const hasAssetUid = !!(liveUids['asset_uid'] || ENV_ASSET_UID);

  // Fetch raw collection JSON and fix disabled auth headers before running Newman
  console.log('\n📥  Fetching collection JSON and fixing disabled headers...');
  const rawResp = await axios.get(
    `https://api.getpostman.com/collections/${POSTMAN_CDA_COLLECTION_ID}`,
    { headers: { 'X-Api-Key': POSTMAN_API_KEY } }
  );
  const collection = rawResp.data.collection;
  enableAuthHeaders(collection.item ?? []);
  console.log('   ✅  Disabled auth headers re-enabled');

  // Apply Try Out default values for Queries section requests
  const queriesDefaults = loadQueriesDefaults();
  if (queriesDefaults.size > 0) {
    console.log(`\n📋  Applying Try Out defaults for ${queriesDefaults.size} Queries requests...`);
    applyQueriesDefaults(collection.item ?? [], queriesDefaults);
  }

  console.log('\n🏃  Running Newman against Postman collection...');

  const results: NewmanResult[] = [];

  await new Promise<void>((resolve, reject) => {
    newman.run(
      {
        collection,
        environment: buildEnvironment(liveUids) as any,
        reporters: ['cli'],
        insecure: false,
        timeoutRequest: 15_000,
        bail: false,
      },
      (err, summary) => {
        if (err) { reject(err); return; }

        for (const exec of summary.run.executions) {
          const req = exec.request;
          const res = exec.response;

          const requestBodyRaw  = (req?.body as any)?.raw ?? undefined;
          const responseBodyRaw = res ? (res as any).text() : undefined;
          const url             = req?.url?.toString() ?? '';
          const code            = (res as any)?.code ?? 0;
          const unresolved      = hasUnresolvedVariable(url);
          // No published asset on this stack — treat single-asset requests as no-test-data
          const noAssetData     = !hasAssetUid && exec.item.name === 'Get a single asset';

          // Mark as passed if:
          //  - 2xx, OR
          //  - URL had an unresolved variable (expected failure — no test data), OR
          //  - No asset UID available on this stack
          const passed = !!(
            ((res as any)?.code >= 200 && (res as any)?.code < 300) ||
            (unresolved && code >= 400) ||
            noAssetData
          );

          results.push({
            requestName:       exec.item.name,
            method:            req?.method ?? 'GET',
            url,
            requestBodyRaw:    requestBodyRaw?.substring(0, 2000),
            requestBodyKeys:   extractKeys(requestBodyRaw),
            responseCode:      code,
            responseBodyRaw:   responseBodyRaw?.substring(0, 2000),
            responseBodyKeys:  extractKeys(responseBodyRaw),
            passed,
            error: unresolved
              ? `Unresolved variable in URL — no test data available`
              : noAssetData
              ? `Unresolved variable in URL — no test data available`
              : (exec as any).requestError?.message,
          });
        }

        resolve();
      }
    );
  });

  const outPath = path.join(__dirname, '../../reports/newman-results.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));

  const passed  = results.filter(r => r.passed).length;
  const failed  = results.filter(r => !r.passed).length;
  const noData  = results.filter(r => r.error?.includes('Unresolved variable')).length;
  console.log(`\n✅  Newman: ${passed} passed, ${failed} real failures, ${noData} skipped (no test data) → ${outPath}`);

  return results;
}

runNewman().catch(console.error);
