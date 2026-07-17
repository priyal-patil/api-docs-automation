# Contentstack API Doc Automation

Automated daily testing of Contentstack API documentation across 5 phases.

## Setup

```bash
npm install
npx playwright install chromium
cp .env.example .env
# Fill in your credentials in .env
```

## Running

```bash
# Run everything end-to-end
npm run run-all

# Or run phases individually
npm run scrape       # Phase 1 — scrape doc pages
npm run tryout       # Phase 2 — live Try Out panel tests
npm run compare      # Phase 3 — doc vs Postman comparison
npm run api-test     # Phase 4 — direct API functional tests
npm run report       # Phase 5 — generate HTML report + Slack alert
```

## Analytics API

The Analytics API docs have no live "Try Out" Send button (`Open Builder` only
shows the same static params + a canned Sample Response — confirmed, nothing
executes). So this pipeline skips the live Try Out phase and uses the doc's
declared Sample Response as the baseline for the response-body check instead:

```bash
npm run analytics          # scrape → newman → compare → report, end-to-end

npm run scrape:analytics   # scrape the 8 Analytics doc pages
npm run newman:analytics   # execute the Analytics Postman collection live
npm run compare:analytics  # doc params/headers ↔ Postman, + Newman response ↔ doc Sample Response
npm run report:analytics   # → reports/run-report-analytics.html
```

Auth is org-scoped (`CS_ORG_UID`, requires an Owner/Admin account), not the
stack-scoped `CS_MANAGEMENT_TOKEN` used by CMA. Set `CS_QA_EMAIL` +
`CS_QA_PASSWORD` and `runNewmanAnalytics.ts` logs in fresh every run via
`POST /v3/user-session` — see
[Authentication](https://www.contentstack.com/docs/developers/apis/analytics-api#authentication).
This is deliberate, not optional polish: authtokens silently expire (a user is
capped at 20 valid tokens; a login anywhere else quietly evicts the oldest),
confirmed live when a static `CS_AUTHTOKEN` started 401ing on every request
after a few days on this shared QA org. `CS_AUTHTOKEN` still works as a
fallback if no QA credentials are set, but expect it to eventually go stale.

**Known collection issue:** the official Postman collection hardcodes
`from=2024-01-31&to=2024-03-31`, which now returns `400 An internal server
error occurred` (the analytics data window appears to have aged past those
dates). `runNewmanAnalytics.ts` rewrites both to a rolling last-30-days range
before every run — the collection itself should probably be fixed upstream.

## Automations Management API

Same shape as Analytics — no live Try Out execution, so the doc's declared
Sample Response is the comparison baseline. Unlike Analytics, this API has
POST/PUT/DELETE, so request-body comparison (doc Sample Request ↔ Postman
body) is real work here, not a no-op. Reuses the same org-scoped auth as
Analytics (`CS_ORG_UID`, `CS_QA_EMAIL`/`CS_QA_PASSWORD`).

```bash
npm run automations          # scrape → newman → compare → report, end-to-end

npm run scrape:automations   # scrape all 19 endpoints across 6 module pages
npm run newman:automations   # create a disposable test project, run the collection live, delete it
npm run compare:automations  # doc params/headers/request body ↔ Postman, + Newman response ↔ doc Sample Response
npm run report:automations   # → reports/run-report-automations.html
```

**Test data lifecycle:** `runNewmanAutomations.ts` creates a disposable
project before each run (for the Projects/Project Variables CRUD tests) and
deletes it — plus the collection's own "Create a project" request, which
creates a second one — in a `finally` block, so cleanup runs even if Newman
fails. Automations/Execution Logs/Audit Logs/Accounts have no create
endpoint (they only exist as a side effect of building/running an automation
in the UI), so the runner best-effort searches existing projects in the org
for one that already has automation data and borrows its UIDs for those
folders; if none exist anywhere, those specific "Get a single X" requests
get an unresolved `{{variable}}` and are marked as no-test-data rather than
a false failure.

**Known collection ordering issue (worked around, not a doc bug):** the
Projects folder's own "Delete a project" request actually deletes
`{{project_uid}}` — confirmed live: running the collection in its default
folder order deleted the disposable project immediately after "Update a
project," then every other folder 404'd because the project it depended on
no longer existed. `runNewmanAutomations.ts` moves the Projects folder to
run last so every other folder gets to use the project while it's still alive.

**Response key names that don't match their param names (confirmed live,
not a guess):** `Get all automations` returns `{"rules": [...]}`, not
`{"automations": [...]}` — the singular endpoints and the other four modules
(`executions`, `logs`, `accounts`, `projects`) all match their obvious name.

## Required Secrets (GitHub Actions)

| Secret | Description |
|---|---|
| `CS_API_KEY` | Stack API key (sandbox stack) |
| `CS_DELIVERY_TOKEN` | Delivery token |
| `CS_MANAGEMENT_TOKEN` | Management token (for CMA tests) |
| `CS_ACCESS_TOKEN` | Access token |
| `CS_REGION` | Region: `us` / `eu` / `azure-na` / `azure-eu` / `gcp-na` |
| `POSTMAN_API_KEY` | Postman API key |
| `POSTMAN_CDA_COLLECTION_ID` | CDA Postman collection ID |
| `SLACK_WEBHOOK_URL` | Slack incoming webhook URL |

## Reports

All reports are saved to `reports/`:
- `scraped-requests.json` — extracted doc data
- `tryout-results.json` — Try Out panel test results
- `comparison-results.json` — three-way comparison results
- `api-test-results.json` — direct API test results
- `run-report.html` — full HTML report (open in browser)

## What Gets Flagged

- Try Out panel returns 4xx/5xx after filling credentials and clicking Send
- Try Out panel shows 4xx/5xx **by default before Send is clicked**
- Doc description mentions a param not present in the Try Out panel
- Postman collection has a new field not in the doc or Try Out
- Field name mismatch between doc and Postman
- Required/optional mismatch between doc and Postman
- Request body schema differs between doc and Postman
- Direct API call returns unexpected status code
- Response body is missing documented fields
