# Payslip extraction (העלאת תלוש שכר)

The employee can upload a payslip from the chat composer. The server suggests up to seven
calculator fields; the employee reviews them; the reviewed values enter the **existing**
financial flow as pending values and are saved only through the existing approval code.
Nothing is ever calculated from unreviewed or unapproved extraction output.

Code: `src/lib/payslip/`, route `POST /api/conversations/[conversationId]/payslip`,
UI `src/components/chat/payslip-upload.tsx`.

## Formats and where they are processed

| Input | Detection | Processing |
|---|---|---|
| Digital PDF | `%PDF-` + extractable Hebrew text | Local: `unpdf` (pdf.js) text with positions → rows/cells → parser |
| DOCX | ZIP + `word/document.xml` + Word content type | Local: own ZIP reader (`zlib` with output cap) and tag scanner; table rows keep their cells |
| Scanned / image-only PDF | PDF with too little text | Google Gemini, only with per-upload consent and when enabled |
| PDF whose text has no payslip fields | parser finds nothing | Visual reading is offered (consent), else manual entry |
| JPG / PNG / WEBP | magic bytes | `sharp`: decode, EXIF rotation, resize ≤2200px, re-encode JPEG (metadata dropped) → Gemini with consent |
| Legacy DOC, password-protected Office | OLE signature | Rejected: "save as DOCX or PDF" |
| HEIC, macro-enabled DOCX, other | signature / content types | Rejected with a clear message |

Limits: 4MB body (read with a hard cap, never buffered beyond it), 5 PDF pages, 40MP images,
15s local processing, 30s visual reading, 10 uploads per employee per 10 minutes (per instance).

## Architecture: candidates, then shared rules (`payslip-rules.ts`)

Every reader only collects **candidate rows** (printed label, printed value, page, and whatever
structure it knows: column, section, period). One shared rule set decides for all of them:
which candidates may be a field (label vocabulary in Hebrew and English, labels of other
components that are never the field, sections a field is never printed in, cumulative figures,
employee vs employer, bonus recurrence), and `resolveField` decides each field: one supported
value (however many rows repeat it), nothing (with the most informative refusal as the reason),
or **ambiguous** when the evidence conflicts. No amounts, employers, templates or row positions
are part of the rules.

- Bonus recurrence comes from printed words: one-time words (חד פעמי, חג, שנתי, רבעוני,
  הפרשים, annual, one-time…) exclude a row; recurring words (חודשי, קבוע, שוטף, monthly,
  fixed…) establish it ("זוהה"); "מענק" without a recurring word is one-time; otherwise the
  row is suggested for review. A reader's claim of "recurring" alone never establishes it.
  Each bonus row is judged on its own, so a one-time grant never hides a recurring bonus;
  two different recurring bonuses are ambiguous (never added up).
- Numbers: dates ("07/2026"), codes glued to letters and integers with a leading zero ("00",
  "05" — codes, date parts or values cut off at the page edge) are never amounts.
- Document titles and page numbers ("דוח שכר… עמוד 2 מתוך 2") are never a field's row.

## Parser rules (`payslip-parser.ts`)

- Only values next to a known label; evidence is the label and the printed value only.
  Exclusions are judged on the row's own label (up to its first digit), not on the whole line,
  so a table printed beside it cannot veto or contaminate it.
- Single-column / card layouts: a line of labels directly followed by a numbers-only line of the
  same width is paired by column (and by x position in PDFs); such values are always for review.
- Pension / study fund: only the **employee** percentage (table column by header position, or
  the role word nearest the value). Employer, severance and amount-only rows never become a
  percentage; an amount-only row produces a hint ("לא חישבתי ממנו אחוז").
- Base salary is never the total gross; base + commissions + bonus above the gross is flagged.
  A gross-up (גילום) and taxable gross (ברוטו למס / חייב במס) are never the base salary.
