# Employee chat workspace

`/employee` now renders the CarWise chat workspace for authenticated employees.
It uses the existing Phase 2 APIs and the installed advisor tables. It does not
read demo employees, request payroll linking, change migrations, run calculations,
or run model code in the browser. Phase 3 now connects real AI replies through
a server-only provider layer; see [phase3-ai.md](phase3-ai.md). The workspace
uses no additional UI dependencies; Phase 3 adds the Google GenAI server SDK.

## Components and data flow

- `src/app/employee/page.tsx`: uses the existing authenticated-profile helper,
  preserves employee/representative routing, passes only the authenticated UUID.
- `src/components/chat/employee-chat.tsx`: workspace composition, responsive
  navigation, textarea focus and visual-viewport height for mobile keyboards.
- `chat-sidebar.tsx`: conversation history, paging, active state and mobile dialog
  with Escape, focus trapping and return focus. Reuses the existing logout button.
- `chat-welcome.tsx`: CarWise route illustration and four keyboard-accessible
  starter cards that fill and focus the real composer.
- `chat-thread.tsx`: saved employee/assistant/representative messages, older pages,
  copy action, preserved reading position and a new-message navigation button.
- `chat-composer.tsx`: multiline entry, Enter/Shift+Enter, IME handling, pending
  state, safe retry, length limit and actionable errors.
- `use-employee-chat.ts`: loading, per-user selection recovery, sending and polling.
- `employee-chat.css` and `chat-icon.tsx`: scoped visual system and inline SVG icons.
- `src/lib/chat-client.ts`: validated HTTP contracts, idempotent delivery lock,
  timeout handling, cursor encoding, deduplication and recovery validation.

The browser calls only same-origin endpoints with session cookies:

| Action | Endpoint |
| --- | --- |
| New conversation and first message | POST /api/conversations |
| History and older conversation pages | GET /api/conversations |
| Selected conversation metadata | GET /api/conversations/:id |
| Latest or older saved messages | GET /api/conversations/:id/messages |
| Continue a saved conversation | POST /api/conversations/:id/messages |
| Generate/recover a saved AI reply | POST /api/conversations/:id/assistant |

Both history lists use the server's `nextCursor` with paired `before` and
`beforeId`. Message pages render chronologically; conversation pages render
most-recent first. Overlapping pages merge by UUID. Titles use a supplied title
or a first-message summary once that conversation's beginning has been loaded;
otherwise history entries are distinguished by their last activity date/time.
No title or status writes are performed.

Selection is stored as a UUID in the URL and in a per-user localStorage key.
The messages themselves are fetched from Supabase through the APIs. Temporary
unconfirmed operations (text, conversation UUID and request UUID) are stored in
per-user sessionStorage solely for retry after refresh, then removed once saved.
No service credentials are sent to the browser. When browser storage is disabled,
the current page still works; recovery across refresh of an unconfirmed write
cannot be guaranteed. Confirmed messages remain on the server.

Synchronous send locking prevents double Enter/click races. An ambiguous failure
keeps the same request UUID and text for every retry, including recovered drafts.
Conversation switching is paused until that write is confirmed. If a later read
finds the employee's matching saved clientMessageId/text, recovery is reconciled
without another write. Network requests time out after 30 seconds. The UI never
labels pending text as saved. Each server-confirmed message is identified as such.

Visible active conversations poll saved messages every 15 seconds and on tab
visibility restoration; this is not a simulated AI response or typing indicator.
No conversation is closed or deleted by this workspace. Signing out retains
saved conversations and returns to the existing login page.

## Automated validation

Run `node scripts/validate-phase2.cjs`. It checks TypeScript, Vitest and a production
build in a temporary source copy, without loading local environment files, with
dummy credentials and outbound HTTP/fetch disabled. It does not connect to live
Supabase. `tests/chat-client.test.ts` covers HTTP payloads, creation/continuation,
history/message pagination, concurrent sends, retry keys, invalid responses,
timeouts, cancellation, recovery and overlapping-page deduplication. Existing
API, calculator, authentication and migration tests also run.

These tests do not mount the UI in a browser or validate live RLS/storage.

## Browser acceptance checks

Use the existing configured local dev server and a normal employee login. Never
share credentials or environment keys in chat. No new setup or Gemini key is needed.

1. Open `/employee`. Confirm the responsive welcome, RTL text and four suggestion
   cards. A suggestion fills/focuses the composer and does not fabricate a reply.
2. Send text with Enter; try double Enter and rapid clicks. Confirm only one saved
   message and conversation. Shift+Enter adds a newline.
3. Continue writing, refresh, close/reopen the browser, sign out/in. Reopen history
   and verify all confirmed messages are still present with the same conversation.
4. Select new/old conversations. Test both older-conversation and older-message
   pages with more than 30 items. Verify no repeated messages or skipped ties.
5. Simulate offline/network failures. An unconfirmed write offers retry and keeps
   its original key. Restore the connection and confirm a single saved message.
   Refresh during this flow to test sessionStorage recovery.
6. Check a long/multiline message, copy, scroll preservation when loading older
   messages, and arrival of a saved representative message while reading history.
7. At phone widths, test drawer focus/close/Escape, keyboard opening, text entry,
   screen scrolling, safe areas, landscape and desktop resizing.
8. Test keyboard-only navigation, screen reader announcements and reduced motion.
   Test storage-disabled mode and expired sessions without showing another user's
   history. No automatic closing or "finish conversation" action should appear.

Browser screenshots, mobile rendering, real cookies, live persistence and RLS
still require these manual checks. The representative page remains outside this
change; messages it creates through the existing authorized API can render here.
