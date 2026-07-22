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

## Brand Kit Management API

Same shape as Automations — no live Try Out execution, POST/PUT/DELETE so
request-body comparison is real work. Unlike Automations, every resource
(Brand Kit, Voice Profile, Custom Credentials) has a real Create/Set
endpoint, so the whole lifecycle is fully disposable — no need to borrow
data from an existing org resource. Reuses the same org-scoped auth
(`CS_ORG_UID`, `CS_QA_EMAIL`/`CS_QA_PASSWORD`); also needs `CS_API_KEY`
(the same stack key CDA/CMA use) for one specific fix below.

```bash
npm run brandkit          # scrape → newman → compare → report, end-to-end

npm run scrape:brandkit   # scrape all 12 endpoints across 3 module pages
npm run newman:brandkit   # create a disposable test Brand Kit + Voice Profile, run the collection live, delete them
npm run compare:brandkit  # doc params/headers/request body ↔ Postman, + Newman response ↔ doc Sample Response
npm run report:brandkit   # → reports/run-report-brandkit.html
```

**Known collection ordering issues (worked around, not doc bugs):**
- The Brand Kit folder's own "Delete Brand Kit" request deletes
  `{{brand_kit_uid}}` — same class of issue as Automations' Projects folder.
  `runNewmanBrandKit.ts` moves Brand Kit to run last so Voice Profile and
  Custom Credentials get to use it while it's still alive.
- "Get Custom Credentials" runs before "Set Custom Credentials" in the
  collection's default order — confirmed live, GET 400s with a misleading
  "Unable to fetch Brand Kit... uid is invalid" on a brand kit that has never
  had an LLM config set, and succeeds once Set has run. Swapped the order.

**Known validation quirks (confirmed live, worked around):**
- `Create Brand Kit`/`Update Brand Kit` hardcode a placeholder `api_keys`
  value that 400s ("is invalid") — real stack API keys are required.
- Asymmetric validation: `Create Brand Kit` accepts `api_keys: []` fine, but
  `Update Brand Kit` requires at least one real key ("should be more than
  1"). Fixed by sending `[]` for Create and `[CS_API_KEY]` for Update.

**Doc drift found (reported, not silently fixed):** `Get All Voice Profiles`'
Sample Response is documented with a singular `voice_profile` key; the live
API actually returns the plural `voice_profiles`.

## Generative AI API

Only one endpoint (`GenAI`), and unlike every other module here, **it calls a
real LLM** — the response is a streamed, non-JSON body (`"data: {...}"` SSE
chunks, `gpt-4o` in this org), not a plain JSON object, so response-body
comparison is skipped wherever keys aren't parseable (the same fallback
already used elsewhere when a field is unavailable). It's a sub-resource of
Brand Kit — the base URL bakes in `/brand-kits`, and it needs a real
`brand_kit_uid`, so the runner reuses Brand Kit's disposable create/delete
lifecycle.

```bash
npm run genai          # scrape → newman → compare → report, end-to-end

npm run scrape:genai   # scrape the single GenAI endpoint
npm run newman:genai   # create a disposable test Brand Kit, call the real LLM once, delete it
npm run compare:genai  # doc params/headers/request body ↔ Postman
npm run report:genai   # → reports/run-report-genai.html
```

**Doc bugs found (confirmed live, not guessed):**
- The intro page's "API Conventions" section says *"Generative AI API
  supports GET verbs or methods"* — the real (and only) endpoint is `POST`.
- `brand_kit_uid` is documented as optional; the live API 400s with
  `"brand_kit_uid is required"` without it. Flagged in every comparison run
  (Postman collections don't carry a required/optional flag on headers, so
  this can't be caught by the normal doc↔Postman diff — hardcoded as a known
  check in `compareGenAI.ts`).

**Known validation quirk (worked around):** the collection's example body
hardcodes a masked placeholder `voice_profile_uid` that 400s ("is invalid").
Our disposable brand kit has no real voice profile to reference, so the
runner sets `knowledge_vault: false` and drops the field — confirmed live
this succeeds.

## Knowledge Vault API

Same no-live-Try-Out shape, same Brand Kit sub-resource dependency as GenAI
(base URL bakes in `/brand-kits`, needs a real `brand_kit_uid`). Only three
endpoints exist — **Ingest, Update, Delete Content Item — there is no
Get/List endpoint**, despite the overview text mentioning "usage tracking."
Ingestion returns a `content.uid` immediately and Update/Delete work against
it right away — no async wait needed, despite the response saying "will be
ingested shortly."

```bash
npm run knowledgevault          # scrape → newman → compare → report, end-to-end

npm run scrape:knowledgevault   # scrape all 3 endpoints
npm run newman:knowledgevault   # create a disposable test Brand Kit + content item, run the collection live, delete them
npm run compare:knowledgevault  # doc params/headers/request body ↔ Postman, + Newman response ↔ doc Sample Response
npm run report:knowledgevault   # → reports/run-report-knowledgevault.html
```

