# Prepared transport comparison — separate live approval required

Script: `scripts/compare-gemini-transports.cjs`. No live requests have been run
by the agent. Preparing this script is not authorization to execute it live.
With no arguments it reads no environment file, performs no request and prints
only a diagnostic explaining that separate approval is required.

After the owner gives separate explicit approval, from the project directory:

```powershell
node .\scripts\compare-gemini-transports.cjs --approved-two-requests
```

This makes **at most two POSTs**, sequentially: one Next-patched fetch, then one
HTTPS-adapter request. A failure in one does not retry it; the other is the
independent second measurement. No redirect is followed. Each transport has
its own seven-second deadline/abort signal. There is no third attempt, provider
fallback, Supabase access, chat turn update, rate-limit reset or data write.

The script reuses sdk-chat-timeout from the existing diagnostic module. It loads
the key privately from .env.local, the current static CarWise instructions and
the safe Google error classifier. The installed Google SDK serializes the
request ONCE against a fake response, before either live measurement. Each path
then receives identical endpoint, POST method, body string and cloned headers,
including x-server-timeout: 7 and explicit content-length. The message is only
`Reply only OK.`, the model is gemini-3.5-flash-lite, maxOutputTokens is 700.
No user text, profile, conversation or employee record is loaded.

The first path wraps Node's fetch with createPatchedFetcher from the installed
Next.js implementation. It uses a minimal synthetic dynamic-route work/request
context; this is more representative than bare Node fetch, but it is NOT the
entire running authenticated Next.js application, development server, telemetry
or middleware environment. No application route or authentication code changes
are needed. The second path reuses the exact native HTTPS adapter from the
existing stage script. OS/network-added behavior can still differ; a comparison
does not by itself prove the network caused previous failures.

Output contains a transport label, HTTP status and filtered diagnostic; Google
status and allowlisted field codes are included on provider errors. It never
prints payloads, headers, key values, key fingerprints, raw errors, free-text
provider messages or answer text. Results should be interpreted as two samples,
not proof of universal availability or a permanent transport defect.

Offline automated tests instantiate the actual Google SDK and installed Next
fetch patch. They mock the origin fetch and node:https underneath the actual
HTTPS adapter, and assert identical endpoint, method, body and headers arriving
at those boundaries. Tests cover 400/429/503 without retries, redirects, separate
deadlines, network errors and sanitized output. Preparing the SDK request itself
never uses a real HTTP transport.
