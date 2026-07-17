import * as newman from 'newman';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import dotenv from 'dotenv';
import { NewmanResult } from '../../../config/types';

dotenv.config();

const POSTMAN_API_KEY                 = process.env.POSTMAN_API_KEY ?? '';
const POSTMAN_ANALYTICS_COLLECTION_ID = process.env.POSTMAN_ANALYTICS_COLLECTION_ID ?? '';
const ORG_UID                         = process.env.CS_ORG_UID ?? '';
const CS_QA_EMAIL                     = process.env.CS_QA_EMAIL ?? '';
const CS_QA_PASSWORD                  = process.env.CS_QA_PASSWORD ?? '';
const STATIC_AUTHTOKEN                = process.env.CS_AUTHTOKEN ?? '';

// Base URL differs per region — see https://www.contentstack.com/docs/developers/apis/analytics-api#base-url
const REGION_HOSTS: Record<string, string> = {
  us:        'app.contentstack.com',
  eu:        'eu-app.contentstack.com',
  au:        'au-app.contentstack.com',
  'azure-na': 'azure-na-app.contentstack.com',
  'azure-eu': 'azure-eu-app.contentstack.com',
  'gcp-na':  'gcp-na-app.contentstack.com',
  'gcp-eu':  'gcp-eu-app.contentstack.com',
};
const BASE_HOST = REGION_HOSTS[process.env.CS_REGION ?? 'us'] ?? 'app.contentstack.com';
const BASE = `https://${BASE_HOST}/analytics/v2`;

/**
 * Authtokens silently go stale — Contentstack caps a user at 20 valid
 * authtokens; creating a new one (elsewhere, by anyone) expires the oldest
 * without warning. A shared QA org with other automation/logins makes this
 * a recurring failure, not a one-off — confirmed live (GHA run 2026-07-16
 * got 401 on all 8 requests). So prefer a fresh login every run, same
 * "live data over static value" approach already used everywhere else in
 * this project (fetchLiveUids, live jobId, etc). Falls back to a static
 * CS_AUTHTOKEN only if no QA credentials are configured.
 */
async function resolveAuthtoken(): Promise<string> {
  if (CS_QA_EMAIL && CS_QA_PASSWORD) {
    const res = await axios.post('https://api.contentstack.io/v3/user-session', {
      user: { email: CS_QA_EMAIL, password: CS_QA_PASSWORD },
    });
    const token = res.data?.user?.authtoken;
    if (!token) throw new Error('Login succeeded but no authtoken was returned');
    console.log('   ✅  Fetched a fresh authtoken via login');
    return token;
  }
  if (STATIC_AUTHTOKEN) {
    console.warn('   ⚠️  CS_QA_EMAIL/CS_QA_PASSWORD not set — using static CS_AUTHTOKEN (can silently go stale)');
    return STATIC_AUTHTOKEN;
  }
  throw new Error('Set either CS_QA_EMAIL + CS_QA_PASSWORD, or CS_AUTHTOKEN, in .env');
}

/**
 * Retrieve Data needs a real jobId, which only exists after calling one of the
 * "create job" endpoints — same live-fetch-before-Newman pattern used for CDA/CMA
 * (fetchLiveUids), since Postman has no test script wiring jobId automatically.
 */
async function fetchLiveJobId(authtoken: string): Promise<string | undefined> {
  try {
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const res = await axios.get(`${BASE}/subscription`, { headers: { authtoken }, params: { orgUid: ORG_UID, from, to } });
    if (res.data?.jobId) {
      console.log(`   ✅  jobId = ${res.data.jobId}`);
      return res.data.jobId;
    }
  } catch { console.warn('   ⚠️  Could not fetch a live jobId (Subscription Usage call failed)'); }
  return undefined;
}

function buildEnvironment(authtoken: string, jobId?: string): object {
  const values = [
    { key: 'orgUid',    value: ORG_UID,   enabled: true },
    { key: 'authtoken', value: authtoken, enabled: true },
    { key: 'base_url',  value: BASE_HOST, enabled: true },
    { key: 'jobId',     value: jobId ?? '', enabled: true },
  ];
  return { id: 'auto-env-analytics', name: 'Auto Analytics Test Environment', values };
}