**Test data lifecycle:** unlike Automations, deleting the disposable Brand
Kit cascades all Knowledge Vault content stored under it — no separate
cleanup call needed for ingested items (including the one the collection's
own "Ingest Content Item" request creates as a side effect of running it).
The collection has no test script to chain Ingest's `content_uid` into
Update/Delete, so the runner pre-fetches its own via a live Ingest call
first (same pattern as Analytics' `jobId`).

**Doc + collection bug found (confirmed live, not guessed):** `Update
Content Item`'s example request body is **invalid JSON in both the doc's
own rendered Sample Request and the Postman collection** — missing a comma
between `"content"` and `"_metadata"`, likely generated from the same
broken source. Neither reference a developer might copy from actually
works. `runNewmanKnowledgeVault.ts` sends an equivalent valid body instead
so Update itself gets tested; `compareKnowledgeVault.ts` flags the broken
example as a failure (not just a warning) since neither source is usable as-is.

**Doc bug found (confirmed live, not guessed):** `path` is documented as
required on `Ingest Content Item`, but the live API accepts omitting it and
auto-assigns a default folder.

## Lytics CDP Management API

Org-scoped auth (`CS_ORG_UID`, `CS_QA_EMAIL`/`CS_QA_PASSWORD`), same as
Automations/Brand Kit. Unlike every other product here, **there is no
Postman collection** — instead the API publishes a live OpenAPI 3.0 spec at
`https://<region-host>/openapi`, which stands in for the Postman collection
as the third leg of the comparison (Doc ↔ Try Out ↔ OpenAPI spec + live
execution), and a custom executor (`runSwaggerLytics.ts`) replaces Newman,
calling the 10 real endpoints directly via axios instead of running a
Postman collection. Unlike Automations/Brand Kit, the doc's "Open Builder"
panel **is live** (confirmed by manually filling real credentials and
clicking Send Request) — so this product line has a real Playwright Try Out
phase (`tests/lytics/tryout-lytics.spec.ts`), same shape as CDA/CMA.

```bash
npm run lytics          # scrape → tryout → swagger execution → compare → report, end-to-end

npm run scrape:lytics   # scrape all 10 endpoints across 3 module pages (Projects, Collaborators, Roles)
npm run tryout:lytics   # live Try Out panel tests (fills authtoken/organization_uid/id/userUid, clicks Send)
npm run swagger:lytics  # create a disposable test project + collaborator, run the OpenAPI-described requests live, delete them
npm run compare:lytics  # doc params/headers/request body ↔ OpenAPI spec, + live response ↔ doc Sample Response
npm run report:lytics   # → reports/run-report-lytics.html
```

**Confirmed doc bug — `x-cs-api-version` is documented optional but is
actually required for routing:** every one of the 10 endpoints initially
appeared to 404 (`Cannot GET/POST/PUT/DELETE ...`) via direct API calls, the
doc's own "Open Builder" panel, and this pipeline's first pass — a false
alarm caused by all three omitting the `x-cs-api-version` header, which the
doc documents as optional ("defaults to v1"). It isn't optional: omitting it
returns a generic framework-level 404 before auth or routing logic ever
runs; including it (`x-cs-api-version: 1`) routes correctly every time. This
was only caught because the *actual* Swagger UI page (`/swagger`, distinct
from the doc's "Open Builder" panel) silently defaults this header in for
you, so requests made there succeeded (`201 Created`, with a real CDP
account provisioned) while identical requests elsewhere 404'd. Confirmed by
instrumenting `window.fetch` on the live Swagger UI page to capture the
exact headers it sends, then replaying that exact request via direct axios
— removing just the `x-cs-api-version` header reintroduced the 404, adding
it back fixed it, reproducibly. **Report to the Lytics API team:** the doc's
"defaults to v1" claim for `x-cs-api-version` is false — it should either
actually default server-side when omitted (as documented) or be marked
required.

**Separate confirmed bug — `DELETE /projects/{id}` returns 403 for the
project's own creator:** even with `x-cs-api-version` set, deleting a
project returns `403 "Forbidden resource"` for the same org owner/admin
account that created it (confirmed both via direct API call and the real
Swagger UI's Execute button). This is not a header/routing issue — every
other verb works fine for the same account. Possibly requires an OAuth
`lytics:manage`-scoped bearer token rather than the `authtoken` header for
delete specifically; unconfirmed, needs the Lytics API team to clarify.
**Practical consequence:** this pipeline's own disposable test projects
cannot reliably clean themselves up — check the org's Lytics project list
periodically for accumulated `API Docs Automation Test *` / disposable
projects and remove them manually (or via whatever credential does have
delete permission) once the org's project quota is at risk of being hit
(`lytics.PROJECTS.MAX_PROJECT_LIMIT_REACHED`).

**Test data lifecycle:** creates a disposable project (`Create a project`),
exercises Get/Update/List against it, invites `CS_QA_SECOND_EMAIL` as a
collaborator (skipped with a "no-test-data" marker, not a false failure, if
that secret isn't set), updates their role, then in a `finally` block
attempts to remove the collaborator and delete the project (expect the
delete to 403 per the bug above). If Create fails for any reason (e.g. the
quota bug), downstream calls proceed with a placeholder id
(`unresolved-project-uid` for the Swagger executor, `test-project-uid` for
the live Try Out spec) so every endpoint still gets an honest execution
result instead of silently vanishing from the report.

**Undocumented response shapes (confirmed live):** every 2xx response in the
OpenAPI spec declares only a `description`, no `content`/schema — so the
collaborator UID needed for the role-update/remove calls can't be derived
from the spec ahead of time. `runSwaggerLytics.ts` best-effort resolves it
from the live "List collaborators" response instead (tries `userUid`/`uid`/
`id`/`user_uid`); if that fails, the dependent calls are marked
no-test-data rather than false-failed. This gap itself is also surfaced as
a normal `missing_in_doc`-style finding by the comparator when relevant.

**Region hosts:** confirmed from the Swagger page's own "Servers" list —
`lytics-api.contentstack.com` (US), with `eu-`/`au-`/`azure-na-`/`azure-eu-`/
`gcp-na-`/`gcp-eu-` prefixes for other regions (no `-prod-` infix, unlike
Automations).

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
