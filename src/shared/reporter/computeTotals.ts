import { TryOutTestResult, ComparisonResult, ApiTestResult, NewmanResult } from '../../../config/types';

/**
 * Every one of the 4 result arrays may cover a different (overlapping)
 * subset of requests depending on which phases run for a given API (see
 * API_FLAGS in generateReport.ts: noLiveTryOut/noPostman/executorLabel) —
 * e.g. noLiveTryOut APIs (Analytics, Automations, Brand Kit, GenAI,
 * Knowledge Vault) never populate comparisonResults at all. The old logic
 * (inlined separately in generateReport.ts and publishToDashboard.ts) picked
 * `totalRequests` from whichever array was non-empty but read `passed`/
 * `warnings` from comparisonResults ONLY, so for those APIs passed/warnings
 * were always 0 no matter the real total. Meanwhile `failed` was deduped
 * across all 4 arrays, which could exceed `totalRequests` when a different
 * array contributed extra failing names not present in whichever array
 * total was drawn from (confirmed: Personalize/Lytics/Launch each showed
 * passed+failed > total).
 *
 * Fix: build one canonical set of every distinct request actually tested
 * (union of requestName across all 4 arrays), classify each exactly once,
 * and derive totalRequests/passed/warnings/failed from that same set so
 * totalRequests === passed + warnings + failed always holds.
 *
 * Shared by generateReport.ts (Slack/HTML/GitHub-summary report) and
 * publishToDashboard.ts (dashboard report) so both always show the same,
 * internally-consistent numbers. Kept in its own module (rather than
 * exported from generateReport.ts) because generateReport.ts runs itself
 * as a side effect at import time (`generateReport().catch(...)` at module
 * scope) -- importing from it would re-trigger a full report run and Slack
 * email every time this function is needed.
 */
export type Outcome = 'pass' | 'warning' | 'fail';

/**
 * The single canonical classification step described above: one Map entry
 * per distinct request name across all 4 result arrays, classified exactly
 * once. Both `computeTotals` (aggregate counts) and `classifyItems`
 * (per-request list, for dashboard items[]/warnings[]) build on this same
 * map so the two never disagree.
 */
function buildOutcomeByName(
  comparisonResults: ComparisonResult[],
  tryOutResults: TryOutTestResult[],
  apiTestResults: ApiTestResult[],
  newmanResults: NewmanResult[],
): Map<string, Outcome> {
  const outcomeByName = new Map<string, Outcome>();

  // A comparisonResults verdict is the richest signal (doc vs. live
  // execution mismatch) and wins if present; otherwise fall back to
  // whichever of tryOut/apiTest/newman actually covers that request.
  for (const r of comparisonResults) {
    outcomeByName.set(r.requestName, r.status === 'pass' ? 'pass' : r.status === 'warning' ? 'warning' : 'fail');
  }
  for (const r of tryOutResults) {
    if (!outcomeByName.has(r.requestName)) outcomeByName.set(r.requestName, r.passed ? 'pass' : 'fail');
  }
  for (const r of apiTestResults) {
    if (!outcomeByName.has(r.requestName)) outcomeByName.set(r.requestName, r.passed ? 'pass' : 'fail');
  }
  for (const r of newmanResults) {
    if (!outcomeByName.has(r.requestName)) outcomeByName.set(r.requestName, r.passed ? 'pass' : 'fail');
  }

  return outcomeByName;
}

export function computeTotals(
  comparisonResults: ComparisonResult[],
  tryOutResults: TryOutTestResult[],
  apiTestResults: ApiTestResult[],
  newmanResults: NewmanResult[],
): { totalRequests: number; passed: number; warnings: number; failed: number } {
  const outcomeByName = buildOutcomeByName(comparisonResults, tryOutResults, apiTestResults, newmanResults);

  let passed = 0, warnings = 0, failed = 0;
  for (const outcome of outcomeByName.values()) {
    if (outcome === 'pass') passed++;
    else if (outcome === 'warning') warnings++;
    else failed++;
  }

  return { totalRequests: outcomeByName.size, passed, warnings, failed };
}

/**
 * Every distinct request name across all 4 result arrays, classified via the
 * exact same canonical map `computeTotals` uses — this is what dashboard
 * items[] (and, by filtering, warnings[]) are built from, and it's also the
 * per-name classification the HTML report's row `id` slugs are keyed off of.
 * Order follows Map insertion order: comparisonResults first, then the first
 * new name contributed by tryOutResults, apiTestResults, newmanResults in
 * that order — kept stable so callers building slugs (see `createSlugger`)
 * get deterministic, reproducible output.
 */
export function classifyItems(
  comparisonResults: ComparisonResult[],
  tryOutResults: TryOutTestResult[],
  apiTestResults: ApiTestResult[],
  newmanResults: NewmanResult[],
): Array<{ name: string; status: Outcome }> {
  const outcomeByName = buildOutcomeByName(comparisonResults, tryOutResults, apiTestResults, newmanResults);
  return Array.from(outcomeByName.entries()).map(([name, status]) => ({ name, status }));
}

/**
 * Returns a memoized slug function: same request name always yields the same
 * URL-safe slug (lowercase, non-alphanumeric runs -> "-"), and distinct names
 * that happen to slugify to the same base get a numeric suffix (`-2`, `-3`,
 * ...) so anchors never collide within one report.
 *
 * generateReport.ts (HTML `<tr id="...">`) and publishToDashboard.ts
 * (`items[].reportUrl` `#anchor`) each create their own slugger and feed it
 * names in the same order — comparisonResults, then tryOutResults, then
 * apiTestResults, then newmanResults — so the two independently produce
 * identical slugs for the same request name without sharing state.
 */
export function createSlugger(): (name: string) => string {
  const assigned = new Map<string, string>();
  const nextSuffixForBase = new Map<string, number>();

  return (name: string): string => {
    const cached = assigned.get(name);
    if (cached) return cached;

    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'item';
    let slug = base;
    if (nextSuffixForBase.has(base)) {
      const n = nextSuffixForBase.get(base)! + 1;
      nextSuffixForBase.set(base, n);
      slug = `${base}-${n}`;
    } else {
      nextSuffixForBase.set(base, 1);
    }

    assigned.set(name, slug);
    return slug;
  };
}
