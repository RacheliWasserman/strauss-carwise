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

## Parser rules (`payslip-parser.ts`)

- Only values next to a known Hebrew label; evidence is the label and the printed value only.
- Pension / study fund: only the **employee** percentage (table column by header position, or
  the role word nearest the value). Employer, severance and amount-only rows never become a
  percentage; an amount-only row produces a hint ("לא חישבתי ממנו אחוז").
- Base salary is never the total gross; base + commissions + bonus above the gross is flagged.
- A one-time payment (מענק, חג, שנתי…) is never the monthly bonus; every bonus is "for review".
- Car participation is what the employee pays; the taxable car benefit (שווי שימוש) is reported
  as a hint and never used.
- Missing stays missing (never 0). Conflicting values make the field ambiguous (null + warning).
- Visual-order (reversed) Hebrew text is detected and restored, with a review warning.
- Lines with identity/bank keywords are skipped; evidence masks long digit runs.
- Every suggestion passes `checkFact` (the same range/unit validation as typed answers).

## Visual reading (`payslip-vision.ts`)

- Gemini only (`GEMINI_MODEL`, default `gemini-3.1-flash-lite`), **no fallback provider**.
- One request: the document (`inlineData`) and a fixed instruction. No chat history, no profile.
- Structured output (`responseJsonSchema`), strict Zod validation; the model transcribes label
  and value text, and the server parses and checks the number itself with the same rules.
- Enabled only when `PAYSLIP_VISION_ENABLED=true` and `GEMINI_API_KEY` are set. Disabled by
  default: images and scans then fall back to manual entry.
- Free Gemini API tier: Google may use submitted content to improve its products. Use only
  fictional payslips until a paid tier with appropriate data terms and a privacy review exist.

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
