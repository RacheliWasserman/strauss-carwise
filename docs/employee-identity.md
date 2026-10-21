# Employee identity, greeting and representative least privilege

## Data model (migration `202610210001_employee_identity.sql`, not applied)

`advisor_employee_identities(user_id PK → auth.users, first_name, last_name, national_id, national_id_verified=false, source)`.
The national ID is self-reported and **unverified**; it is validated for format and check digit (TypeScript and a SQL
`CHECK` via `advisor_is_valid_israeli_id`). A unique index allows one account per ID.
Client roles never get the `national_id` column: `authenticated` has a column-level `SELECT` on the name columns only
(own row, RLS); `anon` has nothing. Only the service role (server) can read the ID, and the application never does.

## Flows

- **Sign-up** (`POST /api/auth/register`): strict input (no role, no metadata), server-side validation, Supabase `signUp`
  with no user metadata, then the identity row via the service role. If that row cannot be stored, the account created
  by this request (≤2 minutes old) is deleted, so a retry starts clean. An already-registered address gets the same
  answer as a new one and nothing is written. The database trigger still creates every profile as `employee`.
- **Profile completion** (`/complete-profile`, `POST /api/profile/identity`): for accounts without an identity row.
  Insert-only `SECURITY DEFINER` function through the employee's own session; changes go through support.
- **Before the migration is applied** every identity read reports `unavailable`: nobody is redirected, sign-up still
  works, and the advisor keeps asking for a display name as before.

## The name in the advisor

`FinancialDependencies.accountName` supplies the account's full name. When present it is the profile `display_name`:
never asked, never taken from chat text, a payslip, a representative or a pasted summary. A different name alone does not
force a new profile version; the next real change saves the account name (summary status "מהחשבון").
The welcome screen and the deterministic greeting use the stored first name ("שלום רחלי 👋"). Names are never sent to
a model; IDs are never sent anywhere outside the identity table.

## Representatives

- **Queue** (`GET /api/representative-requests`): name, occupation title (latest approved profile, title only) and the
  **last four** ID digits, read server-side from the generated column `national_id_last4` (the full column is never
  selected), only for requests the representative may already see. No owner IDs, salary data or messages.
- **Full ID** (`POST /api/representative-requests/{id}/national-id`): only after the explicit "הצגת ת״ז מלאה" action,
  only for the representative assigned to that request while its status is exactly `claimed`. The route checks role,
  request ID, assignment and status; the database function `advisor_reveal_request_national_id` (migration
  202610210003) checks them again under a row lock, records the access, and raises one generic error otherwise.
  Responses are `no-store, private`; every refusal has one identical body; the ID is never logged. In the browser the
  ID lives only in component memory, is hidden after a minute, and disappears when the request leaves "בטיפולי".
- Representatives receive 403 from the conversation and message read endpoints. Migration 202610210002 enforces the
  same in the database (no conversation, other messages or calculation snapshots).
- Duplicate IDs are non-enumerating: at sign-up the answer equals an ordinary sign-up (no account is created); at
  profile completion it equals any other storage failure. The validation function is not executable via the Data API.
