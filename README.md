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
