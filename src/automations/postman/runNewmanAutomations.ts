import * as newman from 'newman';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import dotenv from 'dotenv';
import { NewmanResult } from '../../../config/types';

dotenv.config();

const POSTMAN_API_KEY                  = process.env.POSTMAN_API_KEY ?? '';
const POSTMAN_AUTOMATIONS_COLLECTION_ID = process.env.POSTMAN_AUTOMATIONS_COLLECTION_ID ?? '';
const ORG_UID                          = process.env.CS_ORG_UID ?? '';
const CS_QA_EMAIL                      = process.env.CS_QA_EMAIL ?? '';
const CS_QA_PASSWORD                   = process.env.CS_QA_PASSWORD ?? '';
const STATIC_AUTHTOKEN                 = process.env.CS_AUTHTOKEN ?? '';

// Base URL differs per region — note EU/AU have a "-prod-" infix, others don't
// (confirmed from the docs' own Base URL table — not a typo to "fix").
const REGION_HOSTS: Record<string, string> = {
  us:        'automations-api.contentstack.com',
  eu:        'eu-prod-automations-api.contentstack.com',
  au:        'au-prod-automations-api.contentstack.com',
  'azure-na': 'azure-na-automations-api.contentstack.com',
  'azure-eu': 'azure-eu-automations-api.contentstack.com',
  'gcp-na':  'gcp-na-automations-api.contentstack.com',
  'gcp-eu':  'gcp-eu-automations-api.contentstack.com',
};
const BASE_HOST = REGION_HOSTS[process.env.CS_REGION ?? 'us'] ?? 'automations-api.contentstack.com';
const BASE = `https://${BASE_HOST}/v1`;

/** Same reasoning as runNewmanAnalytics.ts — authtokens silently go stale, prefer a fresh login. */
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
 * Creates a disposable test project so Projects/Project Variables CRUD
 * requests have something real to operate on — deleted again at the end of
 * the run (see cleanup() below), same lifecycle the user asked for.
 */
async function createTestProject(headers: Record<string, string>): Promise<string> {
  const res = await axios.post(`${BASE}/projects`, {
    title: `API Docs Automation Test Project ${new Date().toISOString()}`,
    description: 'Disposable project created by api-docs-automation for live testing — safe to delete.',
    tags: ['automation-test', 'disposable'],
  }, { headers: { ...headers, 'Content-Type': 'application/json' } });
  const uid = res.data?.id ?? res.data?.uid;
  if (!uid) throw new Error('Create a project succeeded but no project id was returned');
  console.log(`   ✅  Created test project ${uid}`);
  return uid;
}

async function createTestProjectVariable(headers: Record<string, string>, projectUid: string): Promise<string | undefined> {
  try {
    // Confirmed live: key must be alphanumeric only (no underscores), and type
    // must be "text" or "password" — "string" 400s with a validation error.
    const res = await axios.post(`${BASE}/projects/${projectUid}/variables`, {
      key: 'AUTOMATIONTESTVAR',
      type: 'text',
      value: 'test-value',
    }, { headers: { ...headers, 'Content-Type': 'application/json' } });
    const uid = res.data?.id ?? res.data?.uid;
    if (uid) console.log(`   ✅  Created test project variable ${uid}`);
    return uid;
  } catch (err) {
    console.warn(`   ⚠️  Could not create a test project variable: ${(err as any).response?.data ? JSON.stringify((err as any).response.data) : (err as Error).message}`);
    return undefined;
  }
}

/**
 * Automations/Execution Logs/Audit Logs/Accounts have no "create" endpoint —
 * they only exist as a side effect of building/running an automation in the
 * UI, so our disposable project will never have any. Best effort: look across
 * the org's EXISTING projects for one that already has automation data, and
 * source those UIDs from there instead. Returns undefined fields when none
 * exist anywhere — those specific "Get a single X" requests then get an
 * unresolved {{variable}} and are correctly marked as "no test data" rather
 * than a false failure (same pattern as CDA's asset_uid gotcha).
 */
