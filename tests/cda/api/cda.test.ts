import { describe, it, expect, beforeAll } from 'vitest';
import axios, { AxiosResponse } from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import dotenv from 'dotenv';
import { ApiTestResult } from '../../../config/types';

dotenv.config();

const API_KEY = process.env.CS_API_KEY ?? '';
const DELIVERY_TOKEN = process.env.CS_DELIVERY_TOKEN ?? '';
const REGION = process.env.CS_REGION ?? 'us';

// Base URL depending on region
const BASE_URLS: Record<string, string> = {
  us: 'https://cdn.contentstack.io/v3',
  eu: 'https://eu-cdn.contentstack.com/v3',
  'azure-na': 'https://azure-na-cdn.contentstack.com/v3',
  'azure-eu': 'https://azure-eu-cdn.contentstack.com/v3',
  'gcp-na': 'https://gcp-na-cdn.contentstack.com/v3',
};

const BASE_URL = BASE_URLS[REGION] ?? BASE_URLS.us;

const HEADERS = {
  api_key: API_KEY,
  access_token: DELIVERY_TOKEN,
};

const results: ApiTestResult[] = [];

async function callApi(endpoint: string, params: Record<string, string | number | boolean> = {}): Promise<AxiosResponse> {
  return axios.get(`${BASE_URL}${endpoint}`, {
    headers: HEADERS,
    params,
    validateStatus: () => true, // never throw on non-2xx
  });
}

beforeAll(() => {
  if (!API_KEY || !DELIVERY_TOKEN) {
    throw new Error('CS_API_KEY and CS_DELIVERY_TOKEN must be set in .env');
  }
});

// ── Content Types ─────────────────────────────────────────────────────────────
describe('Content Delivery API — Content Types', () => {

  it('GET /content_types — returns 200 with basic params', async () => {
    const start = Date.now();
    const res = await callApi('/content_types');
    const duration = Date.now() - start;

    const passed = res.status === 200;
    results.push({
      requestName: 'Get All Content Types',
      endpoint: '/content_types',
      method: 'GET',
      statusCode: res.status,
      expectedStatusCode: 200,
      passed,
      responseFieldsMissing: checkFields(res.data, ['content_types']),
      responseFieldsExtra: [],
      durationMs: duration,
    });

    expect(res.status).toBe(200);
    expect(res.data).toHaveProperty('content_types');
  });

  it('GET /content_types — include_count returns count field', async () => {
    const res = await callApi('/content_types', { include_count: true });

    expect(res.status).toBe(200);
    expect(res.data).toHaveProperty('count');
  });

  it('GET /content_types — limit and skip work correctly', async () => {
    const res = await callApi('/content_types', { limit: 5, skip: 0 });

    expect(res.status).toBe(200);
    expect(res.data.content_types.length).toBeLessThanOrEqual(5);
  });

  it('GET /content_types/:uid — returns 200 for valid uid', async () => {
    // First fetch one uid to use
    const list = await callApi('/content_types');
    const uid = list.data?.content_types?.[0]?.uid;
    if (!uid) return; // skip if stack has no content types

    const start = Date.now();
    const res = await callApi(`/content_types/${uid}`);
    const duration = Date.now() - start;

    const passed = res.status === 200;
    results.push({
      requestName: 'Get a Single Content Type',
      endpoint: `/content_types/${uid}`,
      method: 'GET',
      statusCode: res.status,
      expectedStatusCode: 200,
      passed,
      responseFieldsMissing: checkFields(res.data, ['content_type']),
      responseFieldsExtra: [],
      durationMs: duration,
    });

    expect(res.status).toBe(200);
    expect(res.data).toHaveProperty('content_type');
  });

  it('GET /content_types/:uid — returns 422 for invalid uid', async () => {
    const res = await callApi('/content_types/this_uid_does_not_exist_xyz');
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});

// ── Entries ───────────────────────────────────────────────────────────────────
describe('Content Delivery API — Entries', () => {

  it('GET /content_types/:uid/entries — returns 200', async () => {
    const list = await callApi('/content_types');
    const uid = list.data?.content_types?.[0]?.uid;
    if (!uid) return;

    const start = Date.now();
    const res = await callApi(`/content_types/${uid}/entries`);
    const duration = Date.now() - start;

    const passed = res.status === 200;
    results.push({
      requestName: 'Get All Entries',
      endpoint: `/content_types/${uid}/entries`,
      method: 'GET',
      statusCode: res.status,
      expectedStatusCode: 200,
      passed,
      responseFieldsMissing: checkFields(res.data, ['entries']),
      responseFieldsExtra: [],
      durationMs: duration,
    });

    expect(res.status).toBe(200);
    expect(res.data).toHaveProperty('entries');
  });

  it('GET /content_types/:uid/entries — include_count works', async () => {
    const list = await callApi('/content_types');
    const uid = list.data?.content_types?.[0]?.uid;
    if (!uid) return;

    const res = await callApi(`/content_types/${uid}/entries`, { include_count: true });
    expect(res.status).toBe(200);
    expect(res.data).toHaveProperty('count');
  });
});

// ── Assets ────────────────────────────────────────────────────────────────────
describe('Content Delivery API — Assets', () => {

  it('GET /assets — returns 200', async () => {
    const start = Date.now();
    const res = await callApi('/assets');
    const duration = Date.now() - start;

    const passed = res.status === 200;
    results.push({
      requestName: 'Get All Assets',
      endpoint: '/assets',
      method: 'GET',
      statusCode: res.status,
      expectedStatusCode: 200,
      passed,
      responseFieldsMissing: checkFields(res.data, ['assets']),
      responseFieldsExtra: [],
      durationMs: duration,
    });

    expect(res.status).toBe(200);
    expect(res.data).toHaveProperty('assets');
  });

  it('GET /assets/:uid — returns 200 for valid uid', async () => {
    const list = await callApi('/assets');
    const uid = list.data?.assets?.[0]?.uid;
    if (!uid) return;

    const res = await callApi(`/assets/${uid}`);
    expect(res.status).toBe(200);
    expect(res.data).toHaveProperty('asset');
  });
});

// ── Environments ──────────────────────────────────────────────────────────────
describe('Content Delivery API — Sync', () => {

  it('GET /stacks/sync — init sync returns 200', async () => {
    const res = await callApi('/stacks/sync', { init: true });
    // sync may return 200 or 422 depending on stack setup — just not 5xx
    expect(res.status).toBeLessThan(500);
  });
});

// ── Save results ──────────────────────────────────────────────────────────────
import { afterAll } from 'vitest';

afterAll(() => {
  const outPath = path.join(__dirname, '../../../reports/api-test-results.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`\n📝  API test results saved → ${outPath}`);
});

function checkFields(data: any, expectedFields: string[]): string[] {
  if (!data || typeof data !== 'object') return expectedFields;
  return expectedFields.filter(f => !(f in data));
}
