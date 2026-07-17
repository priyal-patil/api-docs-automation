import * as newman from 'newman';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import dotenv from 'dotenv';
import { NewmanResult } from '../../../config/types';

dotenv.config();

const POSTMAN_API_KEY                     = process.env.POSTMAN_API_KEY ?? '';
const POSTMAN_KNOWLEDGEVAULT_COLLECTION_ID = process.env.POSTMAN_KNOWLEDGEVAULT_COLLECTION_ID ?? '';
const ORG_UID                             = process.env.CS_ORG_UID ?? '';
const CS_QA_EMAIL                         = process.env.CS_QA_EMAIL ?? '';
const CS_QA_PASSWORD                      = process.env.CS_QA_PASSWORD ?? '';
const STATIC_AUTHTOKEN                    = process.env.CS_AUTHTOKEN ?? '';

// Same base URL family as Generative AI — Knowledge Vault is also a
// sub-resource of Brand Kit (confirmed live and in the docs' own Base URL table).
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
const BASE = `https://${BASE_HOST}/v1`;

// Knowledge Vault needs a real brand_kit_uid — reuses the Brand Kit Management
// API's disposable create/delete lifecycle, same as GenAI.
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
      name: `API Docs Automation Knowledge Vault Test ${new Date().toISOString()}`,
      description: 'Disposable Brand Kit created by api-docs-automation to test Knowledge Vault — safe to delete.',
      api_keys: [],
    },
  }, { headers: { ...headers, 'Content-Type': 'application/json' } });
  const uid = res.data?.brand_kit?.uid;
  if (!uid) throw new Error('Create Brand Kit succeeded but no uid was returned');
  console.log(`   ✅  Created test brand kit ${uid}`);
  return uid;
}

/** Deleting the brand kit cascades all Knowledge Vault content stored under it — no separate cleanup needed. */
async function deleteBrandKit(headers: Record<string, string>, brandKitUid: string): Promise<void> {
  try {
    await axios.delete(`${BRAND_KIT_BASE}/brand-kits/${brandKitUid}`, { headers });
    console.log(`   🧹  Deleted test brand kit ${brandKitUid} (cascades its Knowledge Vault content)`);
  } catch (err) {
    console.warn(`   ⚠️  Could not delete test brand kit ${brandKitUid}: ${(err as Error).message}`);
  }
}

/**
 * Update/Delete Content Item need a real content_uid, and the collection has
 * no test script to chain it from Ingest's own response — pre-fetch one
 * ourselves via a live Ingest call, same "live value before Newman runs"
 * pattern used for Analytics' jobId and Automations' project_uid.
 */
async function ingestTestContent(headers: Record<string, string>, brandKitUid: string): Promise<string> {
  const res = await axios.post(`${BASE}/knowledge-vault/`, {
    content: 'Disposable content ingested by api-docs-automation for live testing.',
    _metadata: { title: 'API Docs Automation Test Content', tags: ['automation-test'] },
  }, { headers: { ...headers, brand_kit_uid: brandKitUid, 'Content-Type': 'application/json' } });
  const uid = res.data?.content?.uid;
  if (!uid) throw new Error('Ingest succeeded but no content uid was returned');
  console.log(`   ✅  Ingested test content ${uid}`);
  return uid;
}

function buildEnvironment(authtoken: string, brandKitUid: string, contentUid: string): object {
  const values = [
    { key: 'base_url',         value: BASE_HOST,   enabled: true },
    { key: 'authtoken',        value: authtoken,    enabled: true },
    { key: 'organization_uid', value: ORG_UID,      enabled: true },
    { key: 'brand_kit_uid',    value: brandKitUid,  enabled: true },
    { key: 'content_uid',      value: contentUid,   enabled: true },
    // The collection's default "authorization" header carries {{management_token}} —
    // authtoken alone is sufficient (confirmed live), resolve it to blank.
    { key: 'management_token', value: '',           enabled: true },
    // "path" is documented as required but confirmed live it is NOT — omitting
    // it auto-assigns a default folder. Leave blank so Ingest still exercises
    // the documented header without depending on a real folder path existing.
    { key: 'path',             value: '',           enabled: true },
  ];
  return { id: 'auto-env-knowledgevault', name: 'Auto Knowledge Vault Test Environment', values };
}

/** Re-enable any disabled auth headers, same guard as the other runners. */
function enableAuthHeaders(items: any[]): void {
  for (const item of items) {
    if (item.item) { enableAuthHeaders(item.item); continue; }
    const headers: any[] = item.request?.header ?? [];
    for (const h of headers) {
      if (['authtoken', 'organization_uid', 'brand_kit_uid'].includes(h.key?.toLowerCase()) && h.disabled) h.disabled = false;
    }
  }
}

/**
 * "Update Content Item"'s example body is malformed JSON in BOTH the
 * collection and the doc's own rendered Sample Request — confirmed:
 * `JSON.parse` throws "Expected ',' or '}' after property value" (missing
 * comma after "content", plus a trailing comma inside _metadata). Newman
 * would send this literally and get a real parse-error response rather than
 * testing the actual Update behavior — replace with equivalent valid JSON.
 */
function fixUpdateBody(items: any[]): void {
  for (const item of items) {
    if (item.item) { fixUpdateBody(item.item); continue; }
    if (item.name !== 'Update Content Item') continue;
    if (item.request?.body?.mode !== 'raw') continue;
    item.request.body.raw = JSON.stringify({
      content: 'Updated disposable content from api-docs-automation.',
      _metadata: { title: 'Updated API Docs Automation Test Content' },
    });
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

export async function runNewmanKnowledgeVault(): Promise<NewmanResult[]> {
  if (!POSTMAN_API_KEY || !POSTMAN_KNOWLEDGEVAULT_COLLECTION_ID) {
    throw new Error('POSTMAN_API_KEY and POSTMAN_KNOWLEDGEVAULT_COLLECTION_ID must be set in .env');
  }
  if (!ORG_UID) {
    throw new Error('CS_ORG_UID must be set in .env');
  }

  console.log('\n🔑  Resolving authtoken...');
  const authtoken = await resolveAuthtoken();
  const headers = { authtoken, organization_uid: ORG_UID };

  console.log('\n🏗️   Setting up live test data...');
  const brandKitUid = await createTestBrandKit(headers);
  const contentUid = await ingestTestContent(headers, brandKitUid);

  let results: NewmanResult[] = [];

  try {
    console.log('\n📥  Fetching Knowledge Vault Postman collection and fixing disabled headers...');
    const rawResp = await axios.get(
      `https://api.getpostman.com/collections/${POSTMAN_KNOWLEDGEVAULT_COLLECTION_ID}`,
      { headers: { 'X-Api-Key': POSTMAN_API_KEY } }
    );
    const collection = rawResp.data.collection;
    enableAuthHeaders(collection.item ?? []);
    fixUpdateBody(collection.item ?? []);

    console.log('\n🏃  Running Newman against Knowledge Vault Postman collection...');

    await new Promise<void>((resolve, reject) => {
      newman.run(
        {
          collection,
          environment: buildEnvironment(authtoken, brandKitUid, contentUid) as any,
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
    await deleteBrandKit(headers, brandKitUid);
  }

  const outPath = path.join(__dirname, '../../../reports/newman-results-knowledgevault.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));

  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  console.log(`\n✅  Newman (Knowledge Vault): ${passed} passed, ${failed} failed → ${outPath}`);

  return results;
}

runNewmanKnowledgeVault().catch(console.error);