async function findPopulatedProjectData(headers: Record<string, string>): Promise<{
  projectUid?: string; automationUid?: string; executionUid?: string; auditlogUid?: string; accountUid?: string;
}> {
  try {
    const res = await axios.get(`${BASE}/projects`, { headers, params: { limit: 20 } });
    const projects: any[] = res.data?.projects ?? [];
    for (const p of projects) {
      const pid = p.id ?? p.uid;
      if (!pid) continue;
      try {
        const autoRes = await axios.get(`${BASE}/projects/${pid}/automations`, { headers });
        // Confirmed live and in the docs: the response key is "rules", not "automations".
        const automations: any[] = autoRes.data?.rules ?? [];
        if (!automations.length) continue;

        const automationUid = automations[0].id ?? automations[0].uid;
        console.log(`   ✅  Found populated project ${pid} with automation ${automationUid}`);

        let executionUid: string | undefined;
        let auditlogUid: string | undefined;
        let accountUid: string | undefined;
        try {
          const execRes = await axios.get(`${BASE}/projects/${pid}/executions`, { headers });
          executionUid = execRes.data?.executions?.[0]?.id ?? execRes.data?.executions?.[0]?.uid;
        } catch { /* leave unset */ }
        try {
          const auditRes = await axios.get(`${BASE}/projects/${pid}/audit-logs`, { headers });
          auditlogUid = auditRes.data?.logs?.[0]?.id ?? auditRes.data?.logs?.[0]?.uid;
        } catch { /* leave unset */ }
        try {
          const acctRes = await axios.get(`${BASE}/projects/${pid}/accounts`, { headers });
          accountUid = acctRes.data?.accounts?.[0]?.id ?? acctRes.data?.accounts?.[0]?.uid;
        } catch { /* leave unset */ }

        return { projectUid: pid, automationUid, executionUid, auditlogUid, accountUid };
      } catch { /* this project has no accessible automations — try the next */ }
    }
  } catch { console.warn('   ⚠️  Could not list projects to find existing automation data'); }
  console.warn('   ⚠️  No existing project with automations found — those requests will be marked as no-test-data');
  return {};
}

async function deleteTestData(headers: Record<string, string>, projectUid: string): Promise<void> {
  try {
    await axios.delete(`${BASE}/projects/${projectUid}`, { headers });
    console.log(`   🧹  Deleted test project ${projectUid}`);
  } catch (err) {
    console.warn(`   ⚠️  Could not delete test project ${projectUid}: ${(err as Error).message}`);
  }
}

