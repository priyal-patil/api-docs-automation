import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const API_KEY          = process.env.CS_API_KEY ?? '';
const MANAGEMENT_TOKEN = process.env.CS_MANAGEMENT_TOKEN ?? '';
const MGMT_HEADERS     = { api_key: API_KEY, authorization: MANAGEMENT_TOKEN };
const CMA_BASE         = 'https://api.contentstack.io/v3';

export const LIVE_DATA_PATH = path.join(__dirname, '../reports/live-test-data.json');

/**
 * Fetch real, current UIDs from the QA stack via the Management API. The
 * stack gets reseeded independently of this project, so hardcoding UIDs
 * (as this file previously did) goes stale silently — every Try Out test
 * that depends on a stale UID fails with a 404/422 that looks like a real
 * doc/API bug but is actually just outdated test data.
 */
async function fetchLiveTestData(): Promise<Record<string, string>> {
  const data: Record<string, string> = {};

  // environment — used for both CDA (environment must have published content)
  // and CMA calls
  try {
    const res = await axios.get(`${CMA_BASE}/environments?limit=1`, { headers: MGMT_HEADERS });
    const env = res.data?.environments?.[0];
    if (env?.name) data.environment = env.name;
  } catch { /* leave unset — caller falls back to hardcoded default */ }

  // content_type_uid — prefer one that actually has entries, so CDA/entry-
  // dependent Try Out calls (which need published content) have something to find
  try {
    const res = await axios.get(`${CMA_BASE}/content_types?limit=20`, { headers: MGMT_HEADERS });
    const cts: any[] = res.data?.content_types ?? [];
    let chosen: string | undefined;
    for (const ct of cts) {
      try {
        const er = await axios.get(`${CMA_BASE}/content_types/${ct.uid}/entries?limit=1`, { headers: MGMT_HEADERS });
        if (er.data?.entries?.length) { chosen = ct.uid; break; }
      } catch { /* try next content type */ }
    }
    data.content_type_uid = chosen ?? cts[0]?.uid ?? '';
  } catch { /* leave unset */ }

  // entry_uid
  if (data.content_type_uid) {
    try {
      const res = await axios.get(`${CMA_BASE}/content_types/${data.content_type_uid}/entries?limit=1`, { headers: MGMT_HEADERS });
      const entry = res.data?.entries?.[0];
      if (entry?.uid) data.entry_uid = entry.uid;
    } catch { /* leave unset */ }
  }

  // asset_uid
  try {
    const res = await axios.get(`${CMA_BASE}/assets?limit=1`, { headers: MGMT_HEADERS });
    const asset = res.data?.assets?.[0];
    if (asset?.uid) data.asset_uid = asset.uid;
  } catch { /* leave unset */ }

  // global_field_uid
  try {
    const res = await axios.get(`${CMA_BASE}/global_fields?limit=1`, { headers: MGMT_HEADERS });
    const gf = res.data?.global_fields?.[0];
    if (gf?.uid) data.global_field_uid = gf.uid;
  } catch { /* leave unset */ }

  // taxonomy_uid + term_uid
  try {
    const res = await axios.get(`${CMA_BASE}/taxonomies?limit=1`, { headers: MGMT_HEADERS });
    const taxonomy = res.data?.taxonomies?.[0];
    if (taxonomy?.uid) {
      data.taxonomy_uid = taxonomy.uid;
      try {
        const termRes = await axios.get(`${CMA_BASE}/taxonomies/${taxonomy.uid}/terms?limit=1`, { headers: MGMT_HEADERS });
        const term = termRes.data?.terms?.[0];
        if (term?.uid) data.term_uid = term.uid;
      } catch { /* leave unset */ }
    }
  } catch { /* leave unset */ }

  return data;
}

export default async function globalSetup() {
  // Clear tryout results once before the entire test run — never re-runs on retries.
  // Each API's individual-results dir is cleared independently — otherwise
  // leftover files from renamed/removed requests in past runs silently
  // accumulate and get consolidated alongside current results.
  for (const dir of ['../reports/individual', '../reports/individual-imagedelivery']) {
    const resultsDir = path.join(__dirname, dir);
    fs.mkdirSync(resultsDir, { recursive: true });
    for (const file of fs.readdirSync(resultsDir)) {
      fs.unlinkSync(path.join(resultsDir, file));
    }
  }
  console.log('🧹  Cleared previous Try Out results (CDA + Image Delivery)');

  console.log('🔍  Fetching live test data from the QA stack (avoids stale hardcoded UIDs)...');
  const liveData = await fetchLiveTestData();
  fs.writeFileSync(LIVE_DATA_PATH, JSON.stringify(liveData, null, 2));
  for (const [key, value] of Object.entries(liveData)) {
    console.log(`   ✅  ${key} = ${value}`);
  }
  const missing = ['environment', 'content_type_uid', 'entry_uid', 'asset_uid', 'global_field_uid', 'taxonomy_uid', 'term_uid']
    .filter(k => !liveData[k]);
  if (missing.length) {
    console.warn(`   ⚠️  Could not fetch live values for: ${missing.join(', ')} — falling back to hardcoded defaults`);
  }
}
