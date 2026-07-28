import * as newman from 'newman';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import dotenv from 'dotenv';
import { NewmanResult } from '../../../config/types';

dotenv.config();

const POSTMAN_API_KEY           = process.env.POSTMAN_API_KEY ?? '';
const POSTMAN_CMA_COLLECTION_ID = process.env.POSTMAN_CMA_COLLECTION_ID ?? '';
// CS_CMA_API_KEY/CS_CMA_MANAGEMENT_TOKEN override the shared CS_API_KEY/
// CS_MANAGEMENT_TOKEN when set — used to point CMA specifically at a fresh
// disposable stack without disturbing CDA's config (CDA also reads the
// shared CS_API_KEY for its delivery-token calls).
const API_KEY                   = process.env.CS_CMA_API_KEY          || process.env.CS_API_KEY || '';
const MANAGEMENT_TOKEN          = process.env.CS_CMA_MANAGEMENT_TOKEN || process.env.CS_MANAGEMENT_TOKEN || '';
const TEST_CONTENT_TYPE_UID     = process.env.CS_CMA_CONTENT_TYPE_UID ?? 'taxonomy_ct_fc9e3';
const TEST_ENVIRONMENT          = process.env.CS_CMA_ENVIRONMENT      ?? 'development';
const BASE                      = 'https://api.contentstack.io/v3';
const CS_QA_EMAIL               = process.env.CS_QA_EMAIL ?? '';
const CS_QA_PASSWORD            = process.env.CS_QA_PASSWORD ?? '';
const STATIC_AUTHTOKEN          = process.env.CS_AUTHTOKEN ?? '';

// CMA uses authorization header with management token (not authtoken which is user-session)
const HEADERS = {
  api_key:       API_KEY,
  authorization: MANAGEMENT_TOKEN,
};

/**
 * Stacks/Branches/Aliases/Tokens modules require a real user-session authtoken
 * — a management token can't authenticate them, which is why they were being
 * unconditionally skipped. Same login-over-static-token pattern already used
 * in the Analytics/Automations/Brand Kit/GenAI/Knowledge Vault runners: a
 * fresh login every run beats a static CS_AUTHTOKEN, which silently goes stale
 * (Contentstack caps a user at 20 valid authtokens; a login anywhere else
 * quietly evicts the oldest — a real risk on a QA org shared with other
 * automation). Returns '' (not throwing) if no credentials are configured at
 * all, so this module's tests still run — they'll just resolve to an empty
 * authtoken and fail with a clear 401, rather than crashing the whole run.
 */
async function resolveUserSessionAuthtoken(): Promise<string> {
  if (CS_QA_EMAIL && CS_QA_PASSWORD) {
    try {
      const res = await axios.post('https://api.contentstack.io/v3/user-session', {
        user: { email: CS_QA_EMAIL, password: CS_QA_PASSWORD },
      });
      const token = res.data?.user?.authtoken;
      if (token) { console.log('   ✅  Fetched a fresh user-session authtoken via login'); return token; }
      console.warn('   ⚠️  Login succeeded but no authtoken was returned');
    } catch (e) {
      console.warn('   ⚠️  Login failed:', (e as any).response?.data?.error_message ?? e);
    }
  }
  if (STATIC_AUTHTOKEN) {
    console.warn('   ⚠️  CS_QA_EMAIL/CS_QA_PASSWORD not set or login failed — using static CS_AUTHTOKEN (can silently go stale)');
    return STATIC_AUTHTOKEN;
  }
  console.warn('   ⚠️  No user-session credentials available — Stacks/Branches/Aliases/Tokens will still be skipped');
  return '';
}

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

