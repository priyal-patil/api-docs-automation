import * as fs from 'fs';
import * as path from 'path';
import { ComparisonResult, Mismatch, DocRequest, TryOutData } from '../../config/types';

/**
 * Two-way comparison for the Administration API:
 *   A = Doc description (scraped params/headers)
 *   B = Try Out panel (fields read statically — this doc page has no
 *       Send/Execute button, so there is no live execution or Postman/Newman
 *       leg here, unlike every other product line)
 *
 * Checks: param/header field gaps between the doc's own description and the
 * Try Out panel — same logic as compareCMA.ts's Doc ↔ Try Out section, with
 * every Postman-specific check removed since there is no collection to compare.
 */
// Universal auth/infra headers documented globally, not per endpoint (norm()-ed).
const GLOBAL_HEADERS = new Set([
  'authtoken', 'organizationuid', 'stackapikey', 'contenttype',
]);

export async function runComparisonAdministration(): Promise<ComparisonResult[]> {
  const scrapedPath = path.join(__dirname, '../../reports/scraped-requests-administration.json');
  if (!fs.existsSync(scrapedPath)) {
    throw new Error('scraped-requests-administration.json not found — run `npm run scrape:administration` first');
  }
  const scraped: Array<{ doc: DocRequest; tryOut: TryOutData }> = JSON.parse(
    fs.readFileSync(scrapedPath, 'utf-8')
  );

  const results: ComparisonResult[] = [];

  for (const { doc, tryOut } of scraped) {
    const mismatches: Mismatch[] = [];

    const docParamNames     = new Set(doc.params.map(p => normParam(p.name)));
    const docHeaderNames    = new Set(doc.headers.map(h => norm(h.name)));
    const tryOutParamNames  = new Set(tryOut.params.map(p => normParam(p.name)));
    const tryOutHeaderNames = new Set(tryOut.headers.map(h => normParam(h.name)));

    const nearMatchNoted = new Set<string>();

    // Only compare Doc ↔ Try Out when the scraper found actual doc param tables
    if (doc.params.length > 0) {
      for (const p of doc.params) {
        if (isBodyField(p.name)) continue;
        if (GLOBAL_HEADERS.has(normParam(p.name))) continue;
        const n = normParam(p.name);
        if (!tryOutParamNames.has(n) && !tryOutHeaderNames.has(n)) {
          const near = findNearMatch(n, tryOutParamNames, tryOutHeaderNames);
          if (near) {
            nearMatchNoted.add(n); nearMatchNoted.add(near);
            mismatches.push({
              type: 'name_mismatch', field: p.name,
              source: 'Doc ↔ Try Out',
              detail: `Doc calls this param "${p.name}" but the Try Out panel calls it something else matching "${near}" — likely a doc naming inconsistency, not a missing field`,
              severity: 'info',
            });
            continue;
          }
          mismatches.push({
            type: 'missing_in_tryout', field: p.name,
            source: 'Doc → Try Out',
            detail: `Doc describes param "${p.name}" but it is NOT present in the Try Out panel`,
            severity: p.required ? 'error' : 'warning',
          });
        }
      }
      for (const f of tryOut.params) {
        if (GLOBAL_HEADERS.has(normParam(f.name))) continue;
        const n = normParam(f.name);
        if (nearMatchNoted.has(n)) continue;
        if (!docParamNames.has(n) && !docHeaderNames.has(n)) {
          mismatches.push({
            type: 'extra_in_tryout', field: f.name,
            source: 'Try Out → Doc',
            detail: `Try Out panel has field "${f.name}" not mentioned in doc description`,
            severity: 'warning',
          });
        }
      }
    } else if (tryOut.params.length > 0) {
      // Doc has no param table at all, but the Try Out panel shows fields —
      // flag the whole set as undocumented rather than silently skipping.
      for (const f of tryOut.params) {
        if (GLOBAL_HEADERS.has(normParam(f.name))) continue;
        mismatches.push({
          type: 'extra_in_tryout', field: f.name,
          source: 'Try Out → Doc',
          detail: `Try Out panel has field "${f.name}" but the doc has no Parameters section at all for "${doc.name}"`,
          severity: 'warning',
        });
      }
    }

    // Headers — skip universal auth/infra headers documented globally.
    for (const h of doc.headers) {
      const n = norm(h.name);
      if (GLOBAL_HEADERS.has(n)) continue;
      if (tryOutHeaderNames.has(n) || tryOutParamNames.has(n)) continue;
      mismatches.push({
        type: 'missing_in_tryout', field: h.name,
        source: 'Doc → Try Out (header)',
        detail: `Doc lists header "${h.name}" but it is NOT present in the Try Out panel`,
        severity: h.required ? 'error' : 'warning',
      });
    }
    for (const f of tryOut.headers) {
      const n = normParam(f.name);
      if (GLOBAL_HEADERS.has(n)) continue;
      if (docHeaderNames.has(n) || docParamNames.has(n)) continue;
      mismatches.push({
        type: 'extra_in_tryout', field: f.name,
        source: 'Try Out (header) → Doc',
        detail: `Try Out panel sends header "${f.name}" not documented in doc description`,
        severity: 'warning',
      });
    }

    const errors   = mismatches.filter(m => m.severity === 'error').length;
    const warnings = mismatches.filter(m => m.severity === 'warning').length;

    results.push({
      requestName: doc.name,
      endpoint:    doc.endpoint,
      method:      doc.method,
      docUrl:      doc.docUrl,
      mismatches,
      status: errors > 0 ? 'fail' : warnings > 0 ? 'warning' : 'pass',
    });
  }

  const outPath = path.join(__dirname, '../../reports/comparison-results-administration.json');
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));

  const pass = results.filter(r => r.status === 'pass').length;
  const warn = results.filter(r => r.status === 'warning').length;
  const fail = results.filter(r => r.status === 'fail').length;
  console.log(`\n📊  Comparison done (Administration) — ✅ ${pass} pass  ⚠️ ${warn} warning  ❌ ${fail} fail`);
  console.log(`📝  Results → ${outPath}`);

  return results;
}

function norm(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Doc param tables append qualifiers like "asset[upload] (mandatory)" — strip them.
function stripQualifier(name: string): string {
  return name.replace(/\s*\((mandatory|optional|required)\)\s*$/i, '').trim();
}

function normParam(name: string): string {
  return norm(stripQualifier(name));
}

// "asset[upload]"-style names are multipart form-data BODY fields documented in the
// params table — they are not query params and never appear as Try Out inputs.
function isBodyField(name: string): boolean {
  return /\[.+\]/.test(stripQualifier(name));
}

// Catches doc/Try Out naming inconsistencies for the SAME underlying param —
// e.g. doc says "locale" while Try Out uses "locale_code". Length-gated at 4
// chars to avoid over-matching short generic names like "uid" or "id".
function findNearMatch(name: string, ...sets: Array<Set<string>>): string | undefined {
  if (name.length < 4) return undefined;
  for (const set of sets) {
    for (const candidate of set) {
      if (candidate.length < 4) continue;
      if (candidate.includes(name) || name.includes(candidate)) return candidate;
    }
  }
  return undefined;
}

runComparisonAdministration().catch(console.error);
