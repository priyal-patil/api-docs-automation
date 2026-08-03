import * as fs from 'fs';
import * as path from 'path';
import dotenv from 'dotenv';
import { RunReport, TryOutTestResult, ComparisonResult, ApiTestResult, NewmanResult } from '../../../config/types';

dotenv.config();

const REPORTS_DIR = path.join(__dirname, '../../../reports');
const GITHUB_REPO = 'priyal-patil/api-docs-automation';

// Kept in sync with the API_FLAGS table in generateReport.ts (flag/label/suffix),
// plus the two dashboard-only fields (suiteLabel, docUrl) that generateReport.ts
// has no need for. generateReport.ts doesn't export its table, and the two
// extra fields aren't a natural fit to bolt onto it, so this is a small
// deliberate duplication rather than a shared import.
const API_FLAGS: Array<{ flag: string; suffix: string; suiteLabel: string; docUrl: string }> = [
  { flag: '--cma',             suffix: '-cma',             suiteLabel: 'Content Management API',        docUrl: 'https://www.contentstack.com/docs/developers/apis/content-management-api' },
  { flag: '--analytics',       suffix: '-analytics',       suiteLabel: 'Analytics API',                 docUrl: 'https://www.contentstack.com/docs/developers/apis/analytics-api' },
  { flag: '--automations',     suffix: '-automations',     suiteLabel: 'Automations Management API',    docUrl: 'https://www.contentstack.com/docs/developers/apis/automations-management-api' },
  { flag: '--brandkit',        suffix: '-brandkit',        suiteLabel: 'Brand Kit Management API',      docUrl: 'https://www.contentstack.com/docs/developers/apis/brand-kit-management-api' },
  { flag: '--genai',           suffix: '-genai',           suiteLabel: 'Generative AI API',             docUrl: 'https://www.contentstack.com/docs/developers/apis/generative-ai-api' },
  { flag: '--knowledgevault',  suffix: '-knowledgevault',  suiteLabel: 'Knowledge Vault API',            docUrl: 'https://www.contentstack.com/docs/developers/apis/knowledge-vault-api' },
  { flag: '--imagedelivery',   suffix: '-imagedelivery',   suiteLabel: 'Image Delivery API',             docUrl: 'https://www.contentstack.com/docs/developers/apis/image-delivery-api' },
  { flag: '--lytics',          suffix: '-lytics',          suiteLabel: 'Lytics CDP Management API',      docUrl: 'https://www.contentstack.com/docs/developers/apis/lytics-cdp-management-api' },
  { flag: '--personalize',     suffix: '-personalize',     suiteLabel: 'Personalize Management API',     docUrl: 'https://www.contentstack.com/docs/developers/apis/personalize-management-api' },
  { flag: '--personalizeedge', suffix: '-personalizeedge', suiteLabel: 'Personalize Edge API',           docUrl: 'https://www.contentstack.com/docs/developers/apis/personalize-edge-api' },
  { flag: '--launch',          suffix: '-launch',          suiteLabel: 'Launch API',                     docUrl: 'https://www.contentstack.com/docs/developers/apis/launch-api' },
  { flag: '--graphql',         suffix: '-graphql',         suiteLabel: 'GraphQL Content Delivery API',   docUrl: 'https://www.contentstack.com/docs/developers/apis/graphql-content-delivery-api' },
  { flag: '--administration',  suffix: '-administration',  suiteLabel: 'Administration API',             docUrl: 'https://www.contentstack.com/docs/developers/apis/administration-api' },
  { flag: '--scim',            suffix: '-scim',            suiteLabel: 'SCIM API',                       docUrl: 'https://www.contentstack.com/docs/developers/apis/scim-api' },
];

const activeApi = API_FLAGS.find(a => process.argv.includes(a.flag));

if (!activeApi) {
  console.error(`❌  publishToDashboard: no recognized --<api> flag in argv (${process.argv.slice(2).join(' ')})`);
  process.exit(1);
}

const SUFFIX      = activeApi.suffix;
const SUITE       = activeApi.flag.replace(/^--/, '');
const SUITE_LABEL = activeApi.suiteLabel;
const DOC_URL     = activeApi.docUrl;

function loadJson<T>(filename: string, fallback: T): T {
  const p = path.join(REPORTS_DIR, filename);
  if (!fs.existsSync(p)) return fallback;
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return fallback; }
}

interface DashboardFailedItem {
  name: string;
  detail: string | null;
  docLink: string | null;
}

interface DashboardReport {
  schemaVersion: 1;
  project: 'api-docs-automation';
  projectLabel: 'API Docs Automation';
  suite: string;
  suiteLabel: string;
  runId: string;
  runUrl: string;
  artifactsUrl: string;
  timestamp: string;
  durationSeconds: null;
  totals: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    warnings: number;
    timedOut: number;
    interrupted: number;
  };
  failedItems: DashboardFailedItem[];
  docLinks: string[];
}

