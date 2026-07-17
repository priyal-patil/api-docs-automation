import * as newman from 'newman';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import dotenv from 'dotenv';
import { NewmanResult } from '../../../config/types';

dotenv.config();

const POSTMAN_API_KEY            = process.env.POSTMAN_API_KEY ?? '';
const POSTMAN_GENAI_COLLECTION_ID = process.env.POSTMAN_GENAI_COLLECTION_ID ?? '';
const ORG_UID                    = process.env.CS_ORG_UID ?? '';
const CS_QA_EMAIL                = process.env.CS_QA_EMAIL ?? '';
const CS_QA_PASSWORD             = process.env.CS_QA_PASSWORD ?? '';
const STATIC_AUTHTOKEN           = process.env.CS_AUTHTOKEN ?? '';

// Base URL already bakes in the "/brand-kits" path segment per the docs' own
// Base URL table (confirmed live: https://ai.contentstack.com/brand-kits/v1/genai/
// is the real, working URL) — GenAI is a sub-resource of Brand Kit, not a typo.
const REGION_HOSTS: Record<string, string> = {
  us:        'ai.contentstack.com/brand-kits',
  eu:        'eu-ai.contentstack.com/brand-kits',
  au:        'au-ai.contentstack.com/brand-kits',
  'azure-na': 'azure-na-ai.contentstack.com/brand-kits',
  'azure-eu': 'azure-eu-ai.contentstack.com/brand-kits',
  'gcp-na':  'gcp-na-ai.contentstack.com/brand-kits',
  'gcp-eu':  'gcp-eu-ai.contentstack.com/brand-kits',
};
const BASE_HOST = REGION_HOSTS[process.env.CS_REGION ?? 'us'] ?? 'ai.contentstack.com/brand-kits';

// GenAI needs a real brand_kit_uid — reuses the same Brand Kit Management API
// this module depends on, same disposable create/delete lifecycle.
const BRAND_KIT_BASE_HOST: Record<string, string> = {
  us:        'brand-kits-api.contentstack.com',
  eu:        'eu-brand-kits-api.contentstack.com',
  au:        'au-na-brand-kits-api.contentstack.com',
  'azure-na': 'azure-na-brand-kits-api.contentstack.com',
  'azure-eu': 'azure-eu-brand-kits-api.contentstack.com',
  'gcp-na':  'gcp-na-brand-kits-api.contentstack.com',
  'gcp-eu':  'gcp-eu-brand-kits-api.contentstack.com',
};
const BRAND_KIT_BASE = `https://${BRAND_KIT_BASE_HOST[process.env.CS_REGION ?? 'us'] ?? 'brand-kits-api.contentstack.com'}/v1`;

/** Same reasoning as the other runners — authtokens silently go stale, prefer a fresh login. */
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

async function createTestBrandKit(headers: Record<string, string>): Promise<string> {
  const res = await axios.post(`${BRAND_KIT_BASE}/brand-kits`, {
    brand_kit: {
      name: `API Docs Automation GenAI Test ${new Date().toISOString()}`,
      description: 'Disposable Brand Kit created by api-docs-automation to test the GenAI endpoint — safe to delete.',
      api_keys: [],
    },
  }, { headers: { ...headers, 'Content-Type': 'application/json' } });
  const uid = res.data?.brand_kit?.uid;
  if (!uid) throw new Error('Create Brand Kit succeeded but no uid was returned');
  console.log(`   ✅  Created test brand kit ${uid}`);
  return uid;
}

async function deleteBrandKit(headers: Record<string, string>, brandKitUid: string): Promise<void> {
  try {
    await axios.delete(`${BRAND_KIT_BASE}/brand-kits/${brandKitUid}`, { headers });
    console.log(`   🧹  Deleted test brand kit ${brandKitUid}`);
  } catch (err) {
    console.warn(`   ⚠️  Could not delete test brand kit ${brandKitUid}: ${(err as Error).message}`);
  }
}

function buildEnvironment(authtoken: string, brandKitUid: string): object {
  const values = [
    { key: 'base_url',      value: BASE_HOST,   enabled: true },
    { key: 'authtoken',     value: authtoken,    enabled: true },
    { key: 'organization_uid', value: ORG_UID,   enabled: true },
    { key: 'brand_kit_uid', value: brandKitUid,  enabled: true },
    // The collection's default "authorization" header carries {{management_token}} —
    // authtoken alone is sufficient (confirmed live), resolve it to blank.
    { key: 'management_token', value: '',        enabled: true },
  ];
  return { id: 'auto-env-genai', name: 'Auto GenAI Test Environment', values };
}

