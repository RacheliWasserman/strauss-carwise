-- Employee cancels their OWN representative request. NOT APPLIED. Review, then apply manually.
-- Independent of 202610210001-003. Uses the existing lifecycle status 'cancelled' (already allowed by the Phase 2
-- CHECK constraint); no table, column, policy or grant on tables changes.
--
-- Why: when the employee supplies the requested fact themselves (e.g. the current car "TUCSON" after a request about
-- it was opened), the request is no longer needed. Cancelling it removes it from the representative queue, frees the
-- one-active-request-per-conversation slot, and stops a late answer (the answer route accepts only 'claimed').
-- Employees have no UPDATE privilege on requests, so this narrow SECURITY DEFINER function is the only path.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.advisor_representative_requests') IS NULL
    OR to_regprocedure('public.advisor_is_current_user_employee()') IS NULL THEN
    RAISE EXCEPTION 'Requires the Phase 2 representative request objects';
  END IF;
  IF to_regprocedure('public.advisor_cancel_own_representative_request(uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'advisor_cancel_own_representative_request already exists; inspect before applying';
  END IF;
END;
$$;

CREATE FUNCTION public.advisor_cancel_own_representative_request(p_request_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  caller uuid := (SELECT auth.uid());
  cancelled uuid;
BEGIN
  IF caller IS NULL OR p_request_id IS NULL OR NOT public.advisor_is_current_user_employee() THEN
    RETURN false;
  END IF;
  -- Only the owner's own request, and only while it is still active.
  UPDATE public.advisor_representative_requests
     SET status = 'cancelled', closed_at = pg_catalog.now(), updated_at = pg_catalog.now()
   WHERE id = p_request_id
     AND owner_user_id = caller
     AND status IN ('open', 'claimed', 'answered')
  RETURNING id INTO cancelled;
  RETURN cancelled IS NOT NULL;
END;
$$;
ALTER FUNCTION public.advisor_cancel_own_representative_request(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.advisor_cancel_own_representative_request(uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.advisor_cancel_own_representative_request(uuid) TO authenticated;

COMMIT;

-- Read-only check after applying:
-- SELECT grantee, privilege_type FROM information_schema.routine_privileges
--   WHERE routine_schema = 'public' AND routine_name = 'advisor_cancel_own_representative_request';  -- authenticated + postgres
