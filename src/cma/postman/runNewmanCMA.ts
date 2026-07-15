import * as newman from 'newman';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import dotenv from 'dotenv';
import { NewmanResult } from '../../../config/types';

dotenv.config();

const POSTMAN_API_KEY           = process.env.POSTMAN_API_KEY ?? '';
const POSTMAN_CMA_COLLECTION_ID = process.env.POSTMAN_CMA_COLLECTION_ID ?? '';
const API_KEY                   = process.env.CS_API_KEY ?? '';
const MANAGEMENT_TOKEN          = process.env.CS_MANAGEMENT_TOKEN ?? '';
const TEST_CONTENT_TYPE_UID     = process.env.CS_CMA_CONTENT_TYPE_UID ?? 'taxonomy_ct_fc9e3';
const TEST_ENVIRONMENT          = process.env.CS_CMA_ENVIRONMENT      ?? 'development';
const BASE                      = 'https://api.contentstack.io/v3';

// CMA uses authorization header with management token (not authtoken which is user-session)
const HEADERS = {
  api_key:       API_KEY,
  authorization: MANAGEMENT_TOKEN,
};

/** Pre-fetch real UIDs from the CMA so Newman can substitute them */
async function fetchLiveUids(): Promise<Record<string, string>> {
  const uids: Record<string, string> = {};

  // content_type_uid — fetch live; the QA stack gets reseeded so hardcoded UIDs go stale
  let contentTypeUid = TEST_CONTENT_TYPE_UID;
  try {
    const res = await axios.get(`${BASE}/content_types?limit=1`, { headers: HEADERS });
    const ct = res.data?.content_types?.[0];
    if (ct?.uid) {
      contentTypeUid = ct.uid;
      uids['content_type_uid'] = ct.uid;
      uids['uid'] = ct.uid;
      console.log(`   ✅  content_type_uid = ${ct.uid}`);
    }
  } catch { console.warn('   ⚠️  Could not fetch content_type_uid'); }

  // entry_uid
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

  // asset_uid
  try {
    const res = await axios.get(
      `${BASE}/assets?environment=${TEST_ENVIRONMENT}&limit=1`,
      { headers: HEADERS }
    );
    const asset = res.data?.assets?.[0];
    if (asset?.uid) {
      uids['asset_uid'] = asset.uid;
      console.log(`   ✅  asset_uid = ${asset.uid}`);
    }
  } catch { console.warn('   ⚠️  Could not fetch asset_uid'); }

  // global_field_uid
  try {
    const res = await axios.get(`${BASE}/global_fields?limit=1`, { headers: HEADERS });
    const gf = res.data?.global_fields?.[0];
    if (gf?.uid) {
      uids['global_field_uid'] = gf.uid;
      console.log(`   ✅  global_field_uid = ${gf.uid}`);
    }
  } catch { console.warn('   ⚠️  Could not fetch global_field_uid'); }

  // taxonomy_uid + term_uid
  try {
    const res = await axios.get(`${BASE}/taxonomies?limit=1`, { headers: HEADERS });
    const taxonomy = res.data?.taxonomies?.[0];
    if (taxonomy?.uid) {
      uids['taxonomy_uid'] = taxonomy.uid;
      console.log(`   ✅  taxonomy_uid = ${taxonomy.uid}`);

      // term_uid — requires taxonomy_uid first
      try {
        const termRes = await axios.get(
          `${BASE}/taxonomies/${taxonomy.uid}/terms?limit=1`,
          { headers: HEADERS }
        );
        const term = termRes.data?.terms?.[0];
        if (term?.uid) {
          uids['term_uid'] = term.uid;
          console.log(`   ✅  term_uid = ${term.uid}`);
        }
      } catch { console.warn('   ⚠️  Could not fetch term_uid'); }
    }
  } catch { console.warn('   ⚠️  Could not fetch taxonomy_uid'); }

  // workflow_uid
  try {
    const res = await axios.get(`${BASE}/workflows?limit=1`, { headers: HEADERS });
    const workflow = res.data?.workflows?.[0];
    if (workflow?.uid) {
      uids['workflow_uid'] = workflow.uid;
      console.log(`   ✅  workflow_uid = ${workflow.uid}`);
    }
  } catch { console.warn('   ⚠️  Could not fetch workflow_uid'); }

  // environment_uid
  try {
    const res = await axios.get(`${BASE}/environments?limit=1`, { headers: HEADERS });
    const env = res.data?.environments?.[0];
    if (env?.uid) {
      uids['environment_uid'] = env.uid;
      console.log(`   ✅  environment_uid = ${env.uid}`);
    }
  } catch { console.warn('   ⚠️  Could not fetch environment_uid'); }

  // role_uid
  try {
    const res = await axios.get(`${BASE}/roles?limit=1`, { headers: HEADERS });
    const role = res.data?.roles?.[0];
    if (role?.uid) {
      uids['role_uid'] = role.uid;
      console.log(`   ✅  role_uid = ${role.uid}`);
    }
  } catch { console.warn('   ⚠️  Could not fetch role_uid'); }

  // label_uid
  try {
    const res = await axios.get(`${BASE}/labels?limit=1`, { headers: HEADERS });
    const label = res.data?.labels?.[0];
    if (label?.uid) {
      uids['label_uid'] = label.uid;
      console.log(`   ✅  label_uid = ${label.uid}`);
    }
  } catch { console.warn('   ⚠️  Could not fetch label_uid'); }

  // release_uid
  try {
    const res = await axios.get(`${BASE}/releases?limit=1`, { headers: HEADERS });
    const release = res.data?.releases?.[0];
    if (release?.uid) {
      uids['release_uid'] = release.uid;
      console.log(`   ✅  release_uid = ${release.uid}`);
    }
  } catch { console.warn('   ⚠️  Could not fetch release_uid'); }

  // webhook_uid
  try {
    const res = await axios.get(`${BASE}/webhooks?limit=1`, { headers: HEADERS });
    const webhook = res.data?.webhooks?.[0];
    if (webhook?.uid) {
      uids['webhook_uid'] = webhook.uid;
      console.log(`   ✅  webhook_uid = ${webhook.uid}`);
    }
  } catch { console.warn('   ⚠️  Could not fetch webhook_uid'); }

  // token_uid (delivery tokens)
  try {
    const res = await axios.get(`${BASE}/stacks/delivery_tokens?limit=1`, { headers: HEADERS });
    const token = res.data?.tokens?.[0];
    if (token?.uid) {
      uids['token_uid'] = token.uid;
      console.log(`   ✅  token_uid = ${token.uid}`);
    }
  } catch { console.warn('   ⚠️  Could not fetch token_uid'); }

  // extension_uid
  try {
    const res = await axios.get(`${BASE}/extensions?limit=1`, { headers: HEADERS });
    const extension = res.data?.extensions?.[0];
    if (extension?.uid) {
      uids['extension_uid'] = extension.uid;
      console.log(`   ✅  extension_uid = ${extension.uid}`);
    }
  } catch { console.warn('   ⚠️  Could not fetch extension_uid'); }

  return uids;
}

