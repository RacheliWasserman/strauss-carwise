# Stage 1 — authenticated read-only vehicle search

`GET /api/advisor/vehicles` requires the existing authenticated `employee` role.
Anonymous requests receive 401; representative accounts receive 403. The API
uses the cookie-scoped Supabase SSR client, so SELECT is subject to that user's
existing vehicle_catalog grants/RLS. There is no admin/anonymous fallback and
no employee/demo lookup. No write operations, AI calls or calculations occur.

## Query contract

| Parameter | Behavior |
| --- | --- |
| name | Case-insensitive literal substring of display_name; max 120 chars |
| manufacturer | Case-insensitive literal substring of manufacturer_name; max 120 chars |
| group | Exact group_code: א, ב, ג, ד or existing משפחתי |
| driveType | Exact drive_type text from the catalog; max 60 chars; no invented enum |
| limit | Integer 1–50, default 20 |
| afterId | Optional text ID cursor from nextCursor; max 200 chars |

No parameters (or a trailing `?`) means the first active page, limit 20. Omitted
optional fields stay absent; explicit empty/invalid values are not defaulted.
`q` is NOT a supported parameter. For a manufacturer use
`/api/advisor/vehicles?manufacturer=Toyota`; for a model name use `name=...`.
The contract intentionally does not add an ambiguous cross-field q search.
Invalid-query responses include code INVALID_VEHICLE_SEARCH_QUERY and filtered
issues (field/reason only). Unknown names and input values are never echoed.

Local regression checks confirm an empty query was already valid in the schema;
the reported browser 400 for an actually parameter-free URL has not been
reproduced. Restart the current server and inspect the new response code/issues
if it persists, rather than assuming a database or RLS failure. Query parsing
fails before any catalog query, so changing RLS cannot fix this particular 400.

All supplied filters are combined with AND. Omitted filters do not restrict that
field. Blank, unknown or repeated query parameters are rejected with 400. LIKE
wildcards %, _ and backslash are escaped as literal search characters; the
repository never constructs an OR expression from user text. Group filtering
is NOT a determination of the employee's entitlement.

Example URL (manual authenticated browser usage only; not executed here):

`/api/advisor/vehicles?name=Model&manufacturer=Example&limit=10`

Only active rows are queried, ordered by database ID ascending. The repository
uses limit+1 lookahead and an ID keyset cursor, rather than fetching the entire
catalog or silently choosing one of multiple same-name vehicles.

## Response

```json
{
  "vehicles": [
    {
      "id": "EXAMPLE-ONLY",
      "display_name": "Fictional Model",
      "manufacturer_name": "Example Manufacturer",
      "group_code": "א",
      "drive_type": "חשמלי"
    }
  ],
  "match": "single",
  "hasMore": false,
  "nextCursor": null
}
```

This example is fictional, not an actual catalog entry. Runtime IDs come only
from database rows, are preserved exactly, and are not synthesized from names.
No company costs, employee participation, tax codes, prices, salary or internal
metadata are exposed. No claim is made about pricing, eligibility or inventory.

`match` is none/single/multiple for the current page plus its lookahead, NOT a
global total. An empty successful query returns vehicles:[] and match:none.
With limit:1 and another matching row, match:multiple and hasMore:true still
indicate the ambiguity. Follow nextCursor as afterId to read the next page.

Required returned fields are validated; active must be true, IDs must be unique
within the page and IDs cannot be changed by trimming. Missing/invalid records
(including lookahead) fail the request closed with HTTP 503 and
VEHICLE_CATALOG_INVALID_DATA, not fictional defaults or silently incomplete
results. Fixing catalog data remains a separate authorized task.
Repository/auth/network failures return a generic 503 VEHICLE_CATALOG_UNAVAILABLE
without raw errors, SQL or row data. All API responses use private,no-store.

## Compatibility and verification

The existing vehicle-repository now shares its active/query-order builder
between the unchanged public getVehicles() contract (legacy client and select*)
and the new searchVehicles(authenticatedClient, filters) path (explicit public
projection). Calculator conversion and official-tax lookup were not changed.
The chat, demo endpoints, authentication policies and migrations were not edited.

Local tests mock database/auth boundaries and verify session-client use, no
privileged fallback, projections, each filter, literal wildcard escaping,
pagination/ambiguity, invalid rows, query errors and API access control.
Actual deployed table schema, SELECT privileges and RLS have NOT been verified
live. RLS can legitimately hide every row and return an empty array; this cannot
be distinguished from a truly empty visible catalog by bypassing RLS. Deployment
readiness requires a later explicitly authorized authenticated read check.

Next stage, only after approval: connect this endpoint/service to bounded AI
catalog actions and chat cards. Employee intake, eligibility, representative
handoff and net calculations are not part of stage 1.

### Runtime query investigation

`node scripts/check-catalog-next.cjs` starts an isolated local Next.js dev server
with the real route, validator and middleware. Only authentication and catalog
boundaries are replaced with fixtures; no environment files or Supabase are used.
It checks real HTTP requests: no query and manufacturer search return 200;
unsupported q and an empty explicit limit return 400. It prints parameter names,
status and sanitized issues only. This covers Next.js compilation/HTTP handling,
which direct handler unit tests do not cover, but does not reproduce the user's
authenticated development process or browser.

The reported parameter-free unknown_parameter failure is still not reproduced.
The parser uses URLSearchParams iteration, not Object.fromEntries; the API
middleware adds no query parameters. Rejected queries now produce a server-side
`[carwise.catalog.query]` diagnostic with bounded ASCII parameter names and
sanitized issues, never values, headers, cookies or full URLs. To investigate the
remaining discrepancy, open the parameter-free endpoint once in the affected
process and inspect that diagnostic. Do not ignore unknown parameters based on
an assumption about Next.js internal parameters.