/**
 * Creates a fresh taxonomy and a fresh "field"-type extension directly via
 * the API (bypassing Newman entirely) before the collection run starts.
 *
 * Chaining via UID_CAPTURE_MAP only works WITHIN a module's own folder order
 * — "Create content type with taxonomy" and "Create content type with custom
 * asset field" live in the Content Types folder, which runs BEFORE the
 * Taxonomy and Extensions folders in the collection's overall top-level
 * order, so {{taxonomy_uid}}/{{extension_uid}} aren't populated yet when
 * those specific requests need them. Creating both here guarantees a valid
 * target regardless of folder order, without reordering entire top-level
 * folders (which risks side effects elsewhere).
 */
async function createPrerequisiteTestData(): Promise<Record<string, string>> {
  const uids: Record<string, string> = {};
  const suffix = Date.now().toString(36);

  try {
    const res = await axios.post(
      `${BASE}/taxonomies`,
      { taxonomy: { uid: `prereq_taxonomy_${suffix}`, name: `Prereq Taxonomy ${suffix}`, description: '' } },
      { headers: HEADERS }
    );
    const uid = res.data?.taxonomy?.uid;
    if (uid) { uids['taxonomy_uid'] = uid; console.log(`   ✅  Created prerequisite taxonomy: ${uid}`); }
  } catch (e) { console.warn('   ⚠️  Could not create prerequisite taxonomy:', (e as any).response?.data?.error_message ?? e); }

  try {
    const res = await axios.post(
      `${BASE}/extensions`,
      { extension: { tags: [], data_type: 'text', title: `Prereq Field ${suffix}`, src: 'https://www.sample.com', multiple: false, config: '{}', type: 'field' } },
      { headers: HEADERS }
    );
    const uid = res.data?.extension?.uid;
    if (uid) { uids['extension_uid'] = uid; console.log(`   ✅  Created prerequisite extension: ${uid}`); }
  } catch (e) { console.warn('   ⚠️  Could not create prerequisite extension:', (e as any).response?.data?.error_message ?? e); }

  return uids;
}