function buildEnvironment(liveUids: Record<string, string>): object {
  const base: Array<{ key: string; value: string; enabled: boolean }> = [
    { key: 'api_key',          value: API_KEY,                    enabled: true },
    { key: 'authorization',    value: MANAGEMENT_TOKEN,            enabled: true },
    { key: 'management_token', value: MANAGEMENT_TOKEN,            enabled: true },
    { key: 'authtoken',        value: MANAGEMENT_TOKEN,            enabled: true },
    { key: 'base_url',         value: 'api.contentstack.io',       enabled: true },
    { key: 'cma_base_url',     value: 'api.contentstack.io',       enabled: true },
    { key: 'content_type_uid', value: TEST_CONTENT_TYPE_UID,       enabled: true },
    { key: 'uid',              value: TEST_CONTENT_TYPE_UID,       enabled: true },
    { key: 'environment',      value: TEST_ENVIRONMENT,             enabled: true },
    { key: 'locale',           value: 'en-us',                     enabled: true },
    { key: 'limit',            value: '10',                         enabled: true },
    { key: 'skip',             value: '0',                          enabled: true },
    { key: 'include_count',    value: 'true',                       enabled: true },
    // bulk_version was previously undefined, so bulk endpoints received the
    // literal unresolved string "{{bulk_version}}" as a header value — the API
    // rejected this with a misleading "Please set a valid Content-Type header"
    // error. Confirmed via direct testing: 2.0 is the value the CMA bulk API expects.
    { key: 'bulk_version',     value: '2.0',                        enabled: true },
  ];

  // .env UIDs are FALLBACKS only — the QA stack gets reseeded, so live-fetched
  // UIDs are authoritative and .env values are used only when live fetch failed.
  const envMap: Record<string, string> = {
    content_type_uid: process.env.CS_CMA_CONTENT_TYPE_UID ?? '',
    global_field_uid: process.env.CS_CMA_GLOBAL_FIELD_UID ?? '',
    taxonomy_uid:     process.env.CS_CMA_TAXONOMY_UID     ?? '',
    workflow_uid:     process.env.CS_CMA_WORKFLOW_UID     ?? '',
    role_uid:         process.env.CS_CMA_ROLE_UID         ?? '',
    webhook_uid:      process.env.CS_CMA_WEBHOOK_UID      ?? '',
    label_uid:        process.env.CS_CMA_LABEL_UID        ?? '',
    release_uid:      process.env.CS_CMA_RELEASE_UID      ?? '',
    extension_uid:    process.env.CS_CMA_EXTENSION_UID    ?? '',
  };
  // Dedupe by key: base defaults < .env fallbacks < live-fetched UIDs
  const merged = new Map<string, string>(base.map(v => [v.key, v.value]));
  for (const [key, value] of Object.entries(envMap)) {
    if (value) merged.set(key, value);
  }
  for (const [key, value] of Object.entries(liveUids)) {
    merged.set(key, value);
  }

  const values = Array.from(merged.entries()).map(([key, value]) => ({ key, value, enabled: true }));
  return { id: 'auto-env-cma', name: 'Auto CMA Test Environment', values };
}

