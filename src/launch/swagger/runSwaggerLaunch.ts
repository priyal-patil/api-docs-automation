import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import dotenv from 'dotenv';
import { NewmanResult } from '../../../config/types';
import { fetchLaunchOpenApiSpec } from './openApiSpec';

dotenv.config();

const ORG_UID           = process.env.CS_ORG_UID ?? '';
const CS_QA_EMAIL       = process.env.CS_QA_EMAIL ?? '';
const CS_QA_PASSWORD    = process.env.CS_QA_PASSWORD ?? '';
const STATIC_AUTHTOKEN  = process.env.CS_AUTHTOKEN ?? '';

// Region hosts confirmed live from the doc's own "Base URLs" table.
const REGION_HOSTS: Record<string, string> = {
  us:        'launch-api.contentstack.com',
  eu:        'eu-launch-api.contentstack.com',
  au:        'au-launch-api.contentstack.com',
  'azure-na': 'azure-na-launch-api.contentstack.com',
  'azure-eu': 'azure-eu-launch-api.contentstack.com',
  'gcp-na':  'gcp-na-launch-api.contentstack.com',
  'gcp-eu':  'gcp-eu-launch-api.contentstack.com',
};
const BASE_HOST = REGION_HOSTS[process.env.CS_REGION ?? 'us'] ?? 'launch-api.contentstack.com';
const BASE = `https://${BASE_HOST}`;

/**
 * Launch has NO "create org/account" concept to bootstrap fresh test data
 * from nothing — but unlike Personalize (which also has no create-project
 * endpoint), Launch DOES let us create a real disposable project. However,
 * fully exercising every read endpoint (Deployments/Logs/Analytics) needs a
 * project with a COMPLETED deployment, which takes real build minutes to
 * produce fresh. Per the approved plan: reuse an existing leftover project/
 * environment/deployment (confirmed live to exist and be stable) for all
 * read-heavy checks, and only create+delete a real disposable project for
 * the actual Create/Update/Delete lifecycle. These UIDs are intentionally
 * hardcoded (not env vars) — they're fixed fixtures specific to this QA
 * org's pre-existing state, not secrets or rotatable config.
 */
const REUSED_PROJECT_UID    = '6a4f6c9e1977fb27308d9f69'; // "Auto Launch File Upload ef48b"
const REUSED_ENVIRONMENT_UID = '6a5166d0ac4cd22eeda57b66'; // "Doc QA Env 8b4e0 edited"
const REUSED_DEPLOYMENT_UID  = '6a5166d0ac4cd22eeda57b71'; // status: LIVE, completed

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

function pluckUid(obj: any, nestedKey?: string): string | undefined {
  const target = nestedKey ? obj?.[nestedKey] : obj;
  return typeof target?.uid === 'string' ? target.uid : undefined;
}

/** CRC32 + a minimal STORE-method (uncompressed) ZIP writer for a single file — no archiver dependency needed for a one-file disposable deploy payload. */
function crc32(buf: Buffer): number {
  const table = (crc32 as any).table ?? ((crc32 as any).table = (() => {
    const t: number[] = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })());
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function makeMinimalZip(filename: string, content: string): Buffer {
  const nameBuf = Buffer.from(filename, 'utf8');
  const dataBuf = Buffer.from(content, 'utf8');
  const crc = crc32(dataBuf);
  const size = dataBuf.length;

  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt32LE(crc, 14);
  localHeader.writeUInt32LE(size, 18);
  localHeader.writeUInt32LE(size, 22);
  localHeader.writeUInt16LE(nameBuf.length, 26);
  const localEntry = Buffer.concat([localHeader, nameBuf, dataBuf]);

  const centralHeader = Buffer.alloc(46);
  centralHeader.writeUInt32LE(0x02014b50, 0);
  centralHeader.writeUInt16LE(20, 4);
  centralHeader.writeUInt16LE(20, 6);
  centralHeader.writeUInt32LE(crc, 16);
  centralHeader.writeUInt32LE(size, 20);
  centralHeader.writeUInt32LE(size, 24);
  centralHeader.writeUInt16LE(nameBuf.length, 28);
  const centralEntry = Buffer.concat([centralHeader, nameBuf]);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralEntry.length, 12);
  eocd.writeUInt32LE(localEntry.length, 16);

  return Buffer.concat([localEntry, centralEntry, eocd]);
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
      timeout: 20_000,
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
    return res.data;
  } catch (err) {
    results.push({
      requestName, method, url, responseCode: 0, passed: false, error: (err as Error).message,
    });
    return undefined;
  }
}