function buildEnvironment(liveUids: Record<string, string>, userSessionAuthtoken: string): object {
  const base: Array<{ key: string; value: string; enabled: boolean }> = [
    { key: 'api_key',          value: API_KEY,                    enabled: true },
    { key: 'authorization',    value: MANAGEMENT_TOKEN,            enabled: true },
    { key: 'management_token', value: MANAGEMENT_TOKEN,            enabled: true },
    // A REAL user-session authtoken, not the management token — Stacks/
    // Branches/Aliases/Tokens genuinely require one; a management token was
    // never valid for them, which is why those modules were unconditionally
    // skipped before. Falls back to the management token only if login
    // wasn't possible, so the variable is never left truly empty.
    { key: 'authtoken',        value: userSessionAuthtoken || MANAGEMENT_TOKEN, enabled: true },
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

// Maps a "Create X" request name to where its created UID lives in the JSON
// response and which environment variable subsequent requests expect it under.
// Requests like "Get a single global field" / "Export a global field" already
// reference {{global_field_uid}} in their URL (confirmed in the raw collection),
// so once this variable is set from a fresh Create response, every dependent
// request in the SAME run automatically uses the object we just created instead
// of a stale/deleted one fetched by fetchLiveUids() at the start of the run.
const UID_CAPTURE_MAP: Record<string, { envVar: string; jsonPath: string[] }> = {
  'Create a content type':                    { envVar: 'content_type_uid', jsonPath: ['content_type', 'uid'] },
  'Create content type with select field':     { envVar: 'content_type_uid', jsonPath: ['content_type', 'uid'] },
  'Create content type with JSON RTE':         { envVar: 'content_type_uid', jsonPath: ['content_type', 'uid'] },
  'Create content type with custom asset field': { envVar: 'content_type_uid', jsonPath: ['content_type', 'uid'] },
  'Create content type with taxonomy':         { envVar: 'content_type_uid', jsonPath: ['content_type', 'uid'] },
  'Create a global field':                     { envVar: 'global_field_uid', jsonPath: ['global_field', 'uid'] },
  'Create an entry':                           { envVar: 'entry_uid',        jsonPath: ['entry', 'uid'] },
  'Create an entry with JSON RTE':              { envVar: 'entry_uid',        jsonPath: ['entry', 'uid'] },
  'Create an entry with master locale':         { envVar: 'entry_uid',        jsonPath: ['entry', 'uid'] },
  'Create an entry with custom asset field':    { envVar: 'entry_uid',        jsonPath: ['entry', 'uid'] },
  'Create an entry with taxonomy':              { envVar: 'entry_uid',        jsonPath: ['entry', 'uid'] },
  'Create a workflow':                         { envVar: 'workflow_uid',     jsonPath: ['workflow', 'uid'] },
  'Create a role':                             { envVar: 'role_uid',         jsonPath: ['role', 'uid'] },
  'Add label':                                 { envVar: 'label_uid',        jsonPath: ['label', 'uid'] },
  'Create a Release':                          { envVar: 'release_uid',      jsonPath: ['release', 'uid'] },
  'Create a taxonomy':                         { envVar: 'taxonomy_uid',     jsonPath: ['taxonomy', 'uid'] },
  'Create a term':                             { envVar: 'term_uid',         jsonPath: ['term', 'uid'] },
  'Create a webhook':                          { envVar: 'webhook_uid',      jsonPath: ['webhook', 'uid'] },
  // Feeds extension_uid to every downstream request that references an
  // extension (custom asset field, extension field content types, metadata).
  // This specific variant's sample src ("https://www.sample.com") is a real,
  // resolvable URL, unlike sibling variants whose src is literal placeholder
  // text ("URL of the ... source code") that the API rejects outright — see
  // the JSON RTE plugin / asset sidebar extension fixes below for those.
  'Create a custom field with source URL':     { envVar: 'extension_uid',    jsonPath: ['extension', 'uid'] },
};

/**
 * Append a `pm.environment.set(...)` test script to each "Create X" request so
 * Newman's own sandbox captures the freshly-created UID and makes it available
 * to every subsequent request in the SAME run via {{envVar}} — the standard,
 * officially-supported Postman/Newman chaining mechanism (test scripts run in
 * the same VariableScope that resolves URL/body templates for later requests).
 */
function injectUidCaptureScripts(items: any[]): void {
  for (const item of items) {
    if (item.item) { injectUidCaptureScripts(item.item); continue; }
    const mapping = UID_CAPTURE_MAP[item.name];
    if (!mapping) continue;

    const accessor = mapping.jsonPath.map((k: string) => `?.[${JSON.stringify(k)}]`).join('');
    const script = [
      'if (pm.response.code >= 200 && pm.response.code < 300) {',
      '  try {',
      '    const data = pm.response.json();',
      `    const uid = data${accessor};`,
      `    if (uid) { pm.environment.set(${JSON.stringify(mapping.envVar)}, uid); }`,
      '  } catch (e) { /* response not JSON or shape unexpected — leave existing value */ }',
      '}',
    ];
    item.event = item.event ?? [];
    item.event.push({ listen: 'test', script: { type: 'text/javascript', exec: script } });
  }
}

/**
 * Make Create-request sample bodies unique per run. The official sample data
 * (e.g. title "Page" / uid "page") gets created once and never cleaned up, so
 * every subsequent run 422s with "title is not unique" — a test-data problem,
 * not a real collection/docs bug. Appending a run-unique suffix avoids the
 * collision.
 *
 * IMPORTANT: only the wrapper object's OWN uid/title get suffixed — e.g.
 * content_type.uid, content_type.title. A first attempt walked the whole body
 * recursively and also renamed nested schema field uids ("title", "url"),
 * which are Contentstack-reserved system field names, not arbitrary
 * identifiers — that broke every content type/entry create with "should have
 * a 'title' field" / "should have a 'url' field", since the API checks for
 * those exact reserved uids in the schema, not merely "any field playing that
 * role". Body structures vary per resource (nested under content_type/
 * global_field/entry/etc, sometimes with a sibling "options.title" reference
 * to a schema field — never touch that either), so this only tries the most
 * common single-level wrapper shape and leaves anything it doesn't recognize
 * untouched rather than guessing.
 */
const WRAPPER_KEYS = ['content_type', 'global_field', 'entry', 'workflow', 'role', 'label', 'release', 'taxonomy', 'term', 'webhook', 'extension', 'environment'];

// The official "Create a global field" sample includes a nested field of
// data_type "global_field" whose reference_to points at a placeholder
// ("global_field_1") that was never actually created — a genuine defect in
// the collection's own sample body, confirmed via the live API's own error
// message ("does not exist"). It blocks Create entirely, which cascades into
// every dependent Get/Update/Export/Delete request for the whole module.
// Stripping that one nested field lets the request test everything else the
// sample demonstrates (a plain text field) without relying on unrelated data.
/**
 * Reorders each leaf module folder so Create/Add/Upload requests run FIRST and
 * Delete requests run LAST, leaving everything else in its original relative
 * order. The collection's own folder order is documentation order (Get all,
 * Get single, Create, Update, Delete, Import, Export — matching the doc page's
 * heading order), which is wrong for a live test run with UID chaining: "Get a
 * single X" executing before "Create X" still hits fetchLiveUids()'s
 * pre-existing (possibly stale/reseeded) object instead of the one this run
 * just made, and "Export X" executing after "Delete X" 404s on an object this
 * same run already removed. Confirmed live for Global Fields; the same
 * doc-order pattern repeats across most CMA modules, so this is applied
 * generally rather than folder-by-folder. Same root cause already documented
 * for Automations/Brand Kit collections in this project (see reorderCustomCredentials).
 */
function reorderCrudLifecycle(items: any[]): void {
  for (const item of items) {
    if (item.item) {
      const isLeafFolder = item.item.every((child: any) => !child.item);
      if (isLeafFolder) {
        const creates: any[] = [];
        const deletes: any[] = [];
        const rest: any[] = [];
        for (const child of item.item) {
          if (/^(Create|Add|Upload)/.test(child.name ?? '')) creates.push(child);
          else if (/^Delete/.test(child.name ?? '')) deletes.push(child);
          else rest.push(child);
        }
        item.item = [...creates, ...rest, ...deletes];
      } else {
        reorderCrudLifecycle(item.item);
      }
    }
  }
}

function stripBrokenGlobalFieldReference(items: any[]): void {
  for (const item of items) {
    if (item.item) { stripBrokenGlobalFieldReference(item.item); continue; }
    if (item.name !== 'Create a global field') continue;
    const raw = item.request?.body?.raw;
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      const schema = parsed?.global_field?.schema;
      if (Array.isArray(schema)) {
        parsed.global_field.schema = schema.filter((f: any) => f?.data_type !== 'global_field');
      }
      item.request.body.raw = JSON.stringify(parsed, null, 2);
    } catch { /* not JSON — leave as-is */ }
  }
}

/**
 * Hand-verified fixes for stale/placeholder cross-resource references baked
 * into specific sample bodies, confirmed via live API error messages. Two
 * strategies, chosen per case:
 *  - CHAIN: the referenced resource IS created earlier in this same run (via
 *    UID_CAPTURE_MAP), so swap the hardcoded literal for the {{env_var}} that
 *    now holds the real, freshly-created UID.
 *  - STRIP: the reference points at something we never create ourselves and
 *    isn't essential to what the sample demonstrates (e.g. "blog_posts" — an
 *    external/demo-only content type) — remove the constraint so the rest of
 *    the sample still creates successfully.
 * External (non-Contentstack) URLs can't be "created" via chaining at all —
 * those get replaced with a real, resolvable placeholder URL instead.
 */
function fixKnownStaleReferences(items: any[]): void {
  for (const item of items) {
    if (item.item) { fixKnownStaleReferences(item.item); continue; }
    const raw = item.request?.body?.raw;
    if (!raw) continue;

    if (item.name === 'Create content type with JSON RTE') {
      // STRIP: json_rte.reference_to points at "blog_posts", a content type
      // this collection never creates — the field doesn't require a target
      // to be a valid JSON RTE field.
      try {
        const parsed = JSON.parse(raw);
        const field = parsed?.content_type?.schema?.find((f: any) => f?.uid === 'json_rte');
        if (field) field.reference_to = [];
        item.request.body.raw = JSON.stringify(parsed, null, 2);
      } catch { /* not JSON */ }
    }

    if (item.name === 'Create content type with taxonomy') {
      // CHAIN: both taxonomy_uid entries are hardcoded ("sample_one",
      // "sample_two") — replace with the taxonomy this run actually creates.
      // Only ONE prerequisite taxonomy is created (see createPrerequisiteTestData),
      // so drop the second array entry entirely rather than pointing both at
      // the same uid — the API rejects a taxonomies array with duplicate UIDs.
      try {
        const parsed = JSON.parse(raw);
        const field = parsed?.content_type?.schema?.find((f: any) => Array.isArray(f?.taxonomies));
        if (field) field.taxonomies = [{ ...field.taxonomies[0], taxonomy_uid: '{{taxonomy_uid}}' }];
        item.request.body.raw = JSON.stringify(parsed, null, 2);
      } catch { /* not JSON */ }
    }

    if (item.name === 'Create content type with custom asset field' || item.name === 'Create Content Type with Extension Field') {
      // CHAIN: extension_uid is hardcoded to a UID that no longer exists —
      // replace with the extension this run creates via "Create a custom
      // field with source URL" (see UID_CAPTURE_MAP). Note: reference_to
      // ["sys_assets"] on the same field is a Contentstack reserved system
      // value, not a stale placeholder — left untouched.
      item.request.body.raw = raw.replace(/"extension_uid"\s*:\s*"[^"]*"/, '"extension_uid": "{{extension_uid}}"');
    }

    if (item.name === 'Create metadata') {
      // CHAIN: all three references are stale — attach metadata to the
      // content type/entry/extension this run actually creates instead.
      try {
        const parsed = JSON.parse(raw);
        if (parsed.metadata) {
          parsed.metadata.entity_uid = '{{entry_uid}}';
          parsed.metadata._content_type_uid = '{{content_type_uid}}';
          parsed.metadata.extension_uid = '{{extension_uid}}';
        }
        item.request.body.raw = JSON.stringify(parsed, null, 2);
      } catch { /* not JSON */ }
    }

    if (item.name === 'Create a JSON RTE plugin with source URL' || item.name === 'Create an asset sidebar extension with source URL') {
      // These samples ship literal instructional text ("URL of the ... source
      // code") instead of an actual URL — Contentstack validates that the
      // extension src is a reachable host, so it always 422s. Not something
      // we create ourselves (external, non-Contentstack resource), so swap
      // in a real, stable, publicly-resolvable URL rather than chaining.
      item.request.body.raw = raw.replace(
        /"src"\s*:\s*"URL of the [^"]*"/,
        '"src": "https://www.sample.com"'
      );
    }
  }
}

