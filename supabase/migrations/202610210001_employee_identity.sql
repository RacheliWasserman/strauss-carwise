-- Employee identity (name + self-reported Israeli national ID). NOT APPLIED. Review, then apply manually.
-- Additive only: one new table, two functions, one policy. No existing table, row, role or policy is changed.
-- The national ID column is never granted to the anon/authenticated roles: only server code using the
-- service role (sign-up) and the SECURITY DEFINER completion function can write it. The full ID is read only by
-- the narrowly scoped reveal function of migration 202610210003 (claimed request, assigned representative).
-- The server reads names and the stored last four digits (national_id_last4) for the representative queue.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.advisor_employee_identities') IS NOT NULL
    OR to_regprocedure('public.advisor_is_valid_israeli_id(text)') IS NOT NULL
    OR to_regprocedure('public.advisor_complete_employee_identity(text,text,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'Employee identity objects already exist; inspect before applying';
  END IF;
  IF to_regclass('public.user_profiles') IS NULL
    OR to_regprocedure('public.advisor_is_current_user_employee()') IS NULL THEN
    RAISE EXCEPTION 'Requires public.user_profiles (Phase 1) and advisor_is_current_user_employee() (Phase 2)';
  END IF;
END;
$$;

-- Format and check digit, on the normalized 9-digit form (leading zeros kept).
CREATE FUNCTION public.advisor_is_valid_israeli_id(p_id text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = ''
AS $$
  SELECT p_id ~ '^[0-9]{9}$' AND p_id <> '000000000' AND (
    SELECT pg_catalog.sum(CASE WHEN product > 9 THEN product - 9 ELSE product END) % 10 = 0
    FROM (
      SELECT pg_catalog.substr(p_id, position, 1)::integer * (CASE WHEN position % 2 = 1 THEN 1 ELSE 2 END) AS product
      FROM pg_catalog.generate_series(1, 9) AS position
    ) AS digits
  );
$$;
ALTER FUNCTION public.advisor_is_valid_israeli_id(text) OWNER TO postgres;
-- Not callable from the Data API: new functions get EXECUTE for PUBLIC by default. The CHECK constraint below runs
-- it as the inserting role, so only service_role (sign-up insert) keeps EXECUTE; the completion function runs as owner.
REVOKE ALL ON FUNCTION public.advisor_is_valid_israeli_id(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.advisor_is_valid_israeli_id(text) TO service_role;

CREATE TABLE public.advisor_employee_identities (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  first_name text NOT NULL CHECK (length(btrim(first_name)) BETWEEN 1 AND 60),
  last_name text NOT NULL CHECK (length(btrim(last_name)) BETWEEN 1 AND 60),
  national_id text NOT NULL CHECK (public.advisor_is_valid_israeli_id(national_id)),
  -- What lists may show to tell identical names apart; the queue never needs to read the full ID to produce it.
  national_id_last4 text GENERATED ALWAYS AS (pg_catalog.right(national_id, 4)) STORED,
  -- Self-reported. Nothing in the application verifies it against HR records.
  national_id_verified boolean NOT NULL DEFAULT false CHECK (national_id_verified = false),
  source text NOT NULL CHECK (source IN ('signup', 'profile_completion')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- One account per national ID (prevents a second account claiming the same ID). The application answers a
-- duplicate exactly like any other sign-up, so the constraint is not an oracle for which IDs are registered.
CREATE UNIQUE INDEX advisor_employee_identities_national_id_key
  ON public.advisor_employee_identities(national_id);

ALTER TABLE public.advisor_employee_identities ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.advisor_employee_identities FROM PUBLIC, anon, authenticated;
-- Column-level grant: national_id and national_id_last4 are deliberately absent.
GRANT SELECT (user_id, first_name, last_name, national_id_verified, created_at, updated_at)
  ON public.advisor_employee_identities TO authenticated;
GRANT SELECT, INSERT ON TABLE public.advisor_employee_identities TO service_role;

CREATE POLICY advisor_employee_identities_read_own
  ON public.advisor_employee_identities FOR SELECT TO authenticated
  USING (
    user_id = (SELECT auth.uid())
    AND public.advisor_is_current_user_employee()
  );

-- Profile completion for accounts created before this table existed (or whose sign-up was interrupted).
-- Insert-only: an existing identity is never overwritten by the client; corrections go through support.
CREATE FUNCTION public.advisor_complete_employee_identity(
  p_first_name text,
  p_last_name text,
  p_national_id text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  current_user_id uuid := (SELECT auth.uid());
  violated text;
BEGIN
  IF current_user_id IS NULL OR NOT public.advisor_is_current_user_employee() THEN
    RAISE EXCEPTION 'Employee account required';
  END IF;
  IF p_first_name IS NULL OR pg_catalog.length(pg_catalog.btrim(p_first_name)) NOT BETWEEN 1 AND 60
    OR p_last_name IS NULL OR pg_catalog.length(pg_catalog.btrim(p_last_name)) NOT BETWEEN 1 AND 60
    OR p_national_id IS NULL OR NOT public.advisor_is_valid_israeli_id(p_national_id) THEN
    RAISE EXCEPTION 'Invalid identity input';
  END IF;
  IF EXISTS (SELECT 1 FROM public.advisor_employee_identities WHERE user_id = current_user_id) THEN
    RAISE EXCEPTION 'Identity already completed' USING ERRCODE = 'P0002';
  END IF;
  BEGIN
    INSERT INTO public.advisor_employee_identities(user_id, first_name, last_name, national_id, source)
    VALUES (current_user_id, pg_catalog.btrim(p_first_name), pg_catalog.btrim(p_last_name), p_national_id, 'profile_completion');
  EXCEPTION WHEN unique_violation THEN
    -- The insert is rolled back (sub-transaction) and nothing is written. A concurrent second submit for THIS account
    -- is "already completed" (about the caller's own account). A national ID registered to ANOTHER account gets the
    -- same generic error as any other failure: no constraint name, no detail, no hint, so it reveals nothing.
    GET STACKED DIAGNOSTICS violated = CONSTRAINT_NAME;
    IF violated = 'advisor_employee_identities_pkey' THEN
      RAISE EXCEPTION 'Identity already completed' USING ERRCODE = 'P0002';
    END IF;
    RAISE EXCEPTION 'Identity could not be saved' USING ERRCODE = 'P0001';
  END;
END;
$$;
ALTER FUNCTION public.advisor_complete_employee_identity(text, text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.advisor_complete_employee_identity(text, text, text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.advisor_complete_employee_identity(text, text, text) TO authenticated;

COMMENT ON TABLE public.advisor_employee_identities IS
  'Employee name and self-reported, unverified Israeli national ID. Client roles never receive national_id or national_id_last4: employees read only their own name columns (RLS). The server (service_role) inserts at sign-up and, for the representative queue, selects names and national_id_last4 only. The full national_id reaches a client only through advisor_reveal_request_national_id (migration 202610210003): the representative assigned to a request, while its status is claimed, audited in advisor_national_id_reveals.';

COMMIT;

-- Read-only checks after applying (expected: national_id and national_id_last4 not listed for authenticated;
-- advisor_is_valid_israeli_id executable only by postgres and service_role):
-- SELECT grantee, privilege_type FROM information_schema.routine_privileges
--   WHERE routine_schema = 'public' AND routine_name IN ('advisor_is_valid_israeli_id', 'advisor_complete_employee_identity');
-- SELECT grantee, column_name, privilege_type FROM information_schema.column_privileges
--   WHERE table_schema = 'public' AND table_name = 'advisor_employee_identities' ORDER BY grantee, column_name;
-- SELECT public.advisor_is_valid_israeli_id('000000018'), public.advisor_is_valid_israeli_id('123456789');  -- true, false