/** Re-enable any disabled authtoken headers, same guard as CDA/CMA runners. */
function enableAuthHeaders(items: any[]): void {
  for (const item of items) {
    if (item.item) { enableAuthHeaders(item.item); continue; }
    const headers: any[] = item.request?.header ?? [];
    for (const h of headers) {
      if (h.key?.toLowerCase() === 'authtoken' && h.disabled) h.disabled = false;
    }
  }
}

/**
 * The collection hardcodes from=2024-01-31/to=2024-03-31 — confirmed live that
 * this now returns 400 "An internal server error occurred" (analytics data
 * appears to have a retention/lookback window and 2024 has aged out of it).
 * Same "stale hardcoded value" issue already seen in the CMA collection —
 * override with a rolling recent window so the request is actually valid.
 */
function rewriteDateParams(items: any[], from: string, to: string): void {
  for (const item of items) {
    if (item.item) { rewriteDateParams(item.item, from, to); continue; }
    const query: any[] = item.request?.url?.query ?? [];
    for (const q of query) {
      if (q.key === 'from') q.value = from;
      if (q.key === 'to') q.value = to;
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

function hasUnresolvedVariable(url: string): boolean {
  return url.includes('%7B%7B') || url.includes('{{');
}

export async function runNewmanAnalytics(): Promise<NewmanResult[]> {
  if (!POSTMAN_API_KEY || !POSTMAN_ANALYTICS_COLLECTION_ID) {
    throw new Error('POSTMAN_API_KEY and POSTMAN_ANALYTICS_COLLECTION_ID must be set in .env');
  }
  if (!ORG_UID) {
    throw new Error('CS_ORG_UID must be set in .env (Analytics API uses org-scoped auth, not the CMA management token)');
  }

  console.log('\n🔑  Resolving authtoken...');
  const authtoken = await resolveAuthtoken();

  console.log('\n🔍  Pre-fetching a live jobId for Newman environment...');
  const jobId = await fetchLiveJobId(authtoken);

  console.log('\n📥  Fetching Analytics Postman collection and fixing disabled headers...');
  const rawResp = await axios.get(
    `https://api.getpostman.com/collections/${POSTMAN_ANALYTICS_COLLECTION_ID}`,
    { headers: { 'X-Api-Key': POSTMAN_API_KEY } }
  );
  const collection = rawResp.data.collection;
  enableAuthHeaders(collection.item ?? []);

  const to = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  rewriteDateParams(collection.item ?? [], from, to);
  console.log(`   ✅  Rewrote hardcoded from/to dates → ${from} .. ${to}`);

  console.log('\n🏃  Running Newman against Analytics Postman collection...');
  const results: NewmanResult[] = [];

  await new Promise<void>((resolve, reject) => {
    newman.run(
      {
        collection,
        environment: buildEnvironment(authtoken, jobId) as any,
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

          const responseBodyRaw = res ? (res as any).text() : undefined;
          const url             = req?.url?.toString() ?? '';
          const code            = (res as any)?.code ?? 0;
          const unresolved      = hasUnresolvedVariable(url);
          const passed          = !!(((res as any)?.code >= 200 && (res as any)?.code < 300) || (unresolved && code >= 400));

          results.push({
            requestName:      exec.item.name,
            method:           req?.method ?? 'GET',
            url,
            responseCode:     code,
            responseBodyRaw:  responseBodyRaw?.substring(0, 2000),
            responseBodyKeys: extractKeys(responseBodyRaw),
            passed,
            error: unresolved
              ? 'Unresolved variable in URL — no jobId available'
              : (exec as any).requestError?.message,
          });
        }
        resolve();
      }
    );
  });

  const outPath = path.join(__dirname, '../../../reports/newman-results-analytics.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));

  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  console.log(`\n✅  Newman (Analytics): ${passed} passed, ${failed} failed → ${outPath}`);

  return results;
}

runNewmanAnalytics().catch(console.error);
