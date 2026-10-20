# Manual Gemini request isolation

Current status: following a real `deadline_too_short` response, production Gemini
now has a 20-second deadline and X-Server-Timeout: 20. Backups remain seven
seconds. Browser assistant wait is 50 seconds; route maxDuration is still 60.
The seven-second statements below describe historical audits and explicit
diagnostic controls, which remain unchanged. See phase3-ai.md for current limits.

## Same-path offline reproduction after the successful seven-second probe

The owner reports sdk-chat-timeout succeeded. Thus seven seconds is NOT a
configuration that always fails, and no timeout change is justified by that
hypothesis alone. Production timeout remains 7000 ms.

`tests/assistant-request-path.test.ts` now calls the actual assistant POST route,
runAssistantTurn, buildContext, generateReply and installed Google SDK. Only
authentication, TurnStore persistence and HTTP transport are substituted; no
Supabase client can connect. It compares the generated JSON, endpoint, method
and digest of ALL SDK-generated headers against the existing sdk-chat-timeout
stage with exactly the same fictional message and fake key. They match.
No business-code request builder is copied into this test, and no new manual
diagnostic tool or live stage was added.

The same real API path is tested with synthetic Hebrew, outer spaces, newlines,
emoji and Unicode control/replacement characters. These are serialized without
unexpected transformation; tests do not assert Google accepts control characters.
An artificial Google 400 propagates to AI_REJECTED without losing the employee
message or retrying. A capped turn remains unchanged and makes no HTTP call.

This proves equal construction for identical synthetic data, NOT equality to
the owner's private production message (which has not been retrieved/exported),
nor real server acceptance. Request summaries of lengths/role counts do not
establish equality of texts. The probe's HTTPS adapter can add content-length
after the SDK header comparison. Next.js fetch instrumentation, native fetch,
network/proxy-added headers and the actual runtime's response are outside this
Vitest construction test. There is currently no proven payload defect causing
the owner's 400. Do not alter timeout/model/fallback, strip real user text,
reset attempts or delete data on this evidence.

The next focused experiment, if further investigation is approved, should hold
fictional text, SDK and seven-second settings constant and compare Next.js fetch
with the HTTPS adapter. Do not repeat the unrelated payload-stage ladder or
retry the capped chat message. Any real Google request requires separate
approval; none was made as part of the offline reproduction.

## Header/deadline audit

The installed SDK's getHeadersInternal converts httpOptions.timeout (ms) into
X-Server-Timeout (seconds). Offline tests with the real SDK prove the chat sends
7 while the successful manual probe sends 10. Previous descriptions saying the
timeout was only client-side were incomplete: it is absent from JSON, but it
also affects an HTTP header. Production timeout/model/fallback settings have NOT
been changed on this evidence alone.

The safe header summary emits only serverTimeoutSeconds, JSON content-type
boolean, SDK version, and key/auth header presence (never their values). Text
summaries now count lone surrogates, replacement characters, control characters
and bidi controls. These counts do not establish that Google rejects the text;
no real user text is exported or modified by diagnostics.

The error classifier now recognizes deadline-too-short wording in the error
message or BadRequest descriptions as deadline_too_short, without exposing
those messages/descriptions. Tests use synthetic HTTP 400 fixtures; they do not
prove this is the wording of the owner's still-unclassified response.

`sdk-chat-timeout` is a manual, synthetic one-request paired comparison against
`sdk-carwise-system`: same JSON and endpoint, SDK timeout/header 7 seconds
instead of 10. Native transport respects SDK cancellation and keeps its ten-second
absolute ceiling. No retries/fallback/redirects occur. It has not been run live.
Each selected live stage still requires --live-one. There are now nine stages;
no batch execution exists or is recommended.

AI_TURN_LIMIT is an APPLICATION 429, not a Google 429: after three generation
attempts for one saved employee message, the turn service rejects further
generation before provider/cooldown/CAS/append. Waiting or refreshing does not
clear the persisted attempts. Tests confirm no state reset or write at the cap.
Do not retry that capped turn or manufacture chat turns to evade the cap.
An explicitly approved synthetic standalone probe does not access Supabase,
change that limit, or clear its state.

The leading unresolved hypothesis is the header/deadline difference. To test
only that difference manually, ONE further paid request at most would be:

