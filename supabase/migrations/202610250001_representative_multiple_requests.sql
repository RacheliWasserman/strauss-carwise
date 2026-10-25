-- Several representative requests per conversation, each answer linked to its own request.
-- NOT APPLIED. Review, then apply manually in the Supabase SQL editor. Independent of 202610210001–004.
--
-- Why:
-- 1. advisor_representative_requests_one_active_per_conversation_idx counted 'answered' as active, and nothing ever
--    moves a request out of 'answered', so a conversation could never open a second request (even after the first
--    was answered and used). The new index allows ONE PENDING request (open/claimed) PER TOPIC: several topics may be
--    pending at once, the same topic is never duplicated while pending, and an answered request no longer blocks.
--    There is no close step: an answered request stays 'answered' (the representative's "handled" list).
-- 2. The "answered" trigger marked EVERY request of the conversation assigned to the sender as answered, on ANY
--    representative message. With several requests that would mark the wrong ones, so a reply now marks only the
--    request it names (the structured answer / reply envelopes carry requestId). Plain text keeps the old behaviour,
--    limited to requests still in handling.
--
-- Unchanged: the status CHECK constraint (open/claimed/answered/closed/cancelled stay valid), the message read and
-- insert policies, the claim and cancel functions. No rows are deleted or rewritten.
-- Rollback (if ever needed, and only while no conversation holds two active requests): drop the new index, recreate
-- the old index, restore the previous trigger definition from 202610180002.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.advisor_representative_requests') IS NULL
    OR to_regclass('public.advisor_representative_requests_one_active_per_conversation_idx') IS NULL
    OR to_regprocedure('public.advisor_mark_request_answered_on_representative_message()') IS NULL THEN
    RAISE EXCEPTION 'Phase 2 representative objects not found as expected; inspect before applying';
  END IF;
  IF to_regclass('public.advisor_representative_requests_one_pending_per_topic_idx') IS NOT NULL THEN
    RAISE EXCEPTION 'advisor_representative_requests_one_pending_per_topic_idx already exists; inspect before applying';
  END IF;
END;
$$;

-- 1. One pending request per conversation AND topic (was: one open/claimed/answered request per conversation).
DROP INDEX public.advisor_representative_requests_one_active_per_conversation_idx;
CREATE UNIQUE INDEX advisor_representative_requests_one_pending_per_topic_idx
  ON public.advisor_representative_requests(conversation_id, (COALESCE(topic, '')))
  WHERE status IN ('open', 'claimed');

-- 2. A representative message marks only the request it answers.
CREATE OR REPLACE FUNCTION public.advisor_mark_request_answered_on_representative_message()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  target uuid;
BEGIN
  IF NEW.sender_type <> 'representative' THEN
    RETURN NEW;
  END IF;
  -- Structured answer / reply envelopes name their request; anything else has no reference.
  BEGIN
    IF pg_catalog.left(NEW.body, 1) = '{' THEN
      target := (NEW.body::jsonb ->> 'requestId')::uuid;
    END IF;
  EXCEPTION WHEN others THEN
    target := NULL;
  END;
  IF target IS NOT NULL THEN
    UPDATE public.advisor_representative_requests
       SET status = 'answered', answered_at = COALESCE(answered_at, NEW.created_at), updated_at = NEW.created_at
     WHERE id = target
       AND conversation_id = NEW.conversation_id
       AND assigned_representative_id = NEW.sender_user_id
       AND status = 'claimed';
  ELSE
    UPDATE public.advisor_representative_requests
       SET status = 'answered', answered_at = COALESCE(answered_at, NEW.created_at), updated_at = NEW.created_at
     WHERE conversation_id = NEW.conversation_id
       AND assigned_representative_id = NEW.sender_user_id
       AND status = 'claimed';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.advisor_mark_request_answered_on_representative_message()
  FROM PUBLIC, anon, authenticated, service_role;

COMMIT;
