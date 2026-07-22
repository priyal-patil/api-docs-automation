import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import dotenv from 'dotenv';
import { NewmanResult } from '../../../config/types';
import { fetchPersonalizeEdgeOpenApiSpec } from './openApiSpec';

dotenv.config();

// Confirmed live: this API requires NO authentication at all (it's the
// public-facing edge API) — just x-project-uid (always) and
// x-cs-personalize-user-uid (required for Events, optional elsewhere —
// Get Manifest without one generates and returns a new user UID via a
// response header, which this runner then reuses for the rest of the lifecycle).
const PROJECT_UID = process.env.PERSONALIZE_PROJECT_UID ?? '';

const REGION_HOSTS: Record<string, string> = {
  us:        'personalize-edge.contentstack.com',
  eu:        'eu-personalize-edge.contentstack.com',
  au:        'au-personalize-edge.contentstack.com',
  'azure-na': 'azure-na-personalize-edge.contentstack.com',
  'azure-eu': 'azure-eu-personalize-edge.contentstack.com',
  'gcp-na':  'gcp-na-personalize-edge.contentstack.com',
  'gcp-eu':  'gcp-eu-personalize-edge.contentstack.com',
};
const BASE_HOST = REGION_HOSTS[process.env.CS_REGION ?? 'us'] ?? 'personalize-edge.contentstack.com';
const BASE = `https://${BASE_HOST}`;

function extractKeys(raw: string | undefined): string[] | undefined {
  if (!raw?.trim()) return undefined;
  try {
    const parsed = JSON.parse(raw.trim());
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return Object.keys(parsed);
  } catch { /* not JSON */ }
  return undefined;
}

async function callLive(
  results: NewmanResult[],
  requestName: string,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<{ data: any; responseHeaders: Record<string, string> }> {
  const requestBodyRaw = body !== undefined ? JSON.stringify(body) : undefined;
  try {
    const res = await axios.request({
      method,
      url,
      headers: body !== undefined ? { ...headers, 'Content-Type': 'application/json' } : headers,
      data: body,
      validateStatus: () => true,
      timeout: 15_000,
    });
    const responseBodyRaw = res.data !== undefined && res.data !== '' ? JSON.stringify(res.data) : undefined;
    const passed = res.status >= 200 && res.status < 300;
    results.push({
      requestName,
      method,
      url,
      requestBodyRaw: requestBodyRaw?.substring(0, 2000),
      requestBodyKeys: extractKeys(requestBodyRaw),
      responseCode: res.status,
      responseBodyRaw: responseBodyRaw?.substring(0, 2000),
      responseBodyKeys: extractKeys(responseBodyRaw),
      passed,
      error: passed ? undefined : (typeof res.data === 'object' ? JSON.stringify(res.data) : String(res.data)),
    });
    return { data: res.data, responseHeaders: res.headers as any };
  } catch (err) {
    results.push({
      requestName,
      method,
      url,
      requestBodyRaw: requestBodyRaw?.substring(0, 2000),
      requestBodyKeys: extractKeys(requestBodyRaw),
      responseCode: 0,
      passed: false,
      error: (err as Error).message,
    });
    return { data: undefined, responseHeaders: {} };
  }
}

export async function runSwaggerPersonalizeEdge(): Promise<NewmanResult[]> {
  if (!PROJECT_UID) throw new Error('PERSONALIZE_PROJECT_UID must be set in .env (shared with the Personalize Management automation)');

  console.log('\n📥  Fetching live Personalize Edge OpenAPI spec...');
  await fetchPersonalizeEdgeOpenApiSpec(BASE_HOST);

  const results: NewmanResult[] = [];

  console.log('\n🪪  Get Manifest without a user UID (bootstraps a new one)...');
  const manifestRes = await callLive(results, 'Get Manifest', 'GET', `${BASE}/manifest`, { 'x-project-uid': PROJECT_UID });
  const userUid = manifestRes.responseHeaders['x-cs-personalize-user-uid'];
  if (userUid) console.log(`   ✅  Got a real user UID from the response header: ${userUid}`);
  else console.warn('   ⚠️  No x-cs-personalize-user-uid returned in response headers — downstream calls will omit it where optional, or use a placeholder where required');

  const headersWithUser = { 'x-project-uid': PROJECT_UID, ...(userUid ? { 'x-cs-personalize-user-uid': userUid } : {}) };

  console.log('\n✏️   Set and Update User Attributes...');
  await callLive(results, 'Set and Update User Attributes', 'PATCH', `${BASE}/user-attributes`, headersWithUser, {
    automationAttr: `set-by-api-docs-automation-${Date.now()}`,
  });

  console.log('\n📊  Track Events...');
  await callLive(results, 'Track Events', 'POST', `${BASE}/events`,
    userUid ? headersWithUser : { ...headersWithUser, 'x-cs-personalize-user-uid': 'placeholder-user-uid' },
    [{ type: 'IMPRESSION', experienceShortUid: '0', variantShortUid: '1' }]);

  console.log('\n🔀  Merge User Attributes...');
  // Confirmed live: this endpoint takes source/target user UIDs in the body,
  // not as headers — merging a user into itself is a safe no-op for testing.
  await callLive(results, 'Merge User Attributes', 'POST', `${BASE}/user-attributes/actions/merge`, { 'x-project-uid': PROJECT_UID }, {
    sourceUserUid: userUid ?? 'placeholder-source-uid',
    targetUserUid: userUid ?? 'placeholder-target-uid',
  });

  const outPath = path.join(__dirname, '../../../reports/newman-results-personalizeedge.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));

  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  console.log(`\n✅  Swagger execution (Personalize Edge): ${passed} passed, ${failed} failed → ${outPath}`);

  return results;
}

runSwaggerPersonalizeEdge().catch(console.error);
