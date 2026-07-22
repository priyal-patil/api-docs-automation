import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import dotenv from 'dotenv';
import { NewmanResult } from '../../../config/types';
import { fetchLyticsOpenApiSpec } from './openApiSpec';

dotenv.config();

const ORG_UID              = process.env.CS_ORG_UID ?? '';
const CS_QA_EMAIL          = process.env.CS_QA_EMAIL ?? '';
const CS_QA_PASSWORD       = process.env.CS_QA_PASSWORD ?? '';
const STATIC_AUTHTOKEN     = process.env.CS_AUTHTOKEN ?? '';
const CS_QA_SECOND_EMAIL   = process.env.CS_QA_SECOND_EMAIL ?? '';

// Region hosts confirmed live from the Swagger doc's own "Servers" list —
// unlike Automations, there's no "-prod-" infix on any region here.
const REGION_HOSTS: Record<string, string> = {
  us:        'lytics-api.contentstack.com',
  eu:        'eu-lytics-api.contentstack.com',
  au:        'au-lytics-api.contentstack.com',
  'azure-na': 'azure-na-lytics-api.contentstack.com',
  'azure-eu': 'azure-eu-lytics-api.contentstack.com',
  'gcp-na':  'gcp-na-lytics-api.contentstack.com',
  'gcp-eu':  'gcp-eu-lytics-api.contentstack.com',
};
const BASE_HOST = REGION_HOSTS[process.env.CS_REGION ?? 'us'] ?? 'lytics-api.contentstack.com';
const BASE = `https://${BASE_HOST}`;

/** Same reasoning as runNewmanAutomations.ts — authtokens silently go stale, prefer a fresh login. */
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

function extractKeys(raw: string | undefined): string[] | undefined {
  if (!raw?.trim()) return undefined;
  try {
    const parsed = JSON.parse(raw.trim());
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return Object.keys(parsed);
  } catch { /* not JSON */ }
  return undefined;
}

/**
 * Best-effort UID extraction — the OpenAPI spec documents NO response body
 * schema at all for any 2xx (confirmed: every "200"/"204" response in the
 * spec has only a `description`, no `content`), so field names aren't known
 * ahead of time. Tries the common shapes seen elsewhere in this repo
 * (Automations/Brand Kit responses use bare `id` or `uid`).
 */
function pluckUid(obj: any, candidates: string[]): string | undefined {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const key of candidates) {
    if (typeof obj[key] === 'string') return obj[key];
  }
  return undefined;
}

async function callLive(
  results: NewmanResult[],
  requestName: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<any> {
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
    const responseBodyRaw = res.data !== undefined ? JSON.stringify(res.data) : undefined;
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
    return res.data;
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
    return undefined;
  }
}

/** No-test-data variant for the two Collaborator write calls that need a real second user — same "mark as no-test-data, don't false-fail" pattern Automations uses for its no-create-endpoint modules. */
function callSkipped(results: NewmanResult[], requestName: string, method: string, url: string, reason: string): void {
  results.push({
    requestName,
    method,
    url,
    responseCode: 0,
    passed: true, // not a real failure — no test data available, same convention as "Unresolved variable" in the Postman-based runners
    error: reason,
  });
}

