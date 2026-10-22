# "הפרופיל שלי" (employee profile page)

Route `/profile` (`src/app/profile/page.tsx`, `src/components/profile/`). Entry point: the sidebar item
"הפרופיל שלי", directly above "שיחה חדשה" on every employee page (chat, catalog, Match, profile).

## One record

The page edits the same record the chat approves: a new **confirmed** version of
`advisor_employee_data_versions`, written with the existing repository functions
(`createEmployeeDataVersion` + `confirmEmployeeDataVersion`, i.e. the same RLS insert policy and the
`advisor_confirm_employee_data_version` function). Manual entry and payslip upload fill one form and save
one version. There is no second profile table and no schema change.

- Every stored field is NOT NULL, so an empty field is a validation error, never a silent 0. The form
  opens with the latest confirmed version, so untouched fields are saved again unchanged.
- Nothing is written when the values equal the approved profile (`unchanged`).
- Optimistic concurrency: the save carries `basedOnVersionId`. If a newer version was approved meanwhile
  (e.g. in the chat), the server answers 409 with the current version and writes nothing.
- The name is the account's stored name (`advisor_employee_identities`), read-only on the page. Only when
  no identity is stored (migration 202610210001 not applied) does the form ask for first and last name.

## Role (occupation)

A searchable combobox over the official `occupations` list (`listAdvisorOccupations`, the same source the
eligibility engine uses). The form sends the occupation **key** (the application's SHA-256 reference of the
unique official title — no DB id column is assumed, see `docs/advisor-orchestrator.md`); the server resolves
it against the live list and stores the official title in `occupation_title`, the column every eligibility
path joins on (chat, catalog, Match). Free text can never be saved. An empty/failed list blocks saving with
an explanation and a retry.

## Payslip

`POST /api/profile/payslip` runs the same extraction as the chat (`runPayslipUpload` in
`src/lib/payslip/payslip-upload-request.ts`, shared with the conversation route: same limits, consent and
logging rules; one upload limit per employee across both). The reviewed values fill the form, marked
"מהתלוש"; nothing is saved until the employee presses "שמירת הפרופיל".

## Save API

`POST /api/profile` — employee session only, same-origin, strict schema (`profileSaveSchema`), logs the
outcome only (never values).
