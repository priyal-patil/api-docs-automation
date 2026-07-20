import * as fs from 'fs';
import * as path from 'path';
import nodemailer from 'nodemailer';
import dotenv from 'dotenv';
import { RunReport, TryOutTestResult, ComparisonResult, ApiTestResult, NewmanResult } from '../../../config/types';

dotenv.config();

const SLACK_CHANNEL_EMAIL = process.env.SLACK_CHANNEL_EMAIL ?? '';
const ALERT_FROM_EMAIL = process.env.ALERT_FROM_EMAIL ?? '';
const ALERT_EMAIL_PASSWORD = process.env.ALERT_EMAIL_PASSWORD ?? '';
const REPORTS_DIR = path.join(__dirname, '../../../reports');

// Each flag switches to that API's result files and labelled output.
// noLiveTryOut: true for APIs whose docs have no Try Out "Send" button
// (Analytics, Automations, Brand Kit, GenAI, Knowledge Vault) — CDA/CMA and
// Image Delivery have live Try Out execution.
// noPostman: true for APIs with no Postman collection at all (Image
// Delivery) — comparison there is Doc ↔ Try Out only, and there is no
// Newman phase/section to render.
const API_FLAGS: Array<{ flag: string; label: string; suffix: string; noLiveTryOut?: boolean; noPostman?: boolean }> = [
  { flag: '--cma',         label: 'CMA',         suffix: '-cma' },
  { flag: '--analytics',   label: 'Analytics',   suffix: '-analytics',   noLiveTryOut: true },
  { flag: '--automations', label: 'Automations', suffix: '-automations', noLiveTryOut: true },
  { flag: '--brandkit',    label: 'Brand Kit',   suffix: '-brandkit',    noLiveTryOut: true },
  { flag: '--genai',       label: 'Generative AI', suffix: '-genai',     noLiveTryOut: true },
  { flag: '--knowledgevault', label: 'Knowledge Vault', suffix: '-knowledgevault', noLiveTryOut: true },
  { flag: '--imagedelivery', label: 'Image Delivery', suffix: '-imagedelivery', noPostman: true },
];
const activeApi     = API_FLAGS.find(a => process.argv.includes(a.flag));
const API_LABEL     = activeApi?.label ?? 'CDA';
const SUFFIX        = activeApi?.suffix ?? '';
const NO_LIVE_TRYOUT = activeApi?.noLiveTryOut ?? false;
const NO_POSTMAN     = activeApi?.noPostman ?? false;

function loadJson<T>(filename: string, fallback: T): T {
  const p = path.join(REPORTS_DIR, filename);
  if (!fs.existsSync(p)) return fallback;
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return fallback; }
}

export async function generateReport(): Promise<void> {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });

  const tryOutResults: TryOutTestResult[]    = loadJson(`tryout-results${SUFFIX}.json`, []);
  const comparisonResults: ComparisonResult[] = loadJson(`comparison-results${SUFFIX}.json`, []);
  const apiTestResults: ApiTestResult[]       = loadJson(`api-test-results${SUFFIX}.json`, []);
  const newmanResults: NewmanResult[]         = loadJson(`newman-results${SUFFIX}.json`, []);

  const totalRequests = comparisonResults.length || tryOutResults.length || apiTestResults.length;
  const passed  = comparisonResults.filter(r => r.status === 'pass').length;
  const warnings = comparisonResults.filter(r => r.status === 'warning').length;
  // A single failing request commonly shows up in MULTIPLE result arrays —
  // e.g. a Newman failure also flips its comparisonResults status to 'fail'
  // (confirmed: for one CDA run, comparisonResults' 7 fails were a full
  // subset of newmanResults' 17). Naively summing arrays double/triple-counts
  // those. But newmanResults can ALSO contain failures with NO doc match at
  // all (confirmed: 10 "Queries" module failures never reached
  // comparisonResults because findByName had nothing to match), so simply
  // dropping one array undercounts instead. Dedupe by request name across
  // every source so each failing request is counted exactly once.
  const failedNames = new Set<string>();
  comparisonResults.filter(r => r.status === 'fail').forEach(r => failedNames.add(r.requestName));
  tryOutResults.filter(r => !r.passed).forEach(r => failedNames.add(r.requestName));
  apiTestResults.filter(r => !r.passed).forEach(r => failedNames.add(r.requestName));
  newmanResults.filter(r => !r.passed).forEach(r => failedNames.add(r.requestName));
  const failed = failedNames.size;

  const report: RunReport = {
    runAt: new Date().toISOString(),
    totalRequests,
    passed,
    warnings,
    failed,
    tryOutResults,
    comparisonResults,
    apiTestResults,
    newmanResults,
  };

  // ── Save JSON report ───────────────────────────────────────────────────────
  fs.writeFileSync(path.join(REPORTS_DIR, `run-report${SUFFIX}.json`), JSON.stringify(report, null, 2));

  // ── Generate HTML report ───────────────────────────────────────────────────
  const html = buildHtmlReport(report);
  const htmlPath = path.join(REPORTS_DIR, `run-report${SUFFIX}.html`);
  fs.writeFileSync(htmlPath, html);
  console.log(`\n📊  HTML report → ${htmlPath}`);

  // ── Send Slack status message every run — pass or fail ─────────────────────
  writeGithubStepSummary(report);
  if (SLACK_CHANNEL_EMAIL && ALERT_FROM_EMAIL) {
    await sendSlackEmailReport(report);
  } else {
    console.warn('⚠️  SLACK_CHANNEL_EMAIL or ALERT_FROM_EMAIL not set — skipping Slack report');
  }
}

