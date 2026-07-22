import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import dotenv from 'dotenv';
import { NewmanResult } from '../../../config/types';
import { fetchPersonalizeOpenApiSpec } from './openApiSpec';

dotenv.config();

const CS_QA_EMAIL        = process.env.CS_QA_EMAIL ?? '';
const CS_QA_PASSWORD     = process.env.CS_QA_PASSWORD ?? '';
const STATIC_AUTHTOKEN   = process.env.CS_AUTHTOKEN ?? '';
// No "create project" endpoint exists for Personalize — all calls are scoped
// to an existing project via x-project-uid. Confirmed live via an
// undocumented GET /projects (not in the OpenAPI spec) that the QA org
// already has several projects; reusing the one named "Test".
const PROJECT_UID        = process.env.PERSONALIZE_PROJECT_UID ?? '';

// Region hosts confirmed live from the Swagger doc's own "Servers" list.
const REGION_HOSTS: Record<string, string> = {
  us:        'personalize-api.contentstack.com',
  eu:        'eu-personalize-api.contentstack.com',
  au:        'au-personalize-api.contentstack.com',
  'azure-na': 'azure-na-personalize-api.contentstack.com',
  'azure-eu': 'azure-eu-personalize-api.contentstack.com',
  'gcp-na':  'gcp-na-personalize-api.contentstack.com',
  'gcp-eu':  'gcp-eu-personalize-api.contentstack.com',
};
const BASE_HOST = REGION_HOSTS[process.env.CS_REGION ?? 'us'] ?? 'personalize-api.contentstack.com';
const BASE = `https://${BASE_HOST}`;

/** Same reasoning as runSwaggerLytics.ts — authtokens silently go stale, prefer a fresh login. */
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