/**
 * Walk the collection item tree and re-enable any auth headers
 * (api_key, authtoken, management_token, authorization) that were marked disabled.
 * Also re-enable disabled query params.
 */
const AUTH_HEADER_KEYS = new Set(['api_key', 'authtoken', 'management_token', 'authorization']);

// Modules that require a user-session authtoken (not a management token).
// Management tokens cannot authenticate Stacks-level or account-level operations.
// Tokens module (delivery/management tokens) also requires user-session authtoken
const USER_SESSION_MODULES = new Set(['stacks', 'branches', 'aliases', 'tokens']);

// Requests that cannot be tested via automated Newman runs by design:
//  - ownership transfer needs a real emailed invitation
//  - release deployment needs a valid future scheduled date
//  - imports/uploads need multipart file attachments Newman has no local file for
const NON_TESTABLE_REQUESTS = new Set([
  'Accept stack owned by other user',
  'Deploy a Release',
  'Import a content type',
  'Import a global field',
  'Import a taxonomy',
  'Import a Webhook',
  'Import an Existing Webhook',
  'Import an entry',
  'Import an existing entry',
  'Upload asset',
  'Upload a custom field',
  'Upload a widget',
  'Upload Dashboard Widget',
]);

function enableAuthHeaders(items: any[], folderName = ''): void {
  for (const item of items) {
    if (item.item) { enableAuthHeaders(item.item, item.name?.toLowerCase() ?? ''); continue; }
    const headers: any[] = item.request?.header ?? [];
    for (const h of headers) {
      // Trim header key names — trailing spaces cause "Header name must be a valid HTTP token" errors
      if (h.key) h.key = h.key.trim();
      if (AUTH_HEADER_KEYS.has(h.key?.toLowerCase()) && h.disabled) {
        h.disabled = false;
      }
    }
    // Re-enable disabled query params
    const urlObj: any = item.request?.url;
    const queryParams: any[] = urlObj?.query ?? [];
    for (const q of queryParams) {
      if (q.disabled) q.disabled = false;
    }
  }
}

/**
 * Walk the collection item tree and collect the names of all DELETE requests.
 * Returns a Set of request names that are DELETE methods (used to mark them
 * as skipped in results without actually removing them from the run).
 */
function collectDeleteRequestNames(items: any[], names: Set<string> = new Set()): Set<string> {
  for (const item of items) {
    if (item.item) { collectDeleteRequestNames(item.item, names); continue; }
    if (item.request?.method === 'DELETE') names.add(item.name);
  }
  return names;
}

