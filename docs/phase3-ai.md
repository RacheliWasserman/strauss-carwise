# Phase 3: conversational AI with ordered provider fallback

## Current Gemini deadline correction

The owner supplied an actual chat rejection with `detail: deadline_too_short`.
Gemini now uses `AI_LIMITS.geminiTimeoutMs = 20000` for BOTH the Google SDK
httpOptions.timeout and the outer provider cancellation timer. The SDK therefore
sends `X-Server-Timeout: 20`. Groq/OpenRouter retain 7000 ms each. One fully
stalled chain is bounded to 34 seconds (20 + 7 + 7), not 60 seconds.

The existing assistant route maxDuration remains 60 seconds, the generation
lease remains 90 seconds, and the turn-attempt limit remains three. Only the
browser assistant request now waits up to 50 seconds so it can receive the end
of the fallback chain plus normal database overhead. Other chat requests retain
their 30-second client timeout. Database/network overhead is not itself bounded
by provider timers; existing uncertain-save recovery remains unchanged.

Temporary 504/timeouts still fall back, and HTTP 400 (including a future deadline
rejection) still stops. No automatic cap reset or retry was introduced. Local
tests inspect the actual SDK header, simulate all three deadlines, and verify
API/client/lease budget headroom. No live AI or database call was made.

Older diagnostic scripts explicitly testing 7/10-second comparisons remain
historical controls; they do not set the current production chat deadline.

This change connects the existing employee chat to real server-side generation.
No live provider request or Supabase action was performed during implementation.
The calculator, authentication policies, existing RPCs and installed migrations
are unchanged. The official `@google/genai` SDK is installed; Groq and OpenRouter
use their documented OpenAI-compatible HTTP endpoints without additional SDKs.

## Server configuration

The three server-only credential variable names are documented as empty slots in
`.env.example`. Never prefix AI credentials with NEXT_PUBLIC_. Existing secrets
are not copied into source, tests or build output. Model overrides are optional:

| Priority | Provider | Default model | Override |
| --- | --- | --- | --- |
| 1 | Gemini | gemini-3.5-flash-lite | GEMINI_MODEL |
| 2 | Groq | openai/gpt-oss-20b | GROQ_MODEL |
| 3 | OpenRouter | google/gemini-3.1-flash-lite | OPENROUTER_MODEL |

Model defaults were selected from official provider documentation, not a live
model-list request. Availability, billing, account permissions and Hebrew answer
quality must still be checked with the owner's approval. Restart Next.js after
saving server environment changes. Missing/whitespace-only providers are skipped.
If every provider is missing, generation fails before consuming a turn attempt.

Sources:
- https://ai.google.dev/gemini-api/docs/models
- https://console.groq.com/docs/models
- https://openrouter.ai/google/gemini-3.1-flash-lite
- https://googleapis.github.io/js-genai/release_docs/interfaces/types.HttpRetryOptions.html

## Request flow and security

1. The existing conversation/message endpoint saves the employee's text first.
2. The UI then POSTs only `{ messageId, statusOnly: false }` to
   `/api/conversations/:conversationId/assistant`. It does not send prompt text,
   system instructions, owner UUIDs, provider selection or credentials.
3. The route authenticates the session, requires the employee role and rejects
   foreign browser origins, invalid/extra payload fields and oversized bodies.
4. User-scoped Supabase reads verify conversation ownership and an employee
   message authored by the authenticated user in that conversation. Only the
   latest employee turn may start a new generation. No demo or payroll records
   are queried. Assistant replies already saved are returned without generation.
5. A conditional old-value UPDATE of the source message's existing metadata
   reserves a generation attempt. A separate conditional update on the existing
   advisor profile implements a durable per-user cooldown.
6. At most 24 recent messages / 16,000 characters / 4,000 characters per message
   are sent. The newest source turn is included once. Only role/text are sent,
   not metadata, tokens, DB IDs, profile objects or API keys. Common credential
   formats and known configured credentials are redacted. This is not universal
   DLP; users should never paste credentials into messages.
7. Each configured provider gets one attempt: Gemini has a 20-second deadline;
   Groq and OpenRouter each retain a seven-second deadline.
   Google SDK retry attempts are explicitly set to one. Network failures, 408,
   429 and transient 5xx move to the next provider. Authentication, authorization,
   invalid-request/model errors, safety filtering and internal code/storage
   failures do not trigger provider fallback. An empty provider response may fall
   back; an explicit safety refusal may not. OpenRouter's internal fallback is
   disabled, preserving the application's bounded attempt policy.
