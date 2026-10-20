# Employee financial flow: collection, approval, calculation

The advisor turn (`runAdvisorTurn`) now continues from catalog recommendations into an
authenticated net-salary comparison. The LLM still returns only a structured plan; every
business value comes from the server. Implementation: `src/lib/ai/financial-flow.ts`.

## Turn routing

A turn is financial when the goal is `net` or `waiver`, the employee reported a financial fact,
selected vehicles, pressed an approval button, or the previous question was financial.
The catalog is shown again only when the search changed or nothing was shown yet.
A new conversation carries over only the occupation of the latest **approved** profile,
revalidated against the official occupations list.

## Vehicle selection (`vehicle-selection.ts`)

Naming a catalog model is a **choice**, not a search. The orchestrator resolves a selection from:
model names/IDs written in the message (matched against the active catalog's own display names and
IDs, longest name wins), the model's `select_vehicles` (IDs only if shown or written; `names`
resolved against the catalog), `compare_all`, or a model `name` filter, which is consumed and
never kept as a search filter. A name matching several catalog cars asks one short question with
quick replies. The car the employee drives today (pending fact or approved profile, or an answer
to the current-car question) is never selected.

Eligibility is checked at selection with the official group order (family cars only from the
family list; children are enforced by the calculator). Ineligible → plain explanation and eligible
alternatives of the same drive type, previous selection kept. Occupation unknown → stored as
`vehicleInterest`, only the occupation is asked, then validated and promoted. Selected →
`selectedVehicleIds`; without a net request the reply acknowledges and asks one question (net
impact or another car, `pendingQuestion: next_step`); with a net request the financial flow
continues with its single next question. Re-naming the already-selected car changes nothing.
Only drive/manufacturer/group changes or a new search clear the selection. Card buttons send
`אני רוצה את <name> (<id>)` through the same path.

## Facts (conversation state only)

Model operations: `report_fact`, `unknown_fact`, `report_current_vehicle`, `select_vehicles`,
`compare_all`, `request_representative`. Each needs an evidence quote from the latest message.

`checkFact` accepts a numeric value only if it literally appears in that quote
(`18,000`, `18 אלף`, `2.25`, `2 וחצי`, simple Hebrew number words), or is 0 with an explicit
negation (`אין לי בונוס`). Percent fields reject shekel amounts and vice versa; a salary below
1,000 is treated as ambiguous. A rejected value produces a clarification and stays missing.
"I don't know" is recorded in `unknownFacts` and is never zero. Schema `.default(0)` values are
never used: the version input is built from explicit values only.

The current car is resolved only against the active catalog. `NONE` (no company car) is the
waiver baseline, matching `resolveCurrentVehicle(null)` and the reference worksheet.

## Readiness

`advisor_employee_data_versions` requires every field (NOT NULL), so a version can only be written
for a complete profile: occupation, base salary, commissions, bonus, credit points, pension %,
study-fund %, current car (or none), current participation (derived 0 when there is no car),
children up to 23, and display name.

## Conversation style (server-enforced)

Exactly one missing field is asked per turn (`nextQuestion`; a dependent field such as current
participation waits for the current car). `state.pendingField` always names the question on screen
and is cleared when the flow moves to approval, selection, calculation or leaves the financial goal.
A short direct answer to that question ("18 אלף", "0", "אין לי", "לא יודעת") is understood by the
server even when the model returns no operation, through the same evidence/range checks.
Several facts in one message are all stored; then only the next missing question is asked, after a
brief acknowledgement. A clarification that is itself a question replaces the next question, so a
turn never carries two. After the third consecutive ask of the same field a representative is
offered, so collection cannot loop.

Ordinary replies do not mention group codes, the occupations table, matching or verification.
The "employee-provided, not verified by payroll" statement appears once, in the approval summary;
a self-reported group stays labelled as not an eligibility confirmation. Result explanations list
up to three calculator-derived factors, most significant first (lost/gained waiver allowance,
value of use, electric benefit, participation, family share).

## Approval

The proposal = latest confirmed version + pending facts + matched official occupation, with each
row marked confirmed / new / changed / derived. Its code is a SHA-256 of the exact values **and**
the confirmed version it is based on. The approve button sends `…#CODE` as an ordinary employee
message. The server (not the model, which is not called for code messages) approves only if the
code equals both the pending code and the recomputed code. A changed value or a concurrently
confirmed version produces a new summary and writes nothing. On approval it reuses its own
matching unconfirmed draft (retried turn) or inserts a draft, then confirms it through
`advisor_confirm_employee_data_version`. Free-text "yes" never approves.

## Calculation

`toCalculatorEmployee` / `toCalculatorOccupation` adapt the confirmed version and the official
occupation row to the existing calculator types. Vehicles are read by ID from the active catalog
with the session client (`getActiveVehicleRowsByIds`) and converted by the existing
`toCalculatorCar` (official tax value; a missing or duplicate record stops only that car).
Baseline = profile's current car with its participation, or waiver. An ineligible baseline
(e.g. waiver for a car-mandatory occupation, or a car above the group) is explained and offered
to a representative. Alternatives use `eligibility` and `calculateNet` unchanged; up to three
shown cars are calculated automatically, otherwise the employee chooses.

Displayed delta = displayed alternative net − displayed baseline net (the worksheet convention).
The six reference cases pass through this path in `tests/employee-financial-flow.test.ts`.

## Snapshots

`createCalculationSnapshot` stores the calculator-format employee, occupation, full rules,
vehicle snapshots with tax values, baseline and results, linked to the confirmed version.
The idempotency key (profile version, rules version, calculator version, baseline, vehicles,
waiver) is checked in conversation state and then in saved history, so repeats and retried turns
do not duplicate runs. Older runs stay untouched when the profile changes.

## Representative

The server offers a request with a `#R…` code button; the request is created only when that
button is pressed, through the existing RLS-protected insert. A duplicate active request is
reported as existing.

## Live checks still required

Authenticated SELECT of full `vehicle_catalog` columns by ID; draft insert + confirm RPC;
snapshot RPC; representative insert; a browser run of the acceptance conversation.
