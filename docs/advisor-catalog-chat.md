# Stage 2: closed company catalog in employee chat

The current assistant entry point is now the conversation manager described in
[advisor-orchestrator.md](advisor-orchestrator.md). The catalog implementation below
is reused as its validated recommendation service. Its earlier group-only intake
is superseded by occupation resolution and durable business state on the API path.

The authenticated assistant route and existing turn reservation/append RPC remain
the entry point. Identity, source-message ownership, latest-turn validation, rate
limits and uncertain-commit reconciliation run before/around the catalog advisor.
No new API permissions, tables, migration or direct assistant insert are used.

## Data flow

The existing provider chain receives the bounded, secret-redacted conversation
with a dedicated instruction to return a strict search plan. It cannot supply
employee-group facts, vehicle IDs, card objects, monetary values or displayed
prose. Invalid JSON or unknown fields fail closed with the existing friendly
assistant error. There is no second model request or extra retry loop.

`catalog-advisor.ts` validates this untrusted plan and reads active catalog pages
through `searchAdvisorVehicles`, using its existing authenticated SSR client and
RLS. Card names, manufacturers, groups, propulsion and IDs come exclusively from
that service. No demo employee data, tax data, internet search or calculator is
used. No model-generated prose is displayed, even on noncatalog branches: a small
set of Hebrew server-authored replies handles introductions, clarification and
general explanations. This intentionally bounds conversational flexibility in
exchange for enforcing the closed-catalog guarantee in code.

## Group and family checks

The existing confirmed employee-version schema does **not** contain an employee
eligibility-group field. No group is guessed from an occupation title. Explicit
employee group statements are tracked in this conversation only, with provenance
`employee_reported`; they are never saved as confirmed employee data or called
official eligibility. A bare group letter is accepted only after a group question.
A requested vehicle group is a search filter, not an employee-group declaration.
Representative messages are never treated as employee self-reports.

The existing `getCalculationRules` repository supplies the one active official
rules record. It already uses its server-only rules client; no salary or employee
data is read through that privileged client. The advisor validates groupOrder and
uses its order to exclude higher vehicle groups, without budgets or net arithmetic.
Family cards additionally require an own, confirmed employee version's child count
meeting the rule threshold and membership in the rules' family vehicle-ID list.
Missing child data is never zero. These are preliminary catalog filters, not the
calculator's final eligibility/financial result. No calculator logic is modified.

Unknown group prompts one question; an employee who does not know their group is
offered representative clarification. No representative request is created
automatically and no UI claims that one was created. Intake and representative
request actions remain a later step.

## Persistence and presentation

The existing assistant RPC accepts a body string only. A validated, versioned
`carwise.catalog.v1` JSON envelope in that body stores the Hebrew text, up to six
verified catalog-card snapshots, timestamp, rule version and continuation state.
It fits the existing 6,000-character turn-state reservation limit and follows the
existing ready/saving/complete and at-most-once append flow. No migration is needed.
Legacy plain-text assistant messages still render normally. Employee-written JSON
is never rendered as catalog cards. Cards render as escaped React text without
HTML, model links or images. The model context uses only the envelope's text.

Historical cards remain snapshots from the recorded date, visibly labeled as such;
refreshing history does not claim that a previously offered vehicle is still
active. Every new catalog answer reads the current active catalog again. Each
answer shows at most six cards; bounded keyset traversal checks up to 20 pages of
50 vehicles and explicitly qualifies partial searches. When a named vehicle is
absent, the reply offers to change filters to search for alternatives; it never
silently drops manufacturer/model constraints. A catalog failure discards partial
results and produces no cards.

## Persistent search preferences

`catalog-search-state.ts` merges saved filters on every turn, including general
clarification turns, not just while awaiting an employee group. A group-only answer
cannot change any search filters even if the model returns contradictory fields.
Explicit Hebrew electric/hybrid/petrol preferences are normalized and applied on
the server independently of model output. A propulsion change updates that field
while keeping manufacturer/model constraints. Explicit manufacturer/model updates
replace the corresponding fields; omitted fields remain unchanged. An explicit
`חיפוש חדש` resets the search constraints without resetting the reported employee
group. Explicit requests such as `כל סוגי ההנעה`, `כל היצרנים` or
`לא משנה לי הדגם` remove the corresponding constraints.

The full accumulated filter set is supplied to the authenticated catalog service
on every page and is checked again before constructing any cards. Existing stored
message bodies are not rewritten. For earlier conversations whose snapshot omitted
propulsion, an explicit preference can be recovered from the available own employee
history, respecting new-search/removal boundaries. This cannot recover messages
outside the bounded history window. New snapshots persist the filters along with
the exact returned propulsion values; refresh never regenerates or changes cards.

## Verification and manual acceptance

Local tests mock provider/database boundaries, including the real assistant API
path and Google SDK serialization. They cover group-order changes, higher groups,
family requirements, missing/foreign child data, pagination, unavailable catalog,
strict model plans, card serialization, repeat requests, authentication and provider
fallback with shared instructions. Tests do not establish live rule-record shape,
provider structured-output compliance, browser layout or live RLS permissions.

Manual browser flow: ask for an electric vehicle; answer the group question with
`אני בקבוצה ב`; confirm only catalog cards from permitted groups appear; refresh
and reopen the conversation. Try a nonexistent model, an explicitly higher group,
an unknown employee group and the family track without confirmed child data.
No migration or environment-variable changes are required for this stage.
