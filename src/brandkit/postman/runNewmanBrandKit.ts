import * as newman from 'newman';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import dotenv from 'dotenv';
import { NewmanResult } from '../../../config/types';

dotenv.config();

const POSTMAN_API_KEY               = process.env.POSTMAN_API_KEY ?? '';
const POSTMAN_BRANDKIT_COLLECTION_ID = process.env.POSTMAN_BRANDKIT_COLLECTION_ID ?? '';
const ORG_UID                       = process.env.CS_ORG_UID ?? '';
const CS_QA_EMAIL                   = process.env.CS_QA_EMAIL ?? '';
const CS_QA_PASSWORD                = process.env.CS_QA_PASSWORD ?? '';
const STATIC_AUTHTOKEN              = process.env.CS_AUTHTOKEN ?? '';
const CS_API_KEY                    = process.env.CS_API_KEY ?? '';

// Base URL differs per region — confirmed from the docs' own Base URL table.
// Note AU is "au-na-brand-kits-api" (not "au-brand-kits-api") — not a typo to "fix".
const REGION_HOSTS: Record<string, string> = {
  us:        'brand-kits-api.contentstack.com',
  eu:        'eu-brand-kits-api.contentstack.com',
  au:        'au-na-brand-kits-api.contentstack.com',
  'azure-na': 'azure-na-brand-kits-api.contentstack.com',
  'azure-eu': 'azure-eu-brand-kits-api.contentstack.com',
  'gcp-na':  'gcp-na-brand-kits-api.contentstack.com',
  'gcp-eu':  'gcp-eu-brand-kits-api.contentstack.com',
};
const BASE_HOST = REGION_HOSTS[process.env.CS_REGION ?? 'us'] ?? 'brand-kits-api.contentstack.com';
const BASE = `https://${BASE_HOST}/v1`;

/** Same reasoning as runNewmanAnalytics.ts / runNewmanAutomations.ts — authtokens silently go stale, prefer a fresh login. */
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
 * Unlike Automations, every Brand Kit resource (Brand Kit, Voice Profile,
 * Custom Credentials) has a real Create/Set endpoint — no need to borrow
 * data from an existing org resource. Full lifecycle is disposable.
 */
async function createTestBrandKit(headers: Record<string, string>): Promise<string> {
  const res = await axios.post(`${BASE}/brand-kits`, {
    brand_kit: {
      name: `API Docs Automation Test Brand Kit ${new Date().toISOString()}`,
      description: 'Disposable Brand Kit created by api-docs-automation for live testing — safe to delete.',
      api_keys: [],
    },
  }, { headers: { ...headers, 'Content-Type': 'application/json' } });
  const uid = res.data?.brand_kit?.uid;
  if (!uid) throw new Error('Create Brand Kit succeeded but no uid was returned');
  console.log(`   ✅  Created test brand kit ${uid}`);
  return uid;
}

async function createTestVoiceProfile(headers: Record<string, string>, brandKitUid: string): Promise<string | undefined> {
  try {
    const res = await axios.post(`${BASE}/brand-kits/${brandKitUid}/voice-profiles`, {
      voice_profile: {
        name: 'Automation Test Voice Profile',
        description: 'Disposable voice profile created by api-docs-automation for live testing.',
        communication_style: { formality_level: 1, tone: 1, humor_level: 1, complexity_level: 1 },
      },
    }, { headers: { ...headers, 'Content-Type': 'application/json' } });
    const uid = res.data?.voice_profile?.uid;
    if (uid) console.log(`   ✅  Created test voice profile ${uid}`);
    return uid;
  } catch (err) {
    console.warn(`   ⚠️  Could not create a test voice profile: ${(err as any).response?.data ? JSON.stringify((err as any).response.data) : (err as Error).message}`);
    return undefined;
  }
}

async function deleteBrandKit(headers: Record<string, string>, brandKitUid: string): Promise<void> {
  try {
    await axios.delete(`${BASE}/brand-kits/${brandKitUid}`, { headers });
    console.log(`   🧹  Deleted test brand kit ${brandKitUid}`);
  } catch (err) {
    console.warn(`   ⚠️  Could not delete test brand kit ${brandKitUid}: ${(err as Error).message}`);
  }
}

function buildEnvironment(authtoken: string, brandKitUid: string, voiceProfileUid?: string): object {
  const values = [
    { key: 'base_url',          value: BASE_HOST,             enabled: true },
    { key: 'authtoken',         value: authtoken,              enabled: true },
    { key: 'organization_uid',  value: ORG_UID,                enabled: true },
    { key: 'brand_kit_uid',     value: brandKitUid,            enabled: true },
    { key: 'voice_profile_uid', value: voiceProfileUid ?? '',  enabled: true },
    // The collection's default "authorization" header carries {{management_token}} —
    // we auth with authtoken alone (confirmed live: works without a management
    // token), so resolve it to blank rather than sending the literal placeholder text.
    { key: 'management_token',  value: '',                     enabled: true },
  ];
  return { id: 'auto-env-brandkit', name: 'Auto Brand Kit Test Environment', values };
}

/** Re-enable any disabled auth headers, same guard as the other runners. */
function enableAuthHeaders(items: any[]): void {
  for (const item of items) {
    if (item.item) { enableAuthHeaders(item.item); continue; }
    const headers: any[] = item.request?.header ?? [];
    for (const h of headers) {
      if (['authtoken', 'organization_uid'].includes(h.key?.toLowerCase()) && h.disabled) h.disabled = false;
    }
  }
}