/**
 * Writes the report straight into the GitHub Actions run summary page (visible
 * without downloading the artifact) — a no-op outside GHA, since
 * GITHUB_STEP_SUMMARY is only set on Actions runners.
 */
function writeGithubStepSummary(report: RunReport): void {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;

  const statusEmoji = report.failed > 0 ? '🚨' : report.warnings > 0 ? '⚠️' : '✅';
  const lines = [
    `## ${statusEmoji} Contentstack ${API_LABEL} Doc Automation`,
    '',
    `Run at: ${new Date(report.runAt).toLocaleString()}`,
    '',
    `| Total | ✅ Pass | ⚠️ Warn | ❌ Fail |`,
    `|---|---|---|---|`,
    `| ${report.totalRequests} | ${report.passed} | ${report.warnings} | ${report.failed} |`,
    '',
  ];

  const failedComparisons = report.comparisonResults.filter(r => r.status === 'fail');
  if (failedComparisons.length > 0) {
    lines.push('### ❌ Failing requests', '');
    for (const r of failedComparisons.slice(0, 20)) {
      const top = r.mismatches.filter(m => m.severity === 'error').slice(0, 2).map(m => m.detail).join('; ');
      lines.push(`- **${r.requestName}** — ${top}`);
    }
    if (failedComparisons.length > 20) lines.push(`- … and ${failedComparisons.length - 20} more`);
    lines.push('');
  }

  lines.push(`Full HTML report is attached as a workflow artifact.`);

  fs.appendFileSync(summaryPath, lines.join('\n') + '\n');
  console.log('📝  Wrote report to GitHub Actions job summary');
}

async function sendSlackEmailReport(report: RunReport): Promise<void> {
  const failedTryOuts     = report.tryOutResults.filter(r => !r.passed);
  const failedComparisons = report.comparisonResults.filter(r => r.status === 'fail');
  const failedApiTests    = report.apiTestResults.filter(r => !r.passed);
  const failedNewman      = report.newmanResults.filter(r => !r.passed);

  const statusEmoji = report.failed > 0 ? '🚨' : report.warnings > 0 ? '⚠️' : '✅';
  const statusLine = report.failed > 0
    ? `${report.failed} failure(s) detected`
    : report.warnings > 0
    ? `passed with ${report.warnings} warning(s)`
    : 'all checks passed';

  // Plain text body (shows in Slack as a message)
  const lines: string[] = [
    `${statusEmoji} Contentstack ${API_LABEL} Doc Automation — ${statusLine}`,
    `Run at: ${new Date(report.runAt).toLocaleString()}`,
    `Total: ${report.totalRequests} requests | ✅ ${report.passed} pass | ⚠️ ${report.warnings} warn | ❌ ${report.failed} fail`,
    `Full report: reports/run-report${SUFFIX}.html`,
    '',
  ];

  if (failedTryOuts.length > 0) {
    lines.push('Try Out Failures:');
    for (const r of failedTryOuts.slice(0, 5)) {
      lines.push(`  • ${r.requestName} — ${r.flags.join(' | ')}`);
    }
    if (failedTryOuts.length > 5) lines.push(`  … and ${failedTryOuts.length - 5} more`);
    lines.push('');
  }

  if (failedComparisons.length > 0) {
    lines.push(NO_POSTMAN ? 'Doc ↔ Try Out Mismatches:' : 'Doc ↔ Postman Mismatches:');
    for (const r of failedComparisons.slice(0, 5)) {
      const top = r.mismatches.filter(m => m.severity === 'error').slice(0, 2);
      lines.push(`  • ${r.requestName}: ${top.map(m => m.detail).join(' | ')}`);
    }
    if (failedComparisons.length > 5) lines.push(`  … and ${failedComparisons.length - 5} more`);
    lines.push('');
  }

  if (failedNewman.length > 0) {
    lines.push('Postman (Newman) Failures:');
    for (const r of failedNewman.slice(0, 5)) {
      lines.push(`  • ${r.requestName} — ${r.method} returned ${r.responseCode}${r.error ? ` (${r.error})` : ''}`);
    }
    if (failedNewman.length > 5) lines.push(`  … and ${failedNewman.length - 5} more`);
    lines.push('');
  }

  if (failedApiTests.length > 0) {
    lines.push('API Test Failures:');
    for (const r of failedApiTests.slice(0, 5)) {
      lines.push(`  • ${r.requestName} — expected ${r.expectedStatusCode}, got ${r.statusCode}`);
    }
    if (failedApiTests.length > 5) lines.push(`  … and ${failedApiTests.length - 5} more`);
  }

  if (report.failed === 0 && report.warnings === 0) {
    lines.push('No issues found — all requests passed.');
  }

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: ALERT_FROM_EMAIL,
      pass: ALERT_EMAIL_PASSWORD,   // Gmail App Password (not your login password)
    },
  });

  try {
    await transporter.sendMail({
      from: ALERT_FROM_EMAIL,
      to: SLACK_CHANNEL_EMAIL,
      subject: `${statusEmoji} ${API_LABEL} Doc Automation: ${statusLine} — ${new Date(report.runAt).toLocaleDateString()}`,
      text: lines.join('\n'),
    });
    console.log('📣  Slack channel report sent via email');
  } catch (err) {
    console.error('❌  Failed to send email report:', (err as Error).message);
  }
}

