-- Full national ID for the representative actively handling a request. NOT APPLIED. Review, then apply manually.
-- Requires 202610210001_employee_identity.sql. Independent of 202610210002 (both can be applied in any order).
--
-- Business rule: representatives must tell apart employees with identical names. Lists show only the last four
-- digits (national_id_last4, read by the server). The FULL ID is returned only by this function, only to the
-- representative who personally claimed the given request, and only while its status is exactly 'claimed'.
-- Answered, closed, cancelled or reassigned requests stop qualifying at once; nothing is cached in the database.
-- Every successful reveal is recorded (who, which request, when) in a table no client role can read.
-- Every refusal raises the same generic error, so callers cannot learn why (or whether an ID exists).

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.advisor_employee_identities') IS NULL THEN
    RAISE EXCEPTION 'Apply 202610210001_employee_identity.sql first';
  END IF;
  IF to_regclass('public.advisor_representative_requests') IS NULL
    OR to_regprocedure('public.advisor_is_current_user_representative()') IS NULL THEN
    RAISE EXCEPTION 'Requires the Phase 2 representative request objects';
  END IF;
  IF to_regclass('public.advisor_national_id_reveals') IS NOT NULL
    OR to_regprocedure('public.advisor_reveal_request_national_id(uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'National ID reveal objects already exist; inspect before applying';
  END IF;
END;
$$;

CREATE TABLE public.advisor_national_id_reveals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES public.advisor_representative_requests(id) ON DELETE CASCADE,
  representative_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  revealed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX advisor_national_id_reveals_request_idx ON public.advisor_national_id_reveals(request_id, revealed_at DESC);
ALTER TABLE public.advisor_national_id_reveals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.advisor_national_id_reveals FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.advisor_national_id_reveals TO service_role;  -- For audits only; no policies exist.

CREATE FUNCTION public.advisor_reveal_request_national_id(p_request_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  caller uuid := (SELECT auth.uid());
  request_owner uuid;
  revealed text;
BEGIN
  IF caller IS NULL OR p_request_id IS NULL OR NOT public.advisor_is_current_user_representative() THEN
    RAISE EXCEPTION 'Not available' USING ERRCODE = '42501';
  END IF;
  -- The exact request, assigned to the caller, actively claimed. The row lock keeps the status from changing
  -- (answer, close, reassignment) between this check and the read below.
  SELECT request.owner_user_id INTO request_owner
    FROM public.advisor_representative_requests AS request
   WHERE request.id = p_request_id
     AND request.assigned_representative_id = caller
     AND request.status = 'claimed'
   FOR SHARE;
  IF request_owner IS NULL THEN
    RAISE EXCEPTION 'Not available' USING ERRCODE = '42501';
  END IF;
  SELECT identity.national_id INTO revealed
    FROM public.advisor_employee_identities AS identity
   WHERE identity.user_id = request_owner;
  IF revealed IS NULL THEN
    RAISE EXCEPTION 'Not available' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.advisor_national_id_reveals(request_id, representative_id) VALUES (p_request_id, caller);
  RETURN revealed;
END;
$$;
ALTER FUNCTION public.advisor_reveal_request_national_id(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.advisor_reveal_request_national_id(uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.advisor_reveal_request_national_id(uuid) TO authenticated;

COMMENT ON FUNCTION public.advisor_reveal_request_national_id(uuid) IS
  'Full national ID of a request owner, only for the representative assigned to that request while status = claimed. Audited.';

COMMIT;

-- Read-only checks after applying:
-- SELECT grantee, privilege_type FROM information_schema.routine_privileges
--   WHERE routine_schema = 'public' AND routine_name = 'advisor_reveal_request_national_id';   -- authenticated + postgres only
-- SELECT request_id, representative_id, revealed_at FROM public.advisor_national_id_reveals ORDER BY revealed_at DESC LIMIT 20;
