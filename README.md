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

## Personalize Management API

Same shape as Lytics (no Postman collection — a live OpenAPI 3.0 spec at
`https://personalize-api.contentstack.com/openapi` stands in, with a custom
Swagger executor replacing Newman), and the doc's "Open Builder" panel is
live here too (confirmed), so this product line gets a real Playwright Try
Out phase. **Checked explicitly for a repeat of the Lytics `x-cs-api-version`
gotcha — found clean**: this API only needs `authtoken` (or `authorization`
Bearer) + `x-project-uid`, and project-scoped calls work correctly with just
those two, no hidden required-but-undocumented header.

```bash
npm run personalize          # scrape → tryout → swagger execution → compare → report, end-to-end

npm run scrape:personalize   # scrape all 28 endpoints across 7 module pages
npm run tryout:personalize   # live Try Out panel tests
npm run swagger:personalize  # full disposable Attribute/Event/Audience/Experience/Version lifecycle, live
npm run compare:personalize  # doc params/headers/request body ↔ OpenAPI spec, + live response ↔ doc Sample Response
npm run report:personalize   # → reports/run-report-personalize.html
```

**No "create project" endpoint exists.** Every one of the 28 endpoints is
scoped to an *existing* Personalize project via `x-project-uid` — unlike
Lytics, this API has no way to provision a disposable project per run.
`PERSONALIZE_PROJECT_UID` must point at a real, existing project.

**Undocumented discovery — `GET /projects` on the same host lists the org's
projects, despite not being in the published OpenAPI spec.** Found live
while looking for a way to obtain a project UID (there's no documented way
to list Personalize projects anywhere). The QA org already had several
existing projects when this was discovered, including a few with names like
"Doc Personalize Project \*" and "Manage doc project \*" — apparent leftovers
from an earlier, unrelated attempt at automating this same API. This
pipeline reuses the project named **"Test"** (`698af1e39f7fc9b90d588622`)
as the fixed `PERSONALIZE_PROJECT_UID`.

**Test data lifecycle (full CRUD, live):** creates a disposable Attribute →
Event → Audience (references the Attribute) → Experience → Experience
Version (references the Audience + Event), exercises every list/get-by-id/
update endpoint against them, updates Experiences Priority, reads Analytics,
reads Geolocation (no project scope needed), then deletes everything in
reverse dependency order. **Unlike Lytics, deletes here actually succeed**
(confirmed `204` for all 5 resource types) — no repeat of the Lytics
DELETE-403 permission gap.

**Genuine business-rule responses (not bugs) baked into the lifecycle:**
- Creating an Experience auto-provisions a single default DRAFT version.
  Explicitly calling `Create an Experience Version` again therefore
  correctly 400s (`CANNOT_CREATE_VERSION_AS_DRAFT_ALREADY_EXISTS`) — the
  runner falls back to the auto-created version's UID for the rest of the
  lifecycle so Update/Priority/Analytics/Delete still have something real.
- `Delete an Experience Version` 400s (`CANNOT_DELETE_ONLY_DRAFT`) since an
  experience must always have at least one version.
- `Get Analytics Summary`/`Get Time-series Analytics` 404 (`SUMMARY_NOT_FOUND`
  / `TIME_SERIES_ANALYTICS_NOT_FOUND`) since analytics only exist for
  *activated* experiences with real traffic — a disposable draft never
  qualifies.
- **Minor doc gap found:** the OpenAPI spec's own `400` example responses for
  `Create an Experience Version` and `Delete an Experience Version` don't
  include these two error codes at all (they show different example errors
  instead) — worth reporting, though low severity since the endpoints behave
  correctly, just the example coverage is incomplete.
- `Update Experiences Priority` requires the **full** set of the project's
  existing experience UIDs, not just the newly created one — passing a
  partial list 400s (`MISSING_EXPERIENCES`). Not clearly stated in the doc's
  Sample Request (which only shows a single-UID example). On repeated runs
  this can still 400 even with every currently-existing experience UID
  included — possibly a stale/orphaned reference left behind by a
  previously-deleted experience that's still tracked in the priority list;
  needs the Personalize API team to confirm.
- **Confirmed doc gaps — real response fields undocumented in the Sample
  Request/Response:** `Update an Experience`'s OpenAPI request schema has a
  `tags` field (array of strings, used for grouping/Edge delivery per the
  spec's own tag description) that the doc's Sample Request doesn't show;
  `Update an Experience Version`'s schema has a `targeting` field (audience
  targeting config) missing from its Sample Request; and `Get a Single
  Experience`'s live response includes a `description` field absent from the
  doc's declared Sample Response. All three are genuine comparator findings,
  not execution bugs.