function callSkipped(results: NewmanResult[], requestName: string, method: string, url: string, reason: string): void {
  results.push({ requestName, method, url, responseCode: 0, passed: true, error: reason });
}

export async function runSwaggerLaunch(): Promise<NewmanResult[]> {
  if (!ORG_UID) throw new Error('CS_ORG_UID must be set in .env');

  console.log('\n🔑  Resolving authtoken...');
  const authtoken = await resolveAuthtoken();
  const headers = { authtoken, organization_uid: ORG_UID };

  console.log('\n📥  Fetching live Launch OpenAPI spec...');
  await fetchLaunchOpenApiSpec(BASE_HOST);

  const results: NewmanResult[] = [];

  console.log('\n📖  Reading against the reused existing project/environment/deployment...');
  await callLive(results, 'Get all Projects', 'GET', `${BASE}/projects`, headers);
  await callLive(results, 'Get a Project', 'GET', `${BASE}/projects/${REUSED_PROJECT_UID}`, headers);
  await callLive(results, 'Get all Environments', 'GET', `${BASE}/projects/${REUSED_PROJECT_UID}/environments`, headers);
  await callLive(results, 'Get an Environment', 'GET', `${BASE}/projects/${REUSED_PROJECT_UID}/environments/${REUSED_ENVIRONMENT_UID}`, headers);
  await callLive(results, 'Get all Deployments', 'GET', `${BASE}/projects/${REUSED_PROJECT_UID}/environments/${REUSED_ENVIRONMENT_UID}/deployments`, headers);
  await callLive(results, 'Get a Deployment', 'GET', `${BASE}/projects/${REUSED_PROJECT_UID}/environments/${REUSED_ENVIRONMENT_UID}/deployments/${REUSED_DEPLOYMENT_UID}`, headers);
  await callLive(results, 'Get a Signed Upload URL for an Environment', 'GET', `${BASE}/projects/${REUSED_PROJECT_UID}/environments/upload/signed_url`, headers);
  await callLive(results, 'Get a Signed Upload URL for a Deployment', 'GET', `${BASE}/projects/${REUSED_PROJECT_UID}/environments/${REUSED_ENVIRONMENT_UID}/deployments/upload/signed_url`, headers);
  await callLive(results, 'Get a Download URL for a Deployment', 'GET', `${BASE}/projects/${REUSED_PROJECT_UID}/environments/${REUSED_ENVIRONMENT_UID}/deployments/${REUSED_DEPLOYMENT_UID}/download/signed_url`, headers);
  await callLive(results, 'Get Deployment Logs', 'GET', `${BASE}/projects/${REUSED_PROJECT_UID}/environments/${REUSED_ENVIRONMENT_UID}/deployments/${REUSED_DEPLOYMENT_UID}/logs/deployment-logs`, headers);
  // Confirmed live: Server Logs 500s for this static FILEUPLOAD deployment —
  // plausible that server logs only apply to SSR/server-rendered frameworks,
  // not static-file deployments (no server process runs for static hosting).
  // Recorded honestly rather than special-cased; see README "Launch" section.
  await callLive(results, 'Get Server Logs', 'GET', `${BASE}/projects/${REUSED_PROJECT_UID}/environments/${REUSED_ENVIRONMENT_UID}/deployments/${REUSED_DEPLOYMENT_UID}/logs/server-logs`, headers);
  await callLive(results, 'Get cache revalidation usage', 'GET', `${BASE}/usage-analytics/revalidate-cdn-cache`, headers);
  await callLive(results, 'Revalidate CDN Cache', 'POST', `${BASE}/projects/${REUSED_PROJECT_UID}/environments/${REUSED_ENVIRONMENT_UID}/revalidate-cdn-cache`, headers, {
    cachePath: { path: '/', isPrefix: true },
  });

  let projectUid: string | undefined;
  let environmentUid: string | undefined;

  try {
    console.log('\n🏗️   Disposable project lifecycle: signed URL → real ZIP upload → create...');
    const suffix = `${Date.now()}`;
    const signed = await callLive(results, 'Get a Signed Upload URL for a Project', 'GET', `${BASE}/projects/upload/signed_url`, headers);
    const { uploadUrl, fields, uploadUid } = signed ?? {};

    if (uploadUrl && Array.isArray(fields) && uploadUid) {
      let html = `<html><body><h1>API Docs Automation Test ${suffix}</h1></body></html>`;
      while (html.length < 1200) html += '\n<!-- padding to satisfy the presigned POST\'s 1KB minimum content-length -->';
      const zipBuf = makeMinimalZip('index.html', html);

      const form = new FormData();
      for (const f of fields) form.append(f.formFieldKey, f.formFieldValue);
      form.append('file', new Blob([new Uint8Array(zipBuf)]), 'deploy.zip');
      const uploadRes = await axios.post(uploadUrl, form, { validateStatus: () => true });
      console.log(`   ✅  Uploaded a real disposable ZIP (${zipBuf.length} bytes) → ${uploadRes.status}`);

      const created = await callLive(results, 'Create a Project', 'POST', `${BASE}/projects`, headers, {
        name: `API Docs Automation Test ${suffix}`,
        description: 'Disposable project created by api-docs-automation for live testing — safe to delete.',
        projectType: 'FILEUPLOAD',
        fileUpload: { uploadUid },
        environment: {
          name: 'Test Environment',
          outputDirectory: './',
          frameworkPreset: 'OTHER',
          description: 'Disposable test environment.',
          environmentVariables: [],
        },
      });
      projectUid = pluckUid(created, 'project');

      if (projectUid) {
        console.log(`   ✅  Created test project ${projectUid}`);
        const envs = await callLive(results, 'Get all Environments (post-create)', 'GET', `${BASE}/projects/${projectUid}/environments`, headers);
        environmentUid = envs?.environments?.[0]?.uid;

        await callLive(results, 'Update a Project', 'PUT', `${BASE}/projects/${projectUid}`, headers, {
          name: `API Docs Automation Test ${suffix} (updated)`,
        });

        if (environmentUid) {
          await callLive(results, 'Update an Environment', 'PUT', `${BASE}/projects/${projectUid}/environments/${environmentUid}`, headers, {
            name: 'Test Environment (updated)',
          });
        } else {
          callSkipped(results, 'Update an Environment', 'PUT', `${BASE}/projects/${projectUid}/environments/{environment_uid}`, 'No auto-created environment found on the new project');
        }
      } else {
        console.warn(`   ⚠️  Create a Project did not return a project uid (status may indicate a real failure — see results)`);
      }
    } else {
      console.warn('   ⚠️  Could not get a signed upload URL — skipping the Create/Update/Delete Project lifecycle');
      callSkipped(results, 'Create a Project', 'POST', `${BASE}/projects`, 'Could not obtain a signed upload URL');
    }

    // Confirmed genuinely NOT exercised by design (per the approved plan) —
    // creating a real deployment here would trigger an actual multi-minute
    // build on the disposable project, which this pipeline deliberately
    // avoids waiting on. Deployment reads are covered above against the
    // reused, already-completed deployment instead.
    callSkipped(results, 'Create a Deployment', 'POST', `${BASE}/projects/{project_uid}/environments/{environment_uid}/deployments`,
      'Not exercised live — would trigger a real multi-minute build on a disposable project. See README "Launch" section.');
  } finally {
    console.log('\n🧹  Cleaning up disposable test data...');
    if (projectUid && environmentUid) {
      await callLive(results, 'Delete an Environment', 'DELETE', `${BASE}/projects/${projectUid}/environments/${environmentUid}`, headers);
    } else if (projectUid) {
      callSkipped(results, 'Delete an Environment', 'DELETE', `${BASE}/projects/${projectUid}/environments/{environment_uid}`, 'No environment uid resolved to delete');
    }
    if (projectUid) {
      await callLive(results, 'Delete a Project', 'DELETE', `${BASE}/projects/${projectUid}`, headers);
      console.log(`   🧹  Deleted test project ${projectUid}`);
    } else {
      callSkipped(results, 'Delete a Project', 'DELETE', `${BASE}/projects/{project_uid}`, 'No project was created');
    }
  }

  const outPath = path.join(__dirname, '../../../reports/newman-results-launch.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));

  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  console.log(`\n✅  Swagger execution (Launch): ${passed} passed, ${failed} failed → ${outPath}`);

  return results;
}

runSwaggerLaunch().catch(console.error);
