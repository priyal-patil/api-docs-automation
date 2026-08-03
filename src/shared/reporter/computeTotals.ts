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
export function computeTotals(
  comparisonResults: ComparisonResult[],
  tryOutResults: TryOutTestResult[],
  apiTestResults: ApiTestResult[],
  newmanResults: NewmanResult[],
): { totalRequests: number; passed: number; warnings: number; failed: number } {
  type Outcome = 'pass' | 'warning' | 'fail';
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

  let passed = 0, warnings = 0, failed = 0;
  for (const outcome of outcomeByName.values()) {
    if (outcome === 'pass') passed++;
    else if (outcome === 'warning') warnings++;
    else failed++;
  }

  return { totalRequests: outcomeByName.size, passed, warnings, failed };
}