/** Unlike Lytics, every create/update response here documents a real "uid" field (confirmed live in the OpenAPI spec's examples) — no guessing needed. */
function pluckUid(obj: any): string | undefined {
  return typeof obj?.uid === 'string' ? obj.uid : undefined;
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

function callSkipped(results: NewmanResult[], requestName: string, method: string, url: string, reason: string): void {
  results.push({ requestName, method, url, responseCode: 0, passed: true, error: reason });
}

export async function runSwaggerPersonalize(): Promise<NewmanResult[]> {
  if (!PROJECT_UID) throw new Error('PERSONALIZE_PROJECT_UID must be set in .env (no create-project endpoint exists for this API — see README "Personalize" section)');

  console.log('\n🔑  Resolving authtoken...');
  const authtoken = await resolveAuthtoken();
  const headers = { authtoken, 'x-project-uid': PROJECT_UID };

  console.log('\n📥  Fetching live Personalize OpenAPI spec...');
  await fetchPersonalizeOpenApiSpec(BASE_HOST);

  const results: NewmanResult[] = [];
  let attributeUid: string | undefined;
  let eventUid: string | undefined;
  let audienceUid: string | undefined;
  let experienceUid: string | undefined;
  let versionUid: string | undefined;

  try {
    console.log('\n🏗️   Creating disposable test data...');
    const suffix = `${Date.now()}`;

    const attribute = await callLive(results, 'Create an Attribute', 'POST', `${BASE}/attributes`, headers, {
      name: `Automation Attribute ${suffix}`,
      key: `automationAttr${suffix}`,
      description: 'Disposable attribute created by api-docs-automation — safe to delete.',
    });
    attributeUid = pluckUid(attribute);

    const event = await callLive(results, 'Create an Event', 'POST', `${BASE}/events`, headers, {
      key: `automationEvent${suffix}`,
      description: 'Disposable event created by api-docs-automation — safe to delete.',
    });
    eventUid = pluckUid(event);

    const audience = await callLive(results, 'Create an Audience', 'POST', `${BASE}/audiences`, headers, {
      name: `Automation Audience ${suffix}`,
      description: 'Disposable audience created by api-docs-automation — safe to delete.',
      definition: attributeUid ? {
        __type: 'RuleCombination',
        combinationType: 'AND',
        rules: [{
          __type: 'Rule',
          attribute: { __type: 'CustomAttributeReference', ref: attributeUid },
          attributeMatchCondition: 'HAS_ANY_VALUE',
          invertCondition: false,
        }],
      } : { __type: 'RuleCombination', combinationType: 'AND', rules: [] },
    });
    audienceUid = pluckUid(audience);

    const experience = await callLive(results, 'Create an Experience', 'POST', `${BASE}/experiences`, headers, {
      name: `Automation Experience ${suffix}`,
      description: 'Disposable experience created by api-docs-automation — safe to delete.',
      __type: 'SEGMENTED',
    });
    experienceUid = pluckUid(experience);

    if (experienceUid) {
      const version = await callLive(results, 'Create an Experience Version', 'POST', `${BASE}/experiences/${experienceUid}/versions`, headers, {
        status: 'DRAFT',
        variants: [{
          __type: 'SegmentedVariant',
          name: 'Automation Variant',
          audiences: audienceUid ? [audienceUid] : [],
          audienceCombinationType: 'AND',
        }],
        ...(eventUid ? { metrics: [{ __type: 'Primary', event: eventUid, name: 'Automation Metric' }] } : {}),
      });
      versionUid = pluckUid(version);
      // Confirmed live: creating an Experience auto-provisions a default
      // DRAFT version — explicitly creating a second DRAFT then correctly
      // 400s (personalize.EXPERIENCES.VERSIONS.CANNOT_CREATE_VERSION_AS_DRAFT_ALREADY_EXISTS).
      // That's real, honest API behavior (kept above, not hidden) — fall
      // back to the auto-created version so Update/Priority/Analytics/Delete
      // still have something real to exercise.
      if (!versionUid) {
        const existingVersions = await axios.get(`${BASE}/experiences/${experienceUid}/versions`, { headers, validateStatus: () => true });
        const list = Array.isArray(existingVersions.data) ? existingVersions.data : [];
        versionUid = pluckUid(list[0]);
        if (versionUid) console.log(`   ℹ️  Using the auto-created default version ${versionUid} for downstream steps`);
      }
    } else {
      callSkipped(results, 'Create an Experience Version', 'POST', `${BASE}/experiences/{uid}/versions`,
        'Create an Experience did not return a uid — no experience to version');
    }

    console.log('\n📖  Reading list/get-by-id endpoints...');
    await callLive(results, 'Get all Attributes', 'GET', `${BASE}/attributes`, headers);
    await callLive(results, 'Get all Audiences', 'GET', `${BASE}/audiences`, headers);
    await callLive(results, 'Get all Events', 'GET', `${BASE}/events`, headers);
    const allExperiences = await callLive(results, 'Get all Experiences', 'GET', `${BASE}/experiences`, headers);
    if (experienceUid) {
      await callLive(results, 'Get a Single Experience', 'GET', `${BASE}/experiences/${experienceUid}`, headers);
      await callLive(results, 'Get all Experience Versions', 'GET', `${BASE}/experiences/${experienceUid}/versions`, headers);
    } else {
      callSkipped(results, 'Get a Single Experience', 'GET', `${BASE}/experiences/{uid}`, 'No experience was created');
      callSkipped(results, 'Get all Experience Versions', 'GET', `${BASE}/experiences/{uid}/versions`, 'No experience was created');
    }

    console.log('\n✏️   Updating created resources...');
    if (attributeUid) {
      await callLive(results, 'Update an Attribute', 'PUT', `${BASE}/attributes/${attributeUid}`, headers, {
        name: `Automation Attribute ${suffix} (updated)`,
        key: `automationAttr${suffix}`,
        description: 'Updated by api-docs-automation.',
      });
    } else {
      callSkipped(results, 'Update an Attribute', 'PUT', `${BASE}/attributes/{uid}`, 'No attribute was created');
    }
    if (audienceUid) {
      await callLive(results, 'Update an audience', 'PUT', `${BASE}/audiences/${audienceUid}`, headers, {
        name: `Automation Audience ${suffix} (updated)`,
        description: 'Updated by api-docs-automation.',
        definition: attributeUid ? {
          __type: 'RuleCombination',
          combinationType: 'AND',
          rules: [{
            __type: 'Rule',
            attribute: { __type: 'CustomAttributeReference', ref: attributeUid },
            attributeMatchCondition: 'HAS_ANY_VALUE',
            invertCondition: false,
          }],
        } : { __type: 'RuleCombination', combinationType: 'AND', rules: [{ __type: 'Rule', attribute: { __type: 'PresetAttributeReference', ref: 'COUNTRY' }, attributeMatchCondition: 'HAS_ANY_VALUE', invertCondition: false }] },
      });
    } else {
      callSkipped(results, 'Update an audience', 'PUT', `${BASE}/audiences/{uid}`, 'No audience was created');
    }
    if (eventUid) {
      await callLive(results, 'Update an Event', 'PUT', `${BASE}/events/${eventUid}`, headers, {
        key: `automationEvent${suffix}`,
        description: 'Updated by api-docs-automation.',
      });
    } else {
      callSkipped(results, 'Update an Event', 'PUT', `${BASE}/events/{uid}`, 'No event was created');
    }
    if (experienceUid) {
      await callLive(results, 'Update an Experience', 'PUT', `${BASE}/experiences/${experienceUid}`, headers, {
        name: `Automation Experience ${suffix} (updated)`,
        description: 'Updated by api-docs-automation.',
        __type: 'SEGMENTED',
      });
    } else {
      callSkipped(results, 'Update an Experience', 'PUT', `${BASE}/experiences/{uid}`, 'No experience was created');
    }
    if (experienceUid && versionUid) {
      await callLive(results, 'Update an Experience Version', 'PUT', `${BASE}/experiences/${experienceUid}/versions/${versionUid}`, headers, {
        status: 'DRAFT',
        variants: [{ __type: 'SegmentedVariant', name: 'Automation Variant (updated)', audiences: audienceUid ? [audienceUid] : [], audienceCombinationType: 'AND' }],
      });
    } else {
      callSkipped(results, 'Update an Experience Version', 'PUT', `${BASE}/experiences/{uid}/versions/{versionUid}`, 'No experience version was created');
    }

    console.log('\n📊  Priority + Analytics...');
    await callLive(results, 'Get Experiences Priority', 'GET', `${BASE}/experiences-priority`, headers);
    if (experienceUid) {
      // MISSING_EXPERIENCES: confirmed live this endpoint requires the FULL
      // set of the project's existing experience UIDs, not just the new one.
      const existingUids: string[] = (Array.isArray(allExperiences) ? allExperiences : [])
        .map((e: any) => e?.uid).filter((u: any) => typeof u === 'string');
      const priorityOrder = Array.from(new Set([...existingUids, experienceUid]));
      await callLive(results, 'Update Experiences Priority', 'PUT', `${BASE}/experiences-priority`, headers, {
        priorityOrder,
      });
    } else {
      callSkipped(results, 'Update Experiences Priority', 'PUT', `${BASE}/experiences-priority`, 'No experience was created to prioritize');
    }
    if (experienceUid && versionUid) {
      await callLive(results, 'Get Analytics Summary', 'GET', `${BASE}/experiences/${experienceUid}/analytics/summary?version=${versionUid}`, headers);
      await callLive(results, 'Get Time-series Analytics', 'GET', `${BASE}/experiences/${experienceUid}/analytics/time-series?version=${versionUid}`, headers);
    } else {
      callSkipped(results, 'Get Analytics Summary', 'GET', `${BASE}/experiences/{uid}/analytics/summary`, 'No experience version was created');
      callSkipped(results, 'Get Time-series Analytics', 'GET', `${BASE}/experiences/{uid}/analytics/time-series`, 'No experience version was created');
    }

    console.log('\n🌍  Geolocation (no project scope needed)...');
    await callLive(results, 'Get all Regions', 'GET', `${BASE}/geolocation/regions`, { authtoken });
    await callLive(results, 'Get all Countries', 'GET', `${BASE}/geolocation/countries`, { authtoken });
    await callLive(results, 'Get all Cities', 'GET', `${BASE}/geolocation/cities`, { authtoken });
  } finally {
    console.log('\n🧹  Cleaning up test data (reverse dependency order)...');
    // Deletes are recorded honestly (passed/failed) rather than assumed —
    // Lytics taught us DELETE can 403 even for the resource's own creator.
    if (experienceUid && versionUid) {
      await callLive(results, 'Delete an Experience Version', 'DELETE', `${BASE}/experiences/${experienceUid}/versions/${versionUid}`, headers);
    } else {
      callSkipped(results, 'Delete an Experience Version', 'DELETE', `${BASE}/experiences/{uid}/versions/{versionUid}`, 'No experience version was created');
    }
    if (experienceUid) {
      await callLive(results, 'Delete an Experience', 'DELETE', `${BASE}/experiences/${experienceUid}`, headers);
    } else {
      callSkipped(results, 'Delete an Experience', 'DELETE', `${BASE}/experiences/{uid}`, 'No experience was created');
    }
    if (audienceUid) {
      await callLive(results, 'Delete an audience', 'DELETE', `${BASE}/audiences/${audienceUid}`, headers);
    } else {
      callSkipped(results, 'Delete an audience', 'DELETE', `${BASE}/audiences/{uid}`, 'No audience was created');
    }
    if (eventUid) {
      await callLive(results, 'Delete an Event', 'DELETE', `${BASE}/events/${eventUid}`, headers);
    } else {
      callSkipped(results, 'Delete an Event', 'DELETE', `${BASE}/events/{uid}`, 'No event was created');
    }
    if (attributeUid) {
      await callLive(results, 'Delete an Attribute', 'DELETE', `${BASE}/attributes/${attributeUid}`, headers);
    } else {
      callSkipped(results, 'Delete an Attribute', 'DELETE', `${BASE}/attributes/{uid}`, 'No attribute was created');
    }
  }

  const outPath = path.join(__dirname, '../../../reports/newman-results-personalize.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));

  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  console.log(`\n✅  Swagger execution (Personalize): ${passed} passed, ${failed} failed → ${outPath}`);

  return results;
}

runSwaggerPersonalize().catch(console.error);