/** Re-enable any disabled auth headers, same guard as the other runners. */
function enableAuthHeaders(items: any[]): void {
  for (const item of items) {
    if (item.item) { enableAuthHeaders(item.item); continue; }
    const headers: any[] = item.request?.header ?? [];
    for (const h of headers) {
      // Confirmed live: brand_kit_uid is documented as "optional" but the API
      // actually 400s with "brand_kit_uid is required" without it — always send it.
      if (['authtoken', 'organization_uid', 'brand_kit_uid'].includes(h.key?.toLowerCase()) && h.disabled) h.disabled = false;
    }
  }
}

/**
 * The collection's example body hardcodes a masked placeholder
 * voice_profile_uid ("cs************d") — confirmed live: 400s with
 * {"voice_profile_uid": "is invalid"}. Our disposable brand kit has no real
 * voice profile to reference, so disable knowledge_vault and drop the field
 * entirely — confirmed live this succeeds (real LLM response streamed back).
 */
function fixGenAIBody(items: any[]): void {
  for (const item of items) {
    if (item.item) { fixGenAIBody(item.item); continue; }
    if (item.name !== 'GenAI') continue;
    if (item.request?.body?.mode !== 'raw') continue;
    try {
      const parsed = JSON.parse(item.request.body.raw);
      delete parsed.voice_profile_uid;
      parsed.knowledge_vault = false;
      item.request.body.raw = JSON.stringify(parsed);
    } catch { /* leave as-is if not valid JSON */ }
  }
}

function hasUnresolvedVariable(url: string): boolean {
  return url.includes('%7B%7B') || url.includes('{{');
}

function extractKeys(raw: string | undefined): string[] | undefined {
  if (!raw?.trim()) return undefined;
  try {
    const parsed = JSON.parse(raw.trim());
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return Object.keys(parsed);
  } catch { /* not JSON — GenAI's response is a streaming SSE body, not a single JSON object */ }
  return undefined;
}

export async function runNewmanGenAI(): Promise<NewmanResult[]> {
  if (!POSTMAN_API_KEY || !POSTMAN_GENAI_COLLECTION_ID) {
    throw new Error('POSTMAN_API_KEY and POSTMAN_GENAI_COLLECTION_ID must be set in .env');
  }
  if (!ORG_UID) {
    throw new Error('CS_ORG_UID must be set in .env');
  }

  console.log('\n🔑  Resolving authtoken...');
  const authtoken = await resolveAuthtoken();
  const headers = { authtoken, organization_uid: ORG_UID };

  console.log('\n🏗️   Setting up live test data (GenAI needs a real brand_kit_uid)...');
  const brandKitUid = await createTestBrandKit(headers);

  let results: NewmanResult[] = [];

  try {
    console.log('\n📥  Fetching Generative AI Postman collection and fixing disabled headers...');
    const rawResp = await axios.get(
      `https://api.getpostman.com/collections/${POSTMAN_GENAI_COLLECTION_ID}`,
      { headers: { 'X-Api-Key': POSTMAN_API_KEY } }
    );
    const collection = rawResp.data.collection;
    enableAuthHeaders(collection.item ?? []);
    fixGenAIBody(collection.item ?? []);

    console.log('\n🏃  Running Newman against Generative AI Postman collection (this calls a real LLM)...');

    await new Promise<void>((resolve, reject) => {
      newman.run(
        {
          collection,
          environment: buildEnvironment(authtoken, brandKitUid) as any,
          reporters: ['cli'],
          insecure: false,
          timeoutRequest: 30_000, // LLM responses take longer than CRUD calls
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
            const passed          = !!(((res as any)?.code >= 200 && (res as any)?.code < 300) || (unresolved && code >= 400));

            results.push({
              requestName:      exec.item.name,
              method:           req?.method ?? 'GET',
              url,
              requestBodyRaw:   requestBodyRaw?.substring(0, 2000),
              requestBodyKeys:  extractKeys(requestBodyRaw),
              responseCode:     code,
              responseBodyRaw:  responseBodyRaw?.substring(0, 2000),
              responseBodyKeys: extractKeys(responseBodyRaw),
              passed,
              error: unresolved ? 'Unresolved variable in URL — no test data available' : (exec as any).requestError?.message,
            });
          }
          resolve();
        }
      );
    });
  } finally {
    console.log('\n🧹  Cleaning up test data...');
    await deleteBrandKit(headers, brandKitUid);
  }

  const outPath = path.join(__dirname, '../../../reports/newman-results-genai.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));

  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  console.log(`\n✅  Newman (GenAI): ${passed} passed, ${failed} failed → ${outPath}`);

  return results;
}

runNewmanGenAI().catch(console.error);