```powershell
node .\scripts\diagnose-gemini-stages.cjs --stage sdk-chat-timeout --live-one
```

Do not run it automatically or run multiple stages. Inspect safe detail and
serverTimeoutSeconds first. A deadline_too_short rejection would supply the
missing direct evidence before changing production timeout settings. A 200
would leave other transport/runtime differences open. The probe uses the same
native HTTPS adapter as other stages; it does not reproduce Next.js fetch
instrumentation. Real chat uses fetch and inherits SDK backend selection;
the probe uses explicit vertexai:false. Already logged Gemini/v1beta targets
can rule out a backend mismatch for those particular requests.

SDK primary source: https://github.com/googleapis/js-genai/blob/main/src/_api_client.ts

## Real chat request tracing

The assistant API authenticates employee ownership before reading the source
message. `listConversationMessages` queries advisor_conversation_messages for
one conversation, ordered descending by created_at then id, limited to 60, and
reverses the result into chronological order. The turn service re-filters the
conversation, requires the newest employee message to be the source, and takes
history only through that source. `buildContext` keeps up to 24 messages and
16,000 UTF-16 characters, at most 4,000 per message. Assistant becomes model;
employee/representative become user. Blank text is omitted. Each Gemini part
contains only text. Primary keys prevent duplicate IDs in normal repository
results; equal message bodies are valid separate messages and are not removed.

One reproduced local defect was fixed: truncating UTF-16 could split an emoji,
creating a lone surrogate. The context builder now drops a trailing incomplete
pair at either budget boundary. Tests prove the former invalid text case; no
claim is made that this was the cause of the owner's historical HTTP 400.

New server-only logs:

- `[carwise.ai.history]`: scoped/selected counts, duplicate ID and blank counts,
  foreign-conversation exclusions, and whether the context ends in a user turn.
- `[carwise.ai.gemini.request]`: actual SDK-serialized field names, roles, text
  lengths, part validity, Unicode validity counts, system instruction length,
  generation fields/maxOutputTokens, backend/version and timeout. No text,
  message/user IDs, salary, headers or URLs are logged.
- Credential identity uses a domain-separated SHA-256 fingerprint (24 hex chars),
  never a key fragment. The server compares the selected runtime key with the
  current local .env.local file, without changing process.env. It logs both
  fingerprints and runtimeKeyMatchesEnvLocal. runtimeModelMatchesEnvLocal compares
  the configured model against the file override/default; modelMatchesProbe
  checks the fixed model used by the successful script. A missing local file is
  reported as unavailable, not as a mismatch. Live manual script output now
  includes the same credential snapshot, with no additional API request.
- Google BadRequest violations additionally yield only allowlisted fieldCodes,
  e.g. generationConfig.maxOutputTokens or contents.parts.text. No numeric
  indices, descriptions, arbitrary field paths or error messages are emitted.

The transport wrapper delegates the request to the existing fetch implementation;
it does not add a request or retry, or change provider fallback policy. Captured
logs are internal diagnostics, not returned to browsers. Tests mock requests and
file input; actual running Next.js credential identity has NOT been observed.

Next browser check: restart Next.js, open the existing affected conversation and
send ONE neutral message (`היי`) without automatic/manual retries. Inspect only
the above safe log lines plus `[carwise.ai.provider]` if generation fails. This
is normal chat usage and can invoke the existing temporary-failure fallback
chain; it is not a one-provider-only probe. Do not repeat diagnostic API stages
just to obtain a fingerprint: the server log already compares against the file.

The owner's direct REST probe succeeded (HTTP 200 and nonempty reply). This
establishes that this model/key combination worked at that time from that PC.
It does not prove the running Next.js process has reloaded that same credential.
The probe reads `.env.local` directly; chat uses the server's `process.env`.
Restart the dev server after environment changes; never share credentials.

## Verified wire-payload differences

| Component | Successful direct REST probe | Current chat via installed SDK |
| --- | --- | --- |
| Model/API | gemini-3.5-flash-lite, v1beta generateContent | Same under normal Gemini API configuration |
| Contents | One user text, `Reply only OK.` | Latest bounded history, user/model roles, final user |
| Output limit | generationConfig.maxOutputTokens = 32 | 700 |
| System instruction | Absent | Static CarWise text; SDK serializes `{role:"user",parts:[{text:...}]}` |
| Other generation fields | None | None; temperature/topP/topK already removed |
| Credentials | Header, loaded directly from .env.local | Header, loaded from Next.js server environment |
| Transport | Native Node HTTPS | SDK defaults to fetch; adds SDK identification headers |
| Timeout | 10 seconds, X-Server-Timeout: 10 in SDK stages | 7 seconds, X-Server-Timeout: 7 |