8. Every provider receives the same Hebrew system instruction and conversation
   context. User/representative messages remain untrusted conversation data.
   There are no calculator, SQL, browsing or action tools exposed to the model.
   The prompt prohibits invented salary, tax, pricing, eligibility and company
   policy. A conservative output guard replaces numeric or explicit entitlement
   claims with a truthful explanation of the current calculation limitation.
   This guard is defense in depth, not a proof that model prose is factual.
9. The selected reply is cached in source metadata. A durable `saving` reservation
   is acquired before calling the existing authenticated server wrapper for
   `advisor_append_assistant_message` with the server service role. This is the
   only assistant INSERT path; the browser never writes an assistant body.
10. The saved assistant row is returned and merged into the current thread by ID.
    Page reload reads the same saved messages. Thinking and AI retry states are
    separate from employee-message persistence. A provider failure does not
    resend or delete the employee message.

## Concurrency, retries and known tradeoffs

`carwise_ai` metadata uses a validated state machine: generating → ready → saving
→ complete, or generating → failed. Compare-and-set compares the entire previous
JSON value, preserves unrelated metadata and filters owner/conversation/sender.
A worker that loses its token cannot publish a late model result. Generating
leases last 90 seconds; stale generation can be retried at most three times per
turn. Completed/ready replies never call a model again. UI status polls explicitly
set `statusOnly: true` and do not initiate paid generation retries.

The existing append RPC has no idempotency parameter or transaction shared with
the metadata update. Therefore this implementation guarantees at-most-one append
attempt per reserved turn, rather than claiming transactional exactly-once
completion. If the RPC response is lost, a retry looks for exactly one matching
saved assistant reply after the source and before the next employee turn, within
the latest 100 messages. It marks a found reply complete. If there is no unique
match, it fails closed and does not repeat the INSERT. A server crash after the
`saving` reservation but before the RPC can therefore leave a turn requiring
manual diagnosis. Automatic recovery of every such case requires a future
atomic idempotent RPC; no installed migration was changed in this task.

Rate limits combine eight new generation attempts per minute per user in each
Node process, a durable three-second per-user cooldown across processes, and
three attempts per turn. The eight-per-minute counter is not distributed; the
cooldown and turn reservations are. This is bounded hackathon protection, not
a replacement for production gateway quotas and provider account spend limits.

Coordination relies on existing service-role UPDATE/SELECT privileges for
advisor_conversation_messages.metadata and advisor_employee_profiles.updated_at.
No grants or RLS policies are changed. If those privileges are absent in the live
project, coordination fails before contacting providers. Verify via authorized
runtime testing; do not bypass failures by weakening authenticated permissions.

## Verification performed and browser checklist

### Diagnosing a 503 safely

#### Isolation audit (2026-10-19)

The installed SDK is `@google/genai` 2.30.0. Transport-mocked isolation tests
incrementally exercise: one user turn; system instruction; maxOutputTokens;
user/model/user history; consecutive user turns. The full serialized payload is
asserted, not just selected properties. Its wire representation contains:

- Endpoint: POST `/v1beta/models/gemini-3.5-flash-lite:generateContent`.
- `contents`: an array of `{role: user|model, parts: [{text: ...}]}`.
- `systemInstruction`: `{role: user, parts: [{text: static CarWise instruction}]}`.
- `generationConfig`: `{maxOutputTokens: 700}`.
- The minimal stages serialize `generationConfig: {}` when only transport config
  is supplied. This is SDK behavior, not evidence of a Google API rejection.
- Timeout (7000 ms), retry attempts (1) and AbortSignal are transport settings;
  they do not appear as JSON payload fields. The key is a header, not chat data.

No added stage fails local serialization. The mock supplies the HTTP response:
these tests cannot demonstrate server acceptance or identify which component
Google actually rejected. Do not describe passing mocks as proof of live model
availability. The public model page documents this exact model, but access with
the configured key remains unverified.

A genuine SDK ApiError created from a mocked HTTP 400 is parsed in tests.
Google's normal JSON envelope is supported. `googleStatus: INVALID_ARGUMENT`
in the reported log already proves that the original parser recognized its
status; `detail: unclassified` alone does not demonstrate a wrapper problem.
New diagnostics additionally unwrap prefixed/nested/cause errors, distinguish
recognized envelopes via `envelopeShape`, and read BadRequest.fieldViolations.
Only fixed field groups (contents, model, generationConfig, systemInstruction,
tools, toolConfig, safetySettings, other) are emitted, never field values,
arbitrary paths or descriptions. A generic argument error with no details must
still remain unclassified rather than implying a guessed root cause.

For a separately authorized manual test, make ONE POST to the exact endpoint
above with `x-goog-api-key` supplied privately from the server environment,
Content-Type application/json, and this non-personal payload:

```json
{"contents":[{"role":"user","parts":[{"text":"Reply only OK."}]}],"generationConfig":{"maxOutputTokens":32}}
```