function buildHtmlReport(report: RunReport): string {
  const statusColor = (s: string) =>
    s === 'pass' ? '#16a34a' : s === 'warning' ? '#d97706' : '#dc2626';

  const compRows = report.comparisonResults.map(r => `
    <tr>
      <td><a href="${r.docUrl}" target="_blank">${r.requestName}</a></td>
      <td><code>${r.method} ${r.endpoint}</code></td>
      <td style="color:${statusColor(r.status)};font-weight:700">${r.status.toUpperCase()}</td>
      <td>
        ${r.mismatches.map(m => `<div class="mismatch ${m.severity}">${m.detail}</div>`).join('') || '—'}
      </td>
    </tr>`).join('');

  const tryOutRows = report.tryOutResults.map(r => `
    <tr>
      <td><a href="${r.docUrl}" target="_blank">${r.requestName}</a></td>
      <td>${r.method}</td>
      <td>${r.defaultResponseCode ? `<span class="badge-err">${r.defaultResponseCode} (default)</span>` : '—'}</td>
      <td>${r.actualResponseCode ? `<span class="${r.passed ? 'badge-ok' : 'badge-err'}">${r.actualResponseCode}</span>` : '—'}</td>
      <td style="color:${r.passed ? '#16a34a' : '#dc2626'};font-weight:700">${r.passed ? '✅ PASS' : '❌ FAIL'}</td>
      <td>${r.flags.join('<br>') || '—'}</td>
    </tr>`).join('');

  const apiRows = report.apiTestResults.map(r => `
    <tr>
      <td>${r.requestName}</td>
      <td><code>${r.method} ${r.endpoint}</code></td>
      <td>${r.expectedStatusCode}</td>
      <td><span class="${r.passed ? 'badge-ok' : 'badge-err'}">${r.statusCode}</span></td>
      <td style="color:${r.passed ? '#16a34a' : '#dc2626'};font-weight:700">${r.passed ? '✅ PASS' : '❌ FAIL'}</td>
      <td>${r.durationMs}ms</td>
    </tr>`).join('');

  const newmanRows = report.newmanResults.map(r => `
    <tr>
      <td>${r.requestName}</td>
      <td>${r.method}</td>
      <td><span class="${r.passed ? 'badge-ok' : 'badge-err'}">${r.responseCode}</span></td>
      <td style="color:${r.passed ? '#16a34a' : '#dc2626'};font-weight:700">${r.passed ? '✅ PASS' : '❌ FAIL'}</td>
      <td><code style="font-size:10px">${(r.requestBodyKeys ?? []).join(', ') || '—'}</code></td>
      <td><code style="font-size:10px">${(r.responseBodyKeys ?? []).join(', ') || '—'}</code></td>
      <td style="font-size:11px;color:#dc2626">${r.error ?? ''}</td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html>
<head>
  <title>Contentstack ${API_LABEL} Doc Automation Report</title>
  <meta charset="utf-8"/>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 1200px; margin: 0 auto; padding: 24px; background: #f8fafc; color: #0f172a; }
    h1 { font-size: 22px; margin-bottom: 4px; }
    .meta { font-size: 12px; color: #64748b; margin-bottom: 24px; }
    .summary { display: flex; gap: 16px; margin-bottom: 28px; }
    .card { background: white; border-radius: 10px; padding: 16px 20px; flex: 1; box-shadow: 0 1px 4px rgba(0,0,0,.08); text-align: center; }
    .card-num { font-size: 32px; font-weight: 800; }
    .card-label { font-size: 12px; color: #64748b; margin-top: 4px; }
    .green { color: #16a34a; } .yellow { color: #d97706; } .red { color: #dc2626; }
    h2 { font-size: 16px; margin: 28px 0 12px; border-bottom: 2px solid #e2e8f0; padding-bottom: 6px; }
    table { width: 100%; border-collapse: collapse; background: white; border-radius: 10px; overflow: hidden; box-shadow: 0 1px 4px rgba(0,0,0,.08); font-size: 12px; }
    th { background: #f1f5f9; padding: 10px 12px; text-align: left; font-weight: 700; color: #475569; }
    td { padding: 10px 12px; border-bottom: 1px solid #f1f5f9; vertical-align: top; }
    tr:last-child td { border-bottom: none; }
    a { color: #4f46e5; text-decoration: none; }
    code { background: #f1f5f9; border-radius: 4px; padding: 1px 5px; font-size: 11px; }
    .mismatch { padding: 3px 0; font-size: 11px; }
    .mismatch.error { color: #dc2626; }
    .mismatch.warning { color: #d97706; }
    .mismatch.info { color: #64748b; }
    .badge-ok { background: #dcfce7; color: #166534; border-radius: 4px; padding: 2px 6px; font-weight: 700; }
    .badge-err { background: #fee2e2; color: #991b1b; border-radius: 4px; padding: 2px 6px; font-weight: 700; }
  </style>
</head>
<body>
  <h1>Contentstack ${API_LABEL} API Doc Automation Report</h1>
  <div class="meta">Run at: ${new Date(report.runAt).toLocaleString()} · Total requests: ${report.totalRequests}</div>

  <div class="summary">
    <div class="card"><div class="card-num green">${report.passed}</div><div class="card-label">Passed</div></div>
    <div class="card"><div class="card-num yellow">${report.warnings}</div><div class="card-label">Warnings</div></div>
    <div class="card"><div class="card-num red">${report.failed}</div><div class="card-label">Failed</div></div>
  </div>

  <h2>Phase 2 — ${NO_LIVE_TRYOUT ? 'Doc-Declared Sample Response (no live Try Out "Send" button exists for this API)' : 'Try Out Panel Results'}</h2>
  <table>
    <thead><tr><th>Request</th><th>Method</th><th>Default Code</th><th>Actual Code</th><th>Status</th><th>Flags</th></tr></thead>
    <tbody>${tryOutRows || '<tr><td colspan="6">No Try Out results yet — run npm run tryout</td></tr>'}</tbody>
  </table>

  <h2>Phase 3 — Doc ↔ ${NO_POSTMAN ? 'Try Out' : NO_LIVE_TRYOUT ? '' : 'Try Out ↔ '}${NO_POSTMAN ? '' : 'Postman '}Comparison</h2>
  <table>
    <thead><tr><th>Request</th><th>Endpoint</th><th>Status</th><th>Mismatches</th></tr></thead>
    <tbody>${compRows || '<tr><td colspan="4">No comparison results yet — run npm run compare</td></tr>'}</tbody>
  </table>

  ${NO_POSTMAN ? '' : `
  <h2>Phase 3b — Newman (Postman Collection Execution)</h2>
  <table>
    <thead><tr><th>Request</th><th>Method</th><th>Response Code</th><th>Status</th><th>Request Body Keys</th><th>Response Body Keys</th><th>Error</th></tr></thead>
    <tbody>${newmanRows || '<tr><td colspan="7">No Newman results yet — run npm run newman</td></tr>'}</tbody>
  </table>`}

  <h2>Phase 4 — Direct API Test Results</h2>
  <table>
    <thead><tr><th>Request</th><th>Endpoint</th><th>Expected</th><th>Actual</th><th>Status</th><th>Duration</th></tr></thead>
    <tbody>${apiRows || '<tr><td colspan="6">No API test results yet — run npm run api-test</td></tr>'}</tbody>
  </table>
</body>
</html>`;
}

// Run directly
generateReport().catch(console.error);