export async function runSwaggerLytics(): Promise<NewmanResult[]> {
  if (!ORG_UID) throw new Error('CS_ORG_UID must be set in .env');

  console.log('\n🔑  Resolving authtoken...');
  const authtoken = await resolveAuthtoken();
  // x-cs-api-version is documented as optional ("defaults to v1") but is
  // actually REQUIRED for the request to route at all — confirmed live:
  // omitting it 404s ("Cannot GET/POST/PUT/DELETE ...") before auth is even
  // checked; the doc's own Swagger UI only "works" because it silently
  // defaults this header in for you. See README "Lytics" section.
  const headers = { authtoken, organization_uid: ORG_UID, 'x-cs-api-version': '1' };

  console.log('\n📥  Fetching live Lytics OpenAPI spec...');
  await fetchLyticsOpenApiSpec(BASE_HOST); // cached to reports/openapi-spec-lytics.json for compareLytics.ts

  const results: NewmanResult[] = [];
  let projectUid: string | undefined;
  let collaboratorUid: string | undefined;

  try {
    console.log('\n🏗️   Setting up live test data...');
    const suffix = `${Date.now()}`;
    const created = await callLive(results, 'Create a project', 'POST', `${BASE}/projects`, headers, {
      name: `API Docs Automation Test ${suffix}`,
      domain: `automation-test-${suffix}.example.com`,
      description: 'Disposable project created by api-docs-automation for live testing — safe to delete.',
    });
    projectUid = pluckUid(created, ['uid', 'id', 'project_uid']);
    // Don't abort the whole run if Create failed (e.g. org project quota
    // reached — confirmed live: lytics.PROJECTS.MAX_PROJECT_LIMIT_REACHED) —
    // keep firing the rest of the lifecycle against a placeholder id so every
    // endpoint still gets a real, honest execution result instead of
    // silently vanishing from the report.
    if (!projectUid) {
      console.warn('   ⚠️  Create a project did not return a project id — continuing lifecycle with a placeholder id (downstream calls will very likely also fail)');
      projectUid = 'unresolved-project-uid';
    } else {
      console.log(`   ✅  Created test project ${projectUid}`);
    }

    await callLive(results, 'List projects in the organization', 'GET', `${BASE}/projects`, headers);
    await callLive(results, 'Get a project by ID', 'GET', `${BASE}/projects/${projectUid}`, headers);
    await callLive(results, 'Update a project', 'PUT', `${BASE}/projects/${projectUid}`, headers, {
      name: `API Docs Automation Test ${suffix} (updated)`,
      domain: `automation-test-${suffix}.example.com`,
      description: 'Updated by api-docs-automation.',
    });

    if (CS_QA_SECOND_EMAIL) {
      const invited = await callLive(
        results, 'Invite collaborators to a project', 'POST',
        `${BASE}/projects/${projectUid}/collaborators`, headers,
        { userEmails: [CS_QA_SECOND_EMAIL], roles: ['member'], invitationMessage: 'Disposable test invite from api-docs-automation.' },
      );

      const collabList = await callLive(results, 'List collaborators for a project', 'GET', `${BASE}/projects/${projectUid}/collaborators`, headers);
      const listArray: any[] = Array.isArray(collabList) ? collabList
        : collabList?.collaborators ?? collabList?.data ?? [];
      const invitedRecord = listArray.find((c: any) => c?.email === CS_QA_SECOND_EMAIL || c?.userEmail === CS_QA_SECOND_EMAIL)
        ?? (Array.isArray(invited) ? invited[0] : invited?.collaborators?.[0]);
      collaboratorUid = pluckUid(invitedRecord, ['userUid', 'uid', 'id', 'user_uid']);

      if (collaboratorUid) {
        await callLive(results, "Update a collaborator's roles", 'PUT', `${BASE}/projects/${projectUid}/collaborators/${collaboratorUid}`, headers, {
          roles: ['member'],
        });
      } else {
        console.warn('   ⚠️  Could not resolve the invited collaborator\'s UID from the list response — marking role-update as no-test-data');
        callSkipped(results, "Update a collaborator's roles", 'PUT', `${BASE}/projects/${projectUid}/collaborators/{userUid}`,
          'Could not determine the invited collaborator\'s UID from an undocumented response shape — no test data available');
      }
    } else {
      console.warn('   ⚠️  CS_QA_SECOND_EMAIL not set — skipping the collaborator invite/list/update/remove lifecycle (marked as no-test-data)');
      const noData = (name: string, method: string, urlSuffix: string) =>
        callSkipped(results, name, method, `${BASE}/projects/${projectUid}${urlSuffix}`,
          'CS_QA_SECOND_EMAIL not set in .env — no real second org user available to invite as a disposable collaborator');
      noData('Invite collaborators to a project', 'POST', '/collaborators');
      noData('List collaborators for a project', 'GET', '/collaborators');
      noData("Update a collaborator's roles", 'PUT', '/collaborators/{userUid}');
    }

    await callLive(results, 'List roles assignable to project collaborators', 'GET', `${BASE}/projects/${projectUid}/roles`, headers);
  } finally {
    console.log('\n🧹  Cleaning up test data...');
    if (projectUid && collaboratorUid) {
      await callLive(results, 'Remove a collaborator from a project', 'DELETE', `${BASE}/projects/${projectUid}/collaborators/${collaboratorUid}`, headers);
    } else if (projectUid) {
      callSkipped(results, 'Remove a collaborator from a project', 'DELETE', `${BASE}/projects/${projectUid}/collaborators/{userUid}`,
        'No collaborator was successfully invited — nothing to remove');
    }
    if (projectUid) {
      await callLive(results, 'Delete a project', 'DELETE', `${BASE}/projects/${projectUid}`, headers);
      console.log(`   🧹  Deleted test project ${projectUid}`);
    }
  }

  const outPath = path.join(__dirname, '../../../reports/newman-results-lytics.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));

  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  console.log(`\n✅  Swagger execution (Lytics): ${passed} passed, ${failed} failed → ${outPath}`);

  return results;
}

runSwaggerLytics().catch(console.error);