/**
 * Prefer run-report-<api>.json if generateReport.ts already produced it this
 * run (it's the same RunReport shape, already assembled) — otherwise fall
 * back to reading the same raw result files generateReport.ts reads, so the
 * numbers here match what was emailed to Slack even if this script somehow
 * runs before/without generateReport.ts.
 */
function loadRunReport(): RunReport {
  const combined = loadJson<RunReport | null>(`run-report${SUFFIX}.json`, null);
  if (combined) return combined;

  const tryOutResults: TryOutTestResult[]     = loadJson(`tryout-results${SUFFIX}.json`, []);
  const comparisonResults: ComparisonResult[] = loadJson(`comparison-results${SUFFIX}.json`, []);
  const apiTestResults: ApiTestResult[]       = loadJson(`api-test-results${SUFFIX}.json`, []);
  const newmanResults: NewmanResult[]         = loadJson(`newman-results${SUFFIX}.json`, []);

  const totalRequests = comparisonResults.length || tryOutResults.length || apiTestResults.length;
  const passed   = comparisonResults.filter(r => r.status === 'pass').length;
  const warnings = comparisonResults.filter(r => r.status === 'warning').length;

  // Same dedup logic as generateReport.ts: a failing request commonly shows
  // up in multiple result arrays, so count each failing request name once.
  const failedNames = new Set<string>();
  comparisonResults.filter(r => r.status === 'fail').forEach(r => failedNames.add(r.requestName));
  tryOutResults.filter(r => !r.passed).forEach(r => failedNames.add(r.requestName));
  apiTestResults.filter(r => !r.passed).forEach(r => failedNames.add(r.requestName));
  newmanResults.filter(r => !r.passed).forEach(r => failedNames.add(r.requestName));

  return {
    runAt: new Date().toISOString(),
    totalRequests,
    passed,
    warnings,
    failed: failedNames.size,
    tryOutResults,
    comparisonResults,
    apiTestResults,
    newmanResults,
  };
}

/** Short human-readable reason a request failed, pulled from whichever result array has one. */
function detailFor(
  requestName: string,
  report: RunReport,
): string | null {
  const comparison = report.comparisonResults.find(r => r.requestName === requestName && r.status === 'fail');
  if (comparison) {
    const top = comparison.mismatches.filter(m => m.severity === 'error').slice(0, 2).map(m => m.detail);
    if (top.length > 0) return top.join('; ');
  }

  const newman = report.newmanResults.find(r => r.requestName === requestName && !r.passed);
  if (newman) {
    return `${newman.method} returned ${newman.responseCode}${newman.error ? ` (${newman.error})` : ''}`;
  }

  const apiTest = report.apiTestResults.find(r => r.requestName === requestName && !r.passed);
  if (apiTest) {
    return apiTest.errorMessage ?? `expected ${apiTest.expectedStatusCode}, got ${apiTest.statusCode}`;
  }

  const tryOut = report.tryOutResults.find(r => r.requestName === requestName && !r.passed);
  if (tryOut) {
    return tryOut.flags.join(' | ') || null;
  }

  return null;
}

function buildDashboardReport(report: RunReport): DashboardReport {
  const runId = process.env.GITHUB_RUN_ID ?? '';
  const runUrl = runId ? `https://github.com/${GITHUB_REPO}/actions/runs/${runId}` : '';
  const artifactsUrl = runId ? `${runUrl}#artifacts` : '';

  const failedNames = new Set<string>();
  report.comparisonResults.filter(r => r.status === 'fail').forEach(r => failedNames.add(r.requestName));
  report.tryOutResults.filter(r => !r.passed).forEach(r => failedNames.add(r.requestName));
  report.apiTestResults.filter(r => !r.passed).forEach(r => failedNames.add(r.requestName));
  report.newmanResults.filter(r => !r.passed).forEach(r => failedNames.add(r.requestName));

  const failedItems: DashboardFailedItem[] = Array.from(failedNames).map(name => ({
    name,
    detail: detailFor(name, report),
    docLink: null,
  }));

  return {
    schemaVersion: 1,
    project: 'api-docs-automation',
    projectLabel: 'API Docs Automation',
    suite: SUITE,
    suiteLabel: SUITE_LABEL,
    runId,
    runUrl,
    artifactsUrl,
    timestamp: new Date().toISOString(),
    durationSeconds: null,
    totals: {
      total: report.totalRequests,
      passed: report.passed,
      failed: report.failed,
      skipped: 0,
      warnings: report.warnings,
      timedOut: 0,
      interrupted: 0,
    },
    failedItems,
    docLinks: [DOC_URL],
  };
}

function main(): void {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const runReport = loadRunReport();
  const dashboardReport = buildDashboardReport(runReport);
  const outPath = path.join(REPORTS_DIR, `dashboard${SUFFIX}.json`);
  fs.writeFileSync(outPath, JSON.stringify(dashboardReport, null, 2));
  console.log(`📤  Dashboard report → ${outPath}`);
}

main();
