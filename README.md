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