Use one attempt, redirects disabled, a ten-second timeout, no fallback and no
chat/Supabase writes. Do not print the key, headers, raw exceptions or raw
response. Inspect the response locally through the safe diagnostic classifier.
Even an empty generated answer with HTTP 200 establishes acceptance of this
minimal request. If 400 persists, chat history and system instruction are not
needed to reproduce it. If 200 succeeds, the original request differs and its
rejected component remains unproven; do not automatically run a series of paid
probes. Account model metadata can alternatively be checked with one authorized
GET `/v1beta/models/gemini-3.5-flash-lite` and supportedGenerationMethods, but that
does not prove generateContent succeeds. Neither check was executed here.

References:
- https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite
- https://ai.google.dev/api/models

Gemini request compatibility was checked against the installed `@google/genai`
SDK and Google's GenerateContent documentation. The default model
`gemini-3.5-flash-lite` is documented for this API; do not replace it solely
because of HTTP 400. Gemini no longer receives deprecated sampling parameters.
Its contents contain only `user`/`model` roles, with the system instruction
separate in config. Invalid/empty contexts and final model prefills are rejected
locally; representative messages remain labeled user data via `buildContext`.

Google HTTP errors now include `googleStatus` and `detail` in the provider log.
These are allowlisted classifications extracted from the SDK's JSON error
envelope, not raw upstream messages. Examples: `api_key_invalid`,
`final_model_turn`, `unsupported_sampling_parameter`, `billing_or_region`.
Unknown errors log `unclassified`; no upstream text or arbitrary metadata is
retained in diagnostics. A generic HTTP 400 alone does not establish its precise
cause. In particular, Google documents temperature as deprecated/ignored for
this model, so removing it is a compatibility correction, not proof that it
caused the reported response. Retry once and inspect the safe detail before
changing credentials, model or account settings. HTTP 400 still never falls back.

References:
- https://ai.google.dev/gemini-api/docs/generate-content/whats-new-gemini-3.6
- https://ai.google.dev/api/generate-content

A transport-mocked integration test uses the actual installed Google SDK to
check the serialized endpoint, roles, system instruction and generation config.
It makes no live provider request and cannot verify account access or billing.

The HTTP 503 line alone does not identify a provider failure. Storage coordination
can fail before any paid provider request. Server logs now distinguish:

- `[carwise.ai.provider]`: provider, model, numeric upstream status (when known),
  controlled reason and whether fallback is allowed. Upstream response bodies,
  error messages, credentials and conversation content are never logged.
- `[carwise.ai.storage]`: operation and a filtered database error code only.
  For example, `42501` during `reserve_cooldown` or `reserve_turn` points to a
  database permission failure before generation; do not bypass authorization.
- `[carwise.ai.request]`: the HTTP status and controlled application error code.

401/403/404 stop the provider chain (credential/permission/model configuration
needs correction); 408/429/transient 5xx/network/timeout allow the next configured
provider. SDK-wrapped fetch failures and native timeout errors are classified as
temporary. Each provider still gets one attempt with a seven-second deadline.
Models are documented publicly, but account-specific availability, billing and
quota cannot be confirmed without an authorized live check.

After saving environment settings, restart the development server. Retry once
from the UI and inspect only the above diagnostic lines. If none appear, check
server startup/import errors without sharing environment files or raw exceptions.
Do not share provider error bodies, tokens or conversation text.

Run `node scripts/validate-phase2.cjs` to run TypeScript, Vitest and a production
build in a temporary copy without environment files or live credentials, with
HTTP/fetch requests blocked. Tests mock both Google SDK and Supabase boundaries.
They cover ordered fallback, missing keys, no security-error fallback, timeouts,
context limits/redaction, financial guards, ownership and authentication, failed
generation, persisted recovery, CAS races, cooldowns, turn quotas, lost RPC
responses and client message-reference payloads. No paid test is performed.

With explicit approval for normal provider usage, manually:

1. Save the server environment configuration and restart the local dev server.
2. Log in as an employee and send a greeting. Expect a real Hebrew answer and
   a thinking indicator followed by one saved assistant message.
3. Continue the conversation; check that recently provided facts are remembered.
   Refresh, reopen the browser and log out/in: both roles' saved messages remain.
4. Ask for exact net pay or entitlement. Expect an explanation that deterministic
   calculation/data integration is still pending, not fabricated figures.
5. Exercise rapid retry, refresh during generation and temporary network failure.
   The employee text must remain, and AI retries must not add duplicate answers.
6. Check provider quota/model access errors and fallback only with separate
   approval. Automated tests already simulate these failures without billing.
7. Verify actual Supabase service-role metadata coordination privileges and RLS
   isolation with separate employee accounts. No browser or live-provider
   verification was done by the coding agent.