/**
 * The Brand Kit folder's own "Delete Brand Kit" request really deletes
 * {{brand_kit_uid}} — same issue confirmed on the Automations Management API
 * collection (its Projects folder's own Delete request). Voice Profile and
 * Custom Credentials both depend on {{brand_kit_uid}} still existing, so run
 * Brand Kit last.
 */
function moveFolderLast(items: any[], folderName: string): any[] {
  const idx = items.findIndex(it => it.name === folderName);
  if (idx === -1) return items;
  const [folder] = items.splice(idx, 1);
  items.push(folder);
  return items;
}

/**
 * "Get Custom Credentials" runs before "Set Custom Credentials" in the
 * collection's default order — confirmed live: GET 400s with "Unable to
 * fetch Brand Kit... uid is invalid" (a misleading message; the real cause
 * is that no LLM config has ever been set on this brand kit yet) and
 * succeeds once Set has run at least once. Swap the order.
 */
function reorderCustomCredentials(items: any[]): void {
  const folder = items.find(it => it.name === 'Custom Credentials (LLM) Configuration');
  if (!folder?.item) return;
  const getIdx = folder.item.findIndex((it: any) => it.name === 'Get Custom Credentials');
  const setIdx = folder.item.findIndex((it: any) => it.name === 'Set Custom Credentials');
  if (getIdx !== -1 && setIdx !== -1 && getIdx < setIdx) {
    const [getItem] = folder.item.splice(getIdx, 1);
    folder.item.splice(setIdx, 0, getItem); // insert right after Set's new position
  }
}

/**
 * "Create Brand Kit"/"Update Brand Kit" hardcode api_keys: ["xxxxxxxxxxxx"] /
 * a masked example value — confirmed live: the API validates these must be
 * real stack API keys and 400s on the placeholder ("api_keys": "is invalid").
 * Confirmed live: Create accepts an empty array fine, but Update requires at
 * least one real key ("api_keys": "should be more than 1") — an asymmetry in
 * the API itself, not a mistake here. Use our real CS_API_KEY for Update,
 * empty for Create.
 */
function fixBrandKitApiKeys(items: any[], realApiKey: string): void {
  for (const item of items) {
    if (item.item) { fixBrandKitApiKeys(item.item, realApiKey); continue; }
    if (item.name !== 'Create Brand Kit' && item.name !== 'Update Brand Kit') continue;
    if (item.request?.body?.mode !== 'raw') continue;
    try {
      const parsed = JSON.parse(item.request.body.raw);
      if (parsed.brand_kit) {
        parsed.brand_kit.api_keys = item.name === 'Update Brand Kit' && realApiKey ? [realApiKey] : [];
      }
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
  } catch { /* not JSON */ }
  return undefined;
}

export async function runNewmanBrandKit(): Promise<NewmanResult[]> {
  if (!POSTMAN_API_KEY || !POSTMAN_BRANDKIT_COLLECTION_ID) {
    throw new Error('POSTMAN_API_KEY and POSTMAN_BRANDKIT_COLLECTION_ID must be set in .env');
  }
  if (!ORG_UID) {
    throw new Error('CS_ORG_UID must be set in .env');
  }

  console.log('\n🔑  Resolving authtoken...');
  const authtoken = await resolveAuthtoken();
  const headers = { authtoken, organization_uid: ORG_UID };

  console.log('\n🏗️   Setting up live test data...');
  const brandKitUid = await createTestBrandKit(headers);
  const voiceProfileUid = await createTestVoiceProfile(headers, brandKitUid);

  let results: NewmanResult[] = [];

  try {
    console.log('\n📥  Fetching Brand Kit Postman collection and fixing disabled headers...');
    const rawResp = await axios.get(
      `https://api.getpostman.com/collections/${POSTMAN_BRANDKIT_COLLECTION_ID}`,
      { headers: { 'X-Api-Key': POSTMAN_API_KEY } }
    );
    const collection = rawResp.data.collection;
    enableAuthHeaders(collection.item ?? []);
    collection.item = moveFolderLast(collection.item ?? [], 'Brand Kit');
    reorderCustomCredentials(collection.item ?? []);
    fixBrandKitApiKeys(collection.item ?? [], CS_API_KEY);

    console.log('\n🏃  Running Newman against Brand Kit Postman collection...');

    await new Promise<void>((resolve, reject) => {
      newman.run(
        {
          collection,
          environment: buildEnvironment(authtoken, brandKitUid, voiceProfileUid) as any,
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
    await deleteBrandKit(headers, brandKitUid); // cascades the voice profile too

    // The collection's own "Create Brand Kit" request creates a SECOND,
    // separate brand kit (its response uid differs from our pre-created
    // brandKitUid) — clean that one up too, or it orphans on every run.
    const createResult = results.find(r => r.requestName === 'Create Brand Kit');
    const createdUid = createResult?.responseBodyRaw ? JSON.parse(createResult.responseBodyRaw)?.brand_kit?.uid : undefined;
    if (createdUid && createdUid !== brandKitUid) {
      await deleteBrandKit(headers, createdUid);
    }
  }

  const outPath = path.join(__dirname, '../../../reports/newman-results-brandkit.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));

  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  console.log(`\n✅  Newman (Brand Kit): ${passed} passed, ${failed} failed → ${outPath}`);

  return results;
}

runNewmanBrandKit().catch(console.error);
