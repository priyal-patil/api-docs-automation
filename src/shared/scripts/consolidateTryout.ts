import * as fs from 'fs';
import * as path from 'path';
import { TryOutTestResult } from '../../../config/types';

/**
 * Reads every individual Try Out result file and writes the combined array to
 * the results JSON. This must run as a standalone step AFTER `playwright test`
 * exits, not from `test.afterAll` inside the spec — with fullyParallel + multiple
 * workers, afterAll fires once PER WORKER (each worker shards a subset of the
 * describe block's tests), not once globally. Whichever worker's afterAll fires
 * last wins, but "last to fire" isn't guaranteed to be "after every worker has
 * finished writing its files" — so the old in-spec consolidation silently wrote
 * a partial snapshot (e.g. 136 of 268 results) instead of the full set.
 */
function consolidate(individualDir: string, resultsPath: string, label: string): void {
  const files = fs.existsSync(individualDir) ? fs.readdirSync(individualDir) : [];
  const all: TryOutTestResult[] = files
    .filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(fs.readFileSync(path.join(individualDir, f), 'utf-8')));
  fs.writeFileSync(resultsPath, JSON.stringify(all, null, 2));
  console.log(`📝  ${label} Try Out results consolidated (${all.length} requests) → ${resultsPath}`);
}

const target = process.argv[2];
const REPORTS_DIR = path.join(__dirname, '../../../reports');

const PRODUCTS: Record<string, { dir: string; suffix: string; label: string }> = {
  cma:             { dir: 'individual-cma',             suffix: '-cma',             label: 'CMA' },
  lytics:          { dir: 'individual-lytics',          suffix: '-lytics',          label: 'Lytics' },
  personalize:     { dir: 'individual-personalize',     suffix: '-personalize',     label: 'Personalize' },
  personalizeedge: { dir: 'individual-personalizeedge', suffix: '-personalizeedge', label: 'Personalize Edge' },
  launch:          { dir: 'individual-launch',          suffix: '-launch',          label: 'Launch' },
};

const product = target ? PRODUCTS[target] : undefined;
if (product) {
  consolidate(
    path.join(REPORTS_DIR, product.dir),
    path.join(REPORTS_DIR, `tryout-results${product.suffix}.json`),
    product.label
  );
} else {
  consolidate(
    path.join(REPORTS_DIR, 'individual'),
    path.join(REPORTS_DIR, 'tryout-results.json'),
    'CDA'
  );
}
