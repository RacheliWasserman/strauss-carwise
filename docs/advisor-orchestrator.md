# Employee advisor: conversation manager and occupations

The existing assistant API calls `runAdvisorTurn` inside the existing turn lease.
There is one LLM interpretation request using the existing provider priority,
timeouts, fallback classifications and attempt limits. No extra model round,
calculator operation, profile write or representative action is introduced.

## Structured-output recovery

Provider success includes parsing and strict plan validation, not merely HTTP 200.
Previously JSON parsing happened after the provider chain returned; a malformed
primary response raised a local exception and bypassed otherwise available backups.
The real assistant-route regression test reproduced that 503 with mocked HTTP.
Parsing, schema, candidate-reference and latest-message evidence validation now run
inside each provider attempt, before state changes. Invalid provider output can
continue to the next configured provider. It is never repaired by dropping fields,
inventing values or weakening schemas. Unexpected local bugs and nonrecoverable
HTTP/authentication/security errors still stop the chain.

The protocol is JSON text with a strict application schema, not native provider
function calling. The same generated JSON-schema contract and conversation context
are sent to every provider. No unverified response-format/model setting is added.
MAX_TOKENS/length is treated as truncated output; safety blocks retain priority and
do not cause fallback. Provider timeouts and one attempt per provider are unchanged.

Safe diagnostics: carwise.ai.chain lists configured provider names;
carwise.ai.provider reports failure reason, generation/validation phase, duration,
attempt and fallbackUsed; carwise.ai.provider.result reports validated completion.
Only allowlisted schema field names/codes are logged, never raw errors or output.
carwise.ai.turn separates memory, orchestration and reply-reservation failures.
If every provider fails, the existing friendly API error preserves the employee
message without creating an assistant business answer or resetting attempt limits.
These mocked regressions do not identify the original live provider response. A
new browser request and its sanitized diagnostics are still needed to establish
the exact live failure and verify the end-to-end live fix.

## Occupations

`occupation-repository.ts` reads only the previously known `occupations` columns:
title, group_code, car_mandatory, waiver_allowed, waiver_maintenance_amount.
It uses the authenticated SSR client, without an admin fallback, employees lookup
or local occupation/demo data. Empty lists stay empty; permission/network/invalid
data failures stop occupation recommendations. The list is bounded to 200 rows
and a 201st row causes a failure rather than a false uniqueness decision.
Duplicate titles and missing/nonfinite/invalid amounts are rejected.

No existing occupation primary-key column is assumed. Each official unique title
has a deterministic SHA-256 application reference. This reference is NOT a claimed
database ID. The model sees title/reference candidates and may match masculine or
feminine wording semantically; no list of special-case profession phrases exists.
The server accepts only references in the fetched list and obtains every group,
mandatory-car flag, waiver flag and allowance directly from that record. A clear
single candidate proceeds, multiple/uncertain candidates prompt one clarification,
and a missing safe candidate offers representative clarification. Choosing from a
clarification is a separate validated operation restricted to its pending list.

An occupation match is never proof of employment or formal company verification.
Both message and card caption explain this. Every next turn revalidates the stored
match against the current occupation list. An unavailable/removed occupation cannot
leave a cached higher group in use. A changed reported occupation replaces the
match while preserving vehicle preferences.

## Structured interpretation and state

`advisor-orchestrator.ts` owns a strict plan contract: action, optional goal, and
operations to set/clear preferences, start a search, report/choose an occupation,
report a group or propose a personal fact. Each operation requires evidence quoted
from the authenticated employee's latest message. The model cannot return a group
for an occupation, an allowance, vehicle objects, a formal-verification flag, or
free-form business claims. Model references, argument types and facts are validated
by the server. Group self-reports remain preliminary and cannot override a current
occupation-derived group.

`advisor-state.ts` stores a schema version and revision, identity/conversation
scope, source-message ID, goal, preferences, reported occupation, official record
match/candidates, group provenance, pending question and personal facts pending
confirmation. The interpreter receives minimal state: candidate titles, goal,
preferences, pending question and names of supplied fact fields. Persisted salary
values and identity scope are not copied into the system instruction. Existing
conversation context still uses the bounded secret-redaction path.

The existing filter accumulator is reused, with validated explicit operations
applied as updates. This supports natural-language changes without adding phrase
conditions. The existing catalog service, official group-order filtering, family
checks and card builder remain the recommendation path. Missing values are never
made zero. No employee-data version is created or confirmed in this stage.

## Durable storage and compatibility

Business state is stored as `metadata.carwise_ai.businessState` on the employee
source message, through the existing server-only compare-and-set update. It is
reserved with the ready reply, retained while saving, and committed with the
existing complete marker. `TurnStore.memory()` reads the newest completed business
snapshot with owner, sender and conversation predicates, independently of the
60-message conversation window. Invalid or foreign snapshots fail closed.

An uncertain assistant append follows the existing reconciliation behavior; it
does not generate a second answer or publish uncommitted business state as current.
Completed duplicate requests return the original saved message. There is no new
table, migration, permission grant, or authentication flow. Messages/cards keep the
existing `carwise.catalog.v1` body; its groupSource now also supports
occupation_match. Legacy plain text and saved filter-only messages remain readable.
Legacy occupation-derived groups without a matching business snapshot are not
trusted as a revalidated occupation.

## Local tests and browser acceptance

Offline tests cover the real API/Google SDK path with mocked HTTP, durable-state
storage, duplicate turns, scope isolation, permission failures, invalid occupation
rows, semantic-plan contracts, ambiguity and selection, changed official group,
changed profession, preference updates and state reload with no original history.
They do not verify the live occupations SELECT policy, actual live title/group
mapping, or a live model's interpretation quality.

Browser: start a new employee conversation with
`אני מפתחת תוכנה ומחפשת רכב חשמלי`.
If the official visible occupation list has the matching role with group B,
the response should show only electric active vehicles from A/B, without asking
the group. Then send `בעצם אני רוצה היברידי`, refresh, reopen and continue.
Also try an ambiguous title and an absent title; the latter must offer clarification
with a representative without claiming a request was opened. If the occupation
list is inaccessible, the response must explain that rather than bypassing RLS.