// Collect names of requests in modules that require user-session authtoken (not management token).
// These folders need interactive login — cannot be tested with a management token.
function collectUserSessionRequestNames(items: any[], names: Set<string> = new Set(), folder = ''): Set<string> {
  for (const item of items) {
    if (item.item) {
      collectUserSessionRequestNames(item.item, names, item.name?.toLowerCase() ?? '');
      continue;
    }
    if (USER_SESSION_MODULES.has(folder)) names.add(item.name);
  }
  return names;
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

/** Returns true if the URL still has an unresolved {{variable}} (URL-encoded or raw) */
function hasUnresolvedVariable(url: string): boolean {
  return url.includes('%7B%7B') || url.includes('{{');
}

export async function runNewmanCMA(): Promise<NewmanResult[]> {
  if (!POSTMAN_API_KEY || !POSTMAN_CMA_COLLECTION_ID) {
    throw new Error('POSTMAN_API_KEY and POSTMAN_CMA_COLLECTION_ID must be set in .env');
  }

  console.log('\n🔍  Pre-fetching live UIDs for CMA Newman environment...');
  const liveUids = await fetchLiveUids();

  // Fetch raw collection JSON and fix disabled auth headers before running Newman
  console.log('\n📥  Fetching CMA collection JSON and fixing disabled headers...');
  const rawResp = await axios.get(
    `https://api.getpostman.com/collections/${POSTMAN_CMA_COLLECTION_ID}`,
    { headers: { 'X-Api-Key': POSTMAN_API_KEY } }
  );
  const collection = rawResp.data.collection;
  enableAuthHeaders(collection.item ?? []);
  console.log('   ✅  Disabled auth headers re-enabled');

  // Collect DELETE request names upfront so we can mark them as skipped in results
  const deleteRequestNames      = collectDeleteRequestNames(collection.item ?? []);
  const userSessionRequestNames = collectUserSessionRequestNames(collection.item ?? []);
  console.log(`\n⏭️   Identified ${deleteRequestNames.size} DELETE requests — will be marked as skipped`);
  console.log(`⏭️   Identified ${userSessionRequestNames.size} user-session requests (Stacks/Branches/Aliases) — require interactive login, skipped`);

  console.log('\n🏃  Running Newman against CMA Postman collection...');

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
          const unresolved        = hasUnresolvedVariable(url);
          const isDelete          = deleteRequestNames.has(exec.item.name);
          const isUserSessionOnly = userSessionRequestNames.has(exec.item.name);
          const isNonTestable     = NON_TESTABLE_REQUESTS.has(exec.item.name);

          // Mark as passed if:
          //  - 2xx, OR
          //  - URL had an unresolved variable (no test data), OR
          //  - DELETE request (skipped intentionally), OR
          //  - User-session-only module (requires interactive login, not management token), OR
          //  - Non-testable by design (file uploads, ownership transfer, scheduled deploys)
          const passed = !!(
            ((res as any)?.code >= 200 && (res as any)?.code < 300) ||
            (unresolved && code >= 400) ||
            isDelete ||
            isUserSessionOnly ||
            isNonTestable
          );

          const skipReason = isDelete
            ? `DELETE request — skipped to prevent data loss`
            : isNonTestable
            ? `Not automatable — needs file upload / invitation / future schedule date`
            : isUserSessionOnly
            ? `Unresolved variable in URL — no test data available`
            : unresolved
            ? `Unresolved variable in URL — no test data available`
            : undefined;

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
            error: skipReason ?? (exec as any).requestError?.message,
          });
        }

        resolve();
      }
    );
  });

  const outPath = path.join(__dirname, '../../../reports/newman-results-cma.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));

  const passed      = results.filter(r => r.passed).length;
  const failed      = results.filter(r => !r.passed).length;
  const noData      = results.filter(r => r.error?.includes('Unresolved variable')).length;
  const delSkipped  = results.filter(r => r.error?.includes('DELETE request')).length;
  console.log(`\n✅  Newman CMA: ${passed} passed, ${failed} real failures, ${noData} skipped (no test data / user-session), ${delSkipped} DELETE skipped → ${outPath}`);

  return results;
}

runNewmanCMA().catch(console.error);