- Tax credit points: "נקודות זיכוי" / "נק׳ זיכוי", and the abbreviation נ״ז / נ.ז (always "for
  review"). A credit row with more than one candidate number (e.g. 2.75 and 2.92) chooses none.
- Severance rows (פיצויים) without an employee word are never the employee's pension rate.
- Car participation is what the employee pays; the taxable car benefit (שווי שימוש) is reported
  as a hint and never used.
- Missing stays missing (never 0). Conflicting values make the field ambiguous (null + warning).
- Visual-order (reversed) Hebrew text is detected and restored, with a review warning: either
  reversed letters ("דוסי רכש") or reversed word order per cell ("יסוד שכר"). The reading with
  the most recognized labels wins; a repaired reading puts every value up for review.
- Current month only: cumulative rows (מצטבר / מתחילת שנה) and year-to-date table columns are
  skipped (by x position in PDFs, by position from the row's end in DOCX).
- Car participation never comes from a line about the car benefit, gross-up (גילום), imputation
  (זקיפה), fuel, or a total that includes the car ("סך ניכויים כולל השתתפות רכב").
- "שכר משולב" is accepted as base salary for review only.
- Conflicting values for a field give no value and `ambiguous: true` ("לא ניתן לקבוע בוודאות").
- Lines with identity/bank keywords are skipped; evidence masks long digit runs.
- Every suggestion passes `checkFact` (the same range/unit validation as typed answers).

## Visual reading (`payslip-vision.ts`)

- Gemini only (`GEMINI_MODEL`, default `gemini-3.1-flash-lite`), **no fallback provider**.
- One request: the document (`inlineData`) and a fixed instruction. No chat history, no profile.
- Structured output (`responseJsonSchema`), strict Zod validation; the model transcribes label
  and value text, and the server parses and checks the number itself with the same rules.
  A transcribed 0 is kept only beside the field's own label (never as a filler); credit points
  read as shekels or above 20 are dropped.
- **Candidate contract:** the model lists every printed row that is, or could be mistaken for, a
  field — several rows per field, near-misses included (a one-time grant beside a monthly bonus,
  the employer column, the car benefit, cumulative values) — with `page`, `section`,
  `label_text`, `value_text`, `normalized_value` (a cross-check only: it must equal the server's
  parse of `value_text`), `period`, `column`, `unit` and bonus `recurrence`. It never chooses;
  the shared rules do. Up to 40 rows.
- Why: the earlier contract allowed one row per field. On the live complex fixture the model
  reported the one-time grant (3,500) as the bonus, the server correctly refused it, and the
  recurring 1,000 beside it had no way to reach the server (2026-10-21).
- Enabled only when `PAYSLIP_VISION_ENABLED=true` and `GEMINI_API_KEY` are set. Disabled by
  default: images and scans then fall back to manual entry.
- Free Gemini API tier: Google may use submitted content to improve its products. Use only
  fictional payslips until a paid tier with appropriate data terms and a privacy review exist.

## Review form (`payslip-review-form.ts`, `payslip-review-row.tsx`)

- Each read value fills its editable field as a plain number (6,000 → `6000`, 2.75 → `2.75`) and
  is also printed as text ("הערך שנקרא"), so the row is never read as "לא ידוע" by text-only
  readers (screen readers, page-text tools); each "לא ידוע" checkbox is named for its field.
- A field that was not read stays empty and is left out of the reviewed message.
- Row states: "זוהה בתלוש" (clear), "דורש בדיקה" (candidate to check), "לא נמצא בתלוש" (not
  printed), "לא ניתן לקבוע בוודאות" (conflicting evidence, no value). Nothing is approved here.

## Golden fixtures

`tests/fixtures/payslips/complex-*.{pdf,png}` (synthetic, supplied 2026-10-21) with the expected
values in `complex-golden.json`; tests in `tests/payslip-complex.test.ts`. PDF tests read the real
bytes; image tests use mocked Gemini output and do not prove live Vision accuracy.

Diverse layouts: `tests/fixtures/payslips/layout-*` (generated from `source/layout-*.html` by
`generate-layout-fixtures.mjs`) with values and review states in `layout-golden.json`; tests in
`tests/payslip-layouts.test.ts`. Cards (label above value), YTD table with English labels,
two pages, and an abstention fixture with conflicting evidence; plus a portal screenshot, a
sideways phone photo and a scan without a text layer for the (mocked) visual path.

## Handoff into the advisor

The review screen sends one employee message, `carwise.payslip-review.v1`: the extracted values,
the employee's values (number, `'unknown'`, or omitted), and an HMAC (`payslip-provenance.ts`,
key derived from `SUPABASE_SECRET_KEY`, 1-hour validity) over the extraction, employee and
conversation. The advisor (`payslip-handoff.ts`), without a model:

- unchanged + verified → pending value with source `payslip` ("מתלוש");
- edited + verified → source `corrected` ("תוקן על ידי העובדת");
- filled manually, `manual` form, expired or unverifiable → ordinary employee value;
- `unknown` → withheld (disputed if confirmed before) and offered to the representative.

The active goal (cars or waiver) is untouched and resumes after approval, as before. The chat
shows the message as a readable sentence; model context receives the same sentence, never JSON.

## What is never stored or logged

The file exists only in memory for the request: not in Supabase Storage, the database, the
conversation or on disk. Logs contain outcome, method, field count, consent flag and duration
only. The reviewed values are stored in the conversation like typed answers (and are therefore
visible to a representative who claimed a request in that conversation, the existing limitation).

## Fixtures

`tests/fixtures/payslips/` holds fictional payslips (HTML sources, digital PDFs, screenshot,
rotated photo, WEBP, scanned PDF, DOCX). Regenerate with
`node tests/fixtures/payslips/generate-fixtures.mjs` (needs Chrome or Edge).
