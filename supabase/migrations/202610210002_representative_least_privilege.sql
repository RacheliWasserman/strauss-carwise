-- Representative least privilege. NOT APPLIED. Review, then apply manually (independent of 202610210001).
--
-- Problem: with the Phase 2 policies, a representative who claims a request can SELECT the employee's whole
-- conversation (every message, including salary details), and every calculation run and scenario of that
-- conversation, directly through the Data API with their own session.
--
-- What a representative actually needs (verified against the application code):
--   * the request row (topic names the single missing field)          -> unchanged policy
--   * to insert a reply in the assigned conversation                    -> unchanged insert policy
--   * to read back their OWN reply (INSERT ... RETURNING, idempotent retry, "answered" list) -> kept
-- Not needed, and removed: the conversation row, the employee's / assistant's messages, calculation snapshots.
-- Employee access is unchanged. Request policies are unchanged (no recursive RLS dependency is introduced).
-- Identity data is not touched here: representatives never get table access to advisor_employee_identities. Names and
-- the last four ID digits reach them through the server queue API; the full ID only through 202610210003.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'advisor_conversations'
                   AND policyname = 'advisor_conversations_read_owner_or_assigned_rep')
    OR NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'advisor_conversation_messages'
                   AND policyname = 'advisor_messages_read_owner_or_assigned_rep')
    OR NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'advisor_calculation_runs'
                   AND policyname = 'advisor_calculation_runs_read_owner_or_assigned_rep')
    OR NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'advisor_calculation_scenarios'
                   AND policyname = 'advisor_calculation_scenarios_read_owner_or_assigned_rep') THEN
    RAISE EXCEPTION 'Phase 2 read policies not found as expected; inspect pg_policies before applying';
  END IF;
END;
$$;

DROP POLICY advisor_conversations_read_owner_or_assigned_rep ON public.advisor_conversations;
CREATE POLICY advisor_conversations_read_owner
  ON public.advisor_conversations FOR SELECT TO authenticated
  USING (
    public.advisor_is_current_user_employee()
    AND owner_user_id = (SELECT auth.uid())
  );

DROP POLICY advisor_messages_read_owner_or_assigned_rep ON public.advisor_conversation_messages;
CREATE POLICY advisor_messages_read_owner_or_own_rep_reply
  ON public.advisor_conversation_messages FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.advisor_conversations AS conversation
      WHERE conversation.id = advisor_conversation_messages.conversation_id
        AND public.advisor_is_current_user_employee()
        AND conversation.owner_user_id = (SELECT auth.uid())
    )
    OR (
      -- A representative sees only the messages they wrote, and only while assigned.
      sender_type = 'representative'
      AND sender_user_id = (SELECT auth.uid())
      AND public.advisor_is_current_user_representative()
      AND EXISTS (
        SELECT 1 FROM public.advisor_representative_requests AS request
        WHERE request.conversation_id = advisor_conversation_messages.conversation_id
          AND request.assigned_representative_id = (SELECT auth.uid())
          AND request.status IN ('claimed', 'answered')
      )
    )
  );

DROP POLICY advisor_calculation_runs_read_owner_or_assigned_rep ON public.advisor_calculation_runs;
CREATE POLICY advisor_calculation_runs_read_owner
  ON public.advisor_calculation_runs FOR SELECT TO authenticated
  USING (
    public.advisor_is_current_user_employee()
    AND owner_user_id = (SELECT auth.uid())
  );

DROP POLICY advisor_calculation_scenarios_read_owner_or_assigned_rep ON public.advisor_calculation_scenarios;
CREATE POLICY advisor_calculation_scenarios_read_owner
  ON public.advisor_calculation_scenarios FOR SELECT TO authenticated
  USING (
    public.advisor_is_current_user_employee()
    AND owner_user_id = (SELECT auth.uid())
  );

COMMIT;

-- Rollback (restores the Phase 2 behaviour exactly): re-run the four original CREATE POLICY statements from
-- 202610180002_phase2_persistence.sql after dropping the four policies created above.
-- Read-only check after applying:
-- SELECT tablename, policyname, cmd FROM pg_policies WHERE schemaname = 'public' AND tablename LIKE 'advisor_%' ORDER BY 1, 2;