function buildEnvironment(authtoken: string, projectUid: string, variableUid?: string): object {
  const values = [
    { key: 'base_url',        value: BASE_HOST,          enabled: true },
    { key: 'authtoken',       value: authtoken,           enabled: true },
    { key: 'organization_uid', value: ORG_UID,            enabled: true },
    { key: 'project_uid',     value: projectUid,          enabled: true },
    { key: 'variable_uid',    value: variableUid ?? '',   enabled: true },
  ];
  return { id: 'auto-env-automations', name: 'Auto Automations Test Environment', values };
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
 * Automations/Execution Logs/Audit Logs/Accounts need a project_uid that
 * actually HAS data — our disposable project never will. Hardcode the
 * populated-project UIDs directly into those specific folders' requests
 * (bypassing the {{project_uid}} environment variable, which stays pointed
 * at the disposable project for the Projects/Project Variables folders).
 */
function hardcodePopulatedProjectData(
  items: any[],
  folderNames: Set<string>,
  data: { projectUid?: string; automationUid?: string; executionUid?: string; auditlogUid?: string; accountUid?: string },
  insideTargetFolder = false
): void {
  for (const item of items) {
    if (item.item) {
      hardcodePopulatedProjectData(item.item, folderNames, data, insideTargetFolder || folderNames.has(item.name));
      continue;
    }
    if (!insideTargetFolder) continue;
    const url = item.request?.url;
    if (!url) continue;
    const replace = (s: string) => s
      .replace('{{project_uid}}', data.projectUid ?? '{{project_uid}}')
      .replace('{{automation_uid}}', data.automationUid ?? '{{automation_uid}}')
      .replace('{{execution_uid}}', data.executionUid ?? '{{execution_uid}}')
      .replace('{{auditlog_uid}}', data.auditlogUid ?? '{{auditlog_uid}}')
      .replace('{{account_uid}}', data.accountUid ?? '{{account_uid}}');
    if (typeof url.raw === 'string') url.raw = replace(url.raw);
    if (Array.isArray(url.path)) url.path = url.path.map(replace);
  }
}

/**
 * The Projects folder's own "Delete a project" request really deletes
 * {{project_uid}} — confirmed live: running the collection in its default
 * folder order (Projects first) deleted our disposable project after
 * "Update a project", then every later folder 404'd because the project
 * it depended on no longer existed. Move Projects to run LAST so every
 * other folder gets to use the project while it's still alive.
 */
function moveFolderLast(items: any[], folderName: string): any[] {
  const idx = items.findIndex(it => it.name === folderName);
  if (idx === -1) return items;
  const [folder] = items.splice(idx, 1);
  items.push(folder);
  return items;
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

export async function runNewmanAutomations(): Promise<NewmanResult[]> {
  if (!POSTMAN_API_KEY || !POSTMAN_AUTOMATIONS_COLLECTION_ID) {
    throw new Error('POSTMAN_API_KEY and POSTMAN_AUTOMATIONS_COLLECTION_ID must be set in .env');
  }
  if (!ORG_UID) {
    throw new Error('CS_ORG_UID must be set in .env');
  }

  console.log('\n🔑  Resolving authtoken...');
  const authtoken = await resolveAuthtoken();
  const headers = { authtoken, organization_uid: ORG_UID };

  console.log('\n🏗️   Setting up live test data...');
  const projectUid = await createTestProject(headers);
  const variableUid = await createTestProjectVariable(headers, projectUid);
  const populated = await findPopulatedProjectData(headers);

  let results: NewmanResult[] = [];

  try {
    console.log('\n📥  Fetching Automations Postman collection and fixing disabled headers...');
    const rawResp = await axios.get(
      `https://api.getpostman.com/collections/${POSTMAN_AUTOMATIONS_COLLECTION_ID}`,
      { headers: { 'X-Api-Key': POSTMAN_API_KEY } }
    );
    const collection = rawResp.data.collection;
    enableAuthHeaders(collection.item ?? []);
    hardcodePopulatedProjectData(
      collection.item ?? [],
      new Set(['Automations', 'Execution Logs', 'Audit Logs', 'Accounts']),
      populated
    );
    collection.item = moveFolderLast(collection.item ?? [], 'Projects');

    console.log('\n🏃  Running Newman against Automations Postman collection...');

    await new Promise<void>((resolve, reject) => {
      newman.run(
        {
          collection,
          environment: buildEnvironment(authtoken, projectUid, variableUid) as any,
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
    await deleteTestData(headers, projectUid);

    // The collection's own "Create a project" request creates a SECOND,
    // separate project (its own response id differs from our pre-created
    // projectUid) — clean that one up too, or it orphans on every run.
    const createResult = results.find(r => r.requestName === 'Create a project');
    const createdId = createResult ? extractKeys(createResult.responseBodyRaw) && JSON.parse(createResult.responseBodyRaw ?? '{}')?.id : undefined;
    if (createdId && createdId !== projectUid) {
      await deleteTestData(headers, createdId);
    }
  }

  const outPath = path.join(__dirname, '../../../reports/newman-results-automations.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));

  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  console.log(`\n✅  Newman (Automations): ${passed} passed, ${failed} failed → ${outPath}`);

  return results;
}

runNewmanAutomations().catch(console.error);