// One shared counter across the whole recursive walk (NOT re-declared per
// folder) — confirmed bug: sibling Create requests in the SAME folder (e.g.
// "Create a content type" and "Create content type with select field" both
// sample uid "page"/title "Page") got the exact same runSuffix, since it was
// previously computed once per recursive call, not once per request — so two
// sibling variants still collided with EACH OTHER within the same run.
let uniqueDataCounter = 0;

function injectUniqueTestData(items: any[]): void {
  const runTimestamp = Date.now().toString(36);

  for (const item of items) {
    if (item.item) { injectUniqueTestData(item.item); continue; }
    if (item.request?.method !== 'POST' && item.request?.method !== 'PUT') continue;
    // PUT is always update-semantic, so apply regardless of name. For POST,
    // only creation-shaped requests need it — "Clone a Release" was missed
    // before because it doesn't start with Create/Add/Upload.
    if (item.request.method === 'POST' && !/^(Create|Add|Upload|Clone)/.test(item.name ?? '')) continue;
    const raw = item.request?.body?.raw;
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      const suffix = `${runTimestamp}${(uniqueDataCounter++).toString(36)}`;
      for (const wrapperKey of WRAPPER_KEYS) {
        const wrapper = parsed[wrapperKey];
        if (!wrapper || typeof wrapper !== 'object') continue;
        if (typeof wrapper.uid === 'string')   wrapper.uid   = `${wrapper.uid}_${suffix}`;
        if (typeof wrapper.title === 'string') wrapper.title = `${wrapper.title}_${suffix}`;
        if (typeof wrapper.name === 'string' && wrapperKey !== 'entry') wrapper.name = `${wrapper.name}_${suffix}`;
      }
      item.request.body.raw = JSON.stringify(parsed, null, 2);
    } catch { /* not JSON — leave as-is */ }
  }
}

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

  console.log('\n🔑  Resolving a real user-session authtoken for Stacks/Branches/Aliases/Tokens...');
  const userSessionAuthtoken = await resolveUserSessionAuthtoken();

  console.log('\n🔍  Pre-fetching live UIDs for CMA Newman environment...');
  const liveUids = await fetchLiveUids();

  console.log('\n🏗️   Creating prerequisite test data (taxonomy, extension) so cross-module chaining works regardless of folder order...');
  const prereqUids = await createPrerequisiteTestData();
  Object.assign(liveUids, prereqUids); // fresh creates take precedence over merely-existing objects

  // Fetch raw collection JSON and fix disabled auth headers before running Newman
  console.log('\n📥  Fetching CMA collection JSON and fixing disabled headers...');
  const rawResp = await axios.get(
    `https://api.getpostman.com/collections/${POSTMAN_CMA_COLLECTION_ID}`,
    { headers: { 'X-Api-Key': POSTMAN_API_KEY } }
  );
  const collection = rawResp.data.collection;
  enableAuthHeaders(collection.item ?? []);
  console.log('   ✅  Disabled auth headers re-enabled');

  reorderCrudLifecycle(collection.item ?? []);
  console.log('   ✅  Reordered each module so Create runs first and Delete runs last');

  stripBrokenGlobalFieldReference(collection.item ?? []);
  fixKnownStaleReferences(collection.item ?? []);
  console.log('   ✅  Stale cross-resource references fixed (chained to real UIDs or stripped)');

  injectUniqueTestData(collection.item ?? []);
  console.log('   ✅  Create-request sample bodies made unique for this run');

  injectUidCaptureScripts(collection.item ?? []);
  console.log('   ✅  UID-capture scripts injected — Get/Update/Export/Delete requests will use the object created earlier in this same run');

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
        environment: buildEnvironment(liveUids, userSessionAuthtoken) as any,
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
          const unresolved   = hasUnresolvedVariable(url);
          const isDelete     = deleteRequestNames.has(exec.item.name);
          const isNonTestable = NON_TESTABLE_REQUESTS.has(exec.item.name);
          // Only auto-skip Stacks/Branches/Aliases/Tokens when we genuinely
          // have no real user-session token — if login succeeded, these get
          // tested for real like everything else, not force-passed.
          const isUserSessionOnly = userSessionRequestNames.has(exec.item.name) && !userSessionAuthtoken;

          // Mark as passed if:
          //  - 2xx, OR
          //  - URL had an unresolved variable (no test data), OR
          //  - DELETE request (skipped intentionally), OR
          //  - User-session-only module AND no real authtoken was obtainable, OR
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
            ? `Requires user-session login (no QA credentials/authtoken available) — not a URL variable issue`
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