- **Known Try Out limitation:** the doc's live Try Out panel doesn't let this
  automation edit the JSON request body — it always resends the doc's own
  static Sample Request. Since Create endpoints (Attribute/Audience/Event/
  Experience) use fixed sample values (e.g. `key: "age"`), repeated runs can
  hit duplicate-key/name validation errors on the Try Out phase specifically
  (the Swagger executor doesn't have this problem — it generates a fresh,
  timestamped payload every run).

These are recorded as real, honest execution results (same philosophy as
Lytics' quota-limit handling), not hidden or special-cased away.

**Region hosts:** same list shape as Lytics — `personalize-api.contentstack.com`
(US), `eu-`/`au-`/`azure-na-`/`azure-eu-`/`gcp-na-`/`gcp-eu-` prefixes for
other regions.

## Personalize Edge API

Small, public-facing sibling of Personalize Management — 4 endpoints across
3 modules (Manifest, User Attributes, Events). Same no-Postman/live-OpenAPI-
spec/live-Try-Out shape as Lytics and Personalize Management, but simpler in
one key way: **confirmed live that this API requires no authentication at
all** (it's meant for public digital properties) — only `x-project-uid`
(always) and `x-cs-personalize-user-uid` (required for Events, optional
elsewhere). Reuses `PERSONALIZE_PROJECT_UID` from the Management API — no
new project-UID secret needed.

```bash
npm run personalizeedge          # scrape → tryout → swagger execution → compare → report, end-to-end

npm run scrape:personalizeedge   # scrape all 4 endpoints across 3 module pages
npm run tryout:personalizeedge   # live Try Out panel tests (no auth token to fill in)
npm run swagger:personalizeedge  # Get Manifest (bootstraps a user UID) → Set User Attributes → Track Events → Merge, all live
npm run compare:personalizeedge  # doc params/headers/request body ↔ OpenAPI spec, + live response ↔ doc Sample Response
npm run report:personalizeedge   # → reports/run-report-personalizeedge.html
```

**Test data lifecycle:** calls `Get Manifest` *without* a user UID first —
the API generates one and returns it via the `x-cs-personalize-user-uid`
response header (this is the doc's own documented way to obtain a user UID
for testing, not a workaround), then reuses that real UID for Set User
Attributes, Track Events, and Merge (merging the user into itself — a safe
no-op). No resources are created, so there's no cleanup/delete step at all
— nothing to leave behind between runs, unlike every other product line.

**Cleanest result of all 10 product lines:** the very first live run passed
**4/4 with zero warnings and zero failures** — direct API calls, the live
Try Out panel, and the comparator all agreed with no gotchas, no undocumented
headers, no permission gaps. Confirmed this cleanly by checking explicitly
for anything resembling the Lytics `x-cs-api-version` issue or the
Personalize Management doc-gap findings — none found here.

**Region hosts:** same shape as the other two Personalize APIs —
`personalize-edge.contentstack.com` (US), `eu-`/`au-`/`azure-na-`/
`azure-eu-`/`gcp-na-`/`gcp-eu-` prefixes for other regions.

## Launch API

Same no-Postman/live-OpenAPI-spec/live-Try-Out shape as Lytics/Personalize
(22 endpoints across 7 modules: Projects, Environments, File Upload,
Deployments, Deployment Logs, Launch Product Analytics, Server Logs), but
with a fundamentally different risk profile: **Launch resources are real
infrastructure, not just data records.** Creating a Project + Environment
triggers a genuine build and deploys a live hosted site.

```bash
npm run launch          # scrape → tryout → swagger execution → compare → report, end-to-end

npm run scrape:launch   # scrape all 21 documented endpoints (spec has a 22nd, undocumented — see Coverage below)
npm run tryout:launch   # live Try Out panel tests against a reused, fixed project/environment/deployment
npm run swagger:launch  # reads against the reused fixtures + a real disposable project create/update/delete lifecycle
npm run compare:launch  # doc params/headers/request body ↔ OpenAPI spec, + live response ↔ doc Sample Response
npm run report:launch   # → reports/run-report-launch.html
```

**Reused-fixture design (deliberate, not a workaround):** the QA org already
had 3 leftover Launch projects from an earlier, unrelated automation/testing
effort (`Auto Launch File Upload ef48b`/`736d0`, `Auto Launch Project
f6737`) — one of which has 15 leftover environments and a completed (`LIVE`)
deployment with real logs. Rather than creating a new project + waiting for
a real build on every run (Launch builds can take minutes), this pipeline
**reuses that existing project/environment/deployment** (hardcoded UIDs in
`runSwaggerLaunch.ts`, not env vars — they're fixed QA-org fixtures, not
rotatable config) for every read-heavy check: Get all/one Project, Get
all/one Environment, Get all/one Deployment, Deployment Logs, Server Logs,
signed-upload/download URLs, and cache-revalidation usage.

**Real disposable lifecycle — only for Create/Update/Delete:** every run
performs an actual, real file-upload project creation: `GET` a signed S3
POST URL → build a minimal valid ZIP in-memory (hand-rolled STORE-method ZIP
writer, no archiver dependency needed — confirmed the S3 policy requires
≥1KB, so the ZIP is padded) → multipart-POST it to the signed URL with
native `FormData`/`Blob` → `POST /projects` referencing the returned
`uploadUid`, with a nested `environment` object (Launch auto-creates the
project's first environment from this, confirmed live) → `Update a Project`
→ `Update an Environment` on that auto-created environment → `finally`:
`Delete an Environment` then `Delete a Project`. **Deletes succeed cleanly
here** (`204` for both, confirmed live) — no repeat of the Lytics DELETE-403
gap. Verified after a real run that the org's project list returns to
exactly the original 3 leftover projects — no orphans left behind.

**Deliberately NOT exercised live — `Create a Deployment`:** creating a new
deployment (even on the disposable project) would trigger a real,
multi-minute build. Marked as an explicit, documented skip
(`callSkipped()`), not silently omitted — the Deployments module's read
endpoints are still fully covered via the reused, already-completed
deployment.

**Confirmed genuine finding — `Get Server Logs` returns `500`:** for the
reused (and the disposable) `FILEUPLOAD`/static deployment, Server Logs
consistently 500s (`Internal server error`), while Deployment Logs works
fine (`200`, real build-step logs). Plausible explanation: server logs only
apply to SSR/server-rendered frameworks that run an actual server process —
a static file-upload deployment has none. Recorded honestly as a real
result, not special-cased away; would need the Launch team to confirm
whether this should instead be a clean `404`/documented "not applicable"
response for static deployments rather than a `500`.

**Checked explicitly for the Lytics `x-cs-api-version` gotcha — found
clean:** this API also documents `x-cs-api-version` as optional, but
confirmed live (with and without the header) that both work identically —
no hidden requirement here.

**Coverage gap noted, not investigated further:** the OpenAPI spec declares
a `PATCH /projects/{project_uid}/git-repository` operation with no
`summary` and no corresponding doc page — surfaces as a normal
`missing_in_doc` comparator finding.

**Known lifecycle gap — standalone `Create an Environment`:** the executor
only ever creates an environment as an implicit side effect of `Create a
Project` (Launch auto-provisions the project's first environment from the
nested `environment` object) — the standalone `POST /projects/{project_uid}/
environments` endpoint (for adding a *second* environment to an existing
project) is never called directly, so it has no live execution result and
shows up as a comparator warning rather than a pass/fail.

**Region hosts:** confirmed from the doc's own "Base URLs" table —
`launch-api.contentstack.com` (US), with `eu-`/`au-`/`azure-na-`/
`azure-eu-`/`gcp-na-`/`gcp-eu-` prefixes for other regions.

## GraphQL Content Delivery API

Real Postman collection this time (`POSTMAN_GRAPHQL_COLLECTION_ID`, 90
requests), so this is the **CMA-style** pipeline (scrape → live Try Out →
Newman → 3-way compare → report), not the Swagger-executor pattern. Two
things make it structurally different from every other product line:

**The "Try Out" is a real embedded GraphiQL IDE, not the standard param
panel.** Each of the 90 examples' "Open Builder" link opens (in a new tab)
`/graphql-content-delivery-api/explorer/?title=<QueryName>` — confirmed live
via its standard GraphiQL ARIA labels (`Execute query (Cmd-Enter)`, class
`graphiql-execute-button`). It has 3 tabs (URL Parameters / Headers / Query
Parameters) with an Apply button, then the GraphiQL editor itself
pre-loaded with that example's query.

**Uses Contentstack's own public sample e-commerce stack, not our QA
stack — per explicit instruction, confirmed live.** The Explorer ships with
real, working default credentials pre-filled (`api_key: blt02f7b45378b008ee`,
`access_token: cs5b69faf35efdebd91d08bcf4`, `environment: production`) —
clicking Execute with zero configuration returns genuine sample data (e.g.
`"iPhone 7 128GB"`). Our own QA stack was tried first and ruled out: it has
no environment, no delivery token, and none of the `product`/`category`/
`article`/etc. content types these 90 examples query against (GraphQL types
are generated live from a stack's actual content model). `runNewmanGraphQL.ts`
and `tryout-graphql.spec.ts` both hardcode these sample-stack credentials —
not `CS_API_KEY`/`CS_DELIVERY_TOKEN` — so **no new secrets are needed**
beyond the Postman collection ID.

```bash
npm run graphql          # scrape → tryout → newman → compare → report, end-to-end

npm run scrape:graphql   # scrape all 90 examples across 4 modules (Queries, Retrieving Referenced Entries or Assets, Query Operators, Image Transformations)
npm run tryout:graphql   # live Try Out — navigate the Explorer, click Execute directly (defaults already work), capture the real response
npm run newman:graphql   # run all 90 Postman requests live against the sample stack
npm run compare:graphql  # doc query fields ↔ Postman query fields, + live Try Out response ↔ live Newman response
npm run report:graphql   # → reports/run-report-graphql.html
```

**Response capture had to route around canvas rendering.** The Explorer's
response panel is a Monaco editor rendered via `<canvas>` (confirmed live —
real `innerHTML`, but empty `textContent`/`.view-lines`, so DOM-scraping the
rendered response is unreliable). Both `tryout-graphql.spec.ts` and the
manual investigation instead instrument `window.fetch` (via
`page.addInitScript`, active from first paint) and read the real captured
network response directly — more robust than scraping the editor anyway,
since it's the actual API response, not a re-render of it.

**Confirmed doc/collection discrepancy — `x-cs-variant-uid` default state
differs:** the Explorer's Headers tab has this header **enabled by default**
with a real sample value for every request, but the Postman collection ships
it **disabled by default** on every request — including the two
("Get Entry List with Variants", "Get Single Entry with Variant") whose own
header description says it's required. `runNewmanGraphQL.ts` re-enables it
only for those two (`enableVariantHeaderForVariantRequests()`), same
"fix a known disabled-header issue" pattern as every other Newman runner in
this repo — but the underlying doc/Postman inconsistency is itself worth
reporting upstream.

**Scraper adapted for prose-style docs, not structured param tables.**
Unlike every REST product line, these 4 doc modules are prose + code
examples with no `Headers`/`URL Parameters` bullet lists per request — so
`scrapeAllGraphQL.ts` extracts (title, nearest GraphQL query code block)
pairs via the same flattened-DOM + nearest-heading/nearest-`<pre>` approach
used elsewhere, rather than structured `DocParam` rows. The comparator
correspondingly diffs **query field/argument sets** (via a lightweight
tokenizer, `extractGraphQLFields()` — not a full GraphQL parser, deliberately
"good enough" like this repo's existing JSON `extractKeys()` helper) instead
of REST params/headers.

**Coverage note:** 90 examples scraped vs 89 Postman requests — one doc
example has no Postman counterpart (or vice versa); surfaces as a normal
comparator coverage finding rather than being silently reconciled.

## Administration API

No Postman collection, and confirmed live that the doc's Try Out panel has
**no Send/Execute button at all** — clicking "Open Builder" just expands an
inline panel (not a new tab) showing the request's Headers/Query
Parameters/Body with their default values, purely for reference. There is
nothing to execute and nothing to compare against a collection, so this
product line is a **2-way, static-only** pipeline: scrape → compare → report
— no live Try Out phase, no Newman, no disposable test data, no auth
required at all.

```bash
npm run administration          # scrape → compare → report, end-to-end

npm run scrape:administration   # scrape doc params/headers AND the Try Out panel's fields across all 4 modules (User Session, Users, Organizations, Teams)
npm run compare:administration  # doc description ↔ Try Out panel — param/header field gaps only
npm run report:administration   # → reports/run-report-administration.html
```

**The Try Out panel's fields are read statically, never executed.**
`extractTryOut()` in `scrapeAllAdministration.ts` clicks "Open Builder",
waits for render, then reads every `input[data-param-key]`'s pre-filled
default value directly — the same technique CMA's scraper already uses to
read the panel, just without CMA's separate live-execution phase (Apply +
Send), which doesn't exist here.

**Method/endpoint extraction needed its own section-scoped fix.** Unlike CMA,
this doc page's method badge and endpoint URL are plain `<span>`/`<code>`
elements with no distinguishing class (confirmed live — just Tailwind utility
classes like `bg-docs-green-5`). An unscoped page-wide query always matched
the FIRST request on the page, silently mislabeling every other request's
method as the page's first one (e.g. "Update a team" showing as `GET`
instead of `PUT`, with an empty endpoint). Fixed by bounding the search to
each request's own section — the same heading-to-next-heading scoping
`extractParams`/`extractHeaders` already use.

**Confirmed real findings from the 3-way... well, 2-way check:** 3 of 31
requests have query parameters shown live in the Try Out panel
(`include_user_details` on "Get a single team"/"Update a team",
`includeUserDetails` + `include_count` on "Get all users of team") that are
completely undocumented in the doc's own Parameters section — including a
casing inconsistency (`include_user_details` vs `includeUserDetails` for
what's presumably the same parameter across two Teams endpoints).

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