Model is in the URL, not a JSON body field. Timeout, abortSignal and retryOptions
do not appear in the JSON payload. Representative messages are labeled user
data, never an unsupported Gemini role. The context window can start with a
model message after truncation; this is tested independently in the final stage.

No current generation parameter was demonstrated to be unsupported. Removing
or changing more production parameters without a reproducer would be guessing.
Google's reference describes systemInstruction and generationConfig as supported
GenerateContent fields. This does not establish acceptance of any particular
request by the owner's account.

References:
- https://ai.google.dev/api/generate-content
- https://ai.google.dev/gemini-api/docs/generate-content/whats-new-gemini-3.6

## Controlled manual stages

`scripts/diagnose-gemini-stages.cjs` defaults to OFFLINE. No argument or `--list`
lists stages with zero requests. `--stage NAME` serializes against a mocked HTTP
response with zero requests and without reading `.env.local`.

Adding `--live-one` makes at most ONE POST, only for that stage. There is no
batch mode, retry, fallback or redirect following. Each run has a ten-second
deadline and uses synthetic messages only. No Supabase modules are imported.
Raw provider messages, keys, headers and answer text are not printed.

| Stage | Single controlled change / comparison |
| --- | --- |
| sdk-minimal | Same 32-token minimal payload as the successful probe, through the installed SDK |
| output-limit | Only output limit changes from 32 to exactly 700; sdk-limit remains an alias |
| sdk-simple-system | Add a short generic system instruction |
| sdk-carwise-system | Replace that instruction with the exact current static CarWise instruction |
| sdk-history | Add synthetic user/model/user history |
| sdk-consecutive-users | Add a synthetic representative note as a user turn before the last user turn |
| rest-system-no-role | Compare with sdk-carwise-system; same JSON except omitted systemInstruction.role, using REST |
| sdk-leading-model | Compare a truncated synthetic history starting with model and ending with user |
| sdk-chat-timeout | Same as sdk-carwise-system with 7-second timeout/server header instead of 10 |

The SDK stages intentionally use a custom fetch adapter backed by the same
native HTTPS transport as the REST stage. This holds transport constant and
isolates SDK serialization/header differences. It does NOT test the SDK's default
fetch networking behavior. The adapter refuses another URL/method or a second
attempt before network access. Gemini API mode is explicit, preventing Vertex
credential discovery. Each process loads the key privately from .env.local.
Static configuration and the safe error classifier are read locally, without
importing chat services or touching business code.

`output-limit` is now a recognized stage. Previously only `sdk-limit` was
recognized, so the former command failed argument validation before reading the
key or sending any request. The former generic local error hid that distinction.
The current output includes `phase` and differentiates `local_script_error`
(arguments/environment/initialization/build_request), network failures/timeouts,
`provider_rejected` (`google_http`), and `response_processing_failure` after a
response. Unknown stage errors report zero requests without exposing arguments.
Native transport timeouts retain the HTTP status if headers already arrived.

Start with ONE live request from the project directory:

```powershell
node .\scripts\diagnose-gemini-stages.cjs --stage sdk-minimal --live-one
```

Stop and inspect/share the safe JSON. Do not run all stages automatically.
After each success, the next stage can be chosen manually; each further command
is a separate one-request live test. If a system stage fails, rest-system-no-role
is the paired comparison. Running every listed stage once would total at most
nine requests; no such batch has been executed or scheduled.

HTTP 200 with empty output is still successful request acceptance. Output
truncation and generation failures must not be confused with request validation.
The `shape` summary contains field names, role sequence and token limit, never
text. `detail`, `fields`, and `googleStatus` are fixed safe classifications.
If all stages pass but chat still fails, investigate the running server's loaded
configuration, SDK default fetch path and the actual history shape, without
exporting user conversation data.

Offline tests use the real installed SDK and mocked transport, verify stage
payloads, compare REST vs SDK system-role serialization, reject automatic
additional calls, and check sanitized errors. No live stage was run by the agent.
