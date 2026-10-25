-- Rollback preparation for the "several representative requests" feature. NOT APPLIED. Not a migration.
-- Run manually ONLY before deploying a build older than branch fix/rep-requests-and-new-chat (e.g. 565e426), and
-- ONLY if CARWISE_MULTIPLE_REP_REQUESTS was ever 'true' in that environment. With the flag off, the newer build never
-- saves the list, and this script finds nothing to change.
--
-- Why: the older build validates the saved conversation state strictly and rejects the unknown key
-- 'representativeRequests'; such a conversation would fail on its next message ("AI_UNAVAILABLE").
-- What: removes only that key from the saved business state of employee messages. The latest request stays in
-- 'representative' (which the older build reads). Messages, requests, answers and profiles are not touched.
-- Order: 1. set CARWISE_MULTIPLE_REP_REQUESTS=false (or remove it) and redeploy the current build;
--        2. run this script; 3. deploy the older build. The database migration 202610250001 may stay applied.
-- Effect on a conversation that had several pending requests: only the latest one stays linked in the conversation;
-- an answer to an older one is reported as not matching the open question, and the employee can type the value.

BEGIN;

UPDATE public.advisor_conversation_messages
   SET metadata = metadata #- '{carwise_ai,businessState,representativeRequests}'
 WHERE sender_type = 'employee'
   AND metadata -> 'carwise_ai' -> 'businessState' ? 'representativeRequests';

COMMIT;
