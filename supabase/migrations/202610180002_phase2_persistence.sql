-- Phase 2 persistence foundation. Apply manually after reviewing the live schema.
-- Requires public.user_profiles from Phase 1. Creates advisor objects only; preserves all legacy and Phase 1 objects.

BEGIN;

DO $$
BEGIN
  -- Reject collisions across all advisor relations and function overloads.
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public' AND left(relation.relname, 8) = 'advisor_'
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc AS routine
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = routine.pronamespace
    WHERE namespace.nspname = 'public' AND left(routine.proname, 8) = 'advisor_'
  ) THEN
    RAISE EXCEPTION 'Advisor objects already exist; inspect before applying';
  END IF;

  IF to_regclass('public.user_profiles') IS NULL THEN
    RAISE EXCEPTION 'Phase 2 requires public.user_profiles from Phase 1';
  END IF;

  IF EXISTS (
    SELECT 1 FROM (VALUES ('postgres'), ('anon'), ('authenticated'), ('service_role')) AS required(role_name)
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles AS role WHERE role.rolname = required.role_name
    )
  ) THEN
    RAISE EXCEPTION 'Phase 2 requires the standard Supabase postgres, anon, authenticated and service_role roles';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'user_profiles'
      AND column_name = 'id' AND data_type = 'uuid'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'user_profiles'
      AND column_name = 'role' AND data_type = 'text'
  ) THEN
    RAISE EXCEPTION 'public.user_profiles schema is incompatible with Phase 2';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'vehicle_catalog'
      AND column_name = 'id' AND data_type IN ('text', 'character varying')
  ) THEN
    RAISE EXCEPTION 'public.vehicle_catalog.id must exist as text or varchar for Phase 2 vehicle references';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_index AS key
    JOIN pg_catalog.pg_attribute AS column_info
      ON column_info.attrelid = key.indrelid AND column_info.attnum = key.indkey[0]
    WHERE key.indrelid = to_regclass('public.vehicle_catalog')
      AND key.indisunique AND key.indisvalid AND key.indimmediate
      AND key.indpred IS NULL AND key.indexprs IS NULL
      AND key.indnkeyatts = 1 AND column_info.attname = 'id'
  ) THEN
    RAISE EXCEPTION 'public.vehicle_catalog.id requires a valid non-partial immediate unique key for advisor foreign keys';
  END IF;

  IF to_regclass('public.advisor_employee_profiles') IS NOT NULL
    OR to_regclass('public.advisor_employee_data_versions') IS NOT NULL
    OR to_regclass('public.advisor_conversations') IS NOT NULL
    OR to_regclass('public.advisor_conversation_messages') IS NOT NULL
    OR to_regclass('public.advisor_calculation_runs') IS NOT NULL
    OR to_regclass('public.advisor_calculation_scenarios') IS NOT NULL
    OR to_regclass('public.advisor_representative_requests') IS NOT NULL THEN
    RAISE EXCEPTION 'A Phase 2 persistence table already exists; inspect and reconcile before applying';
  END IF;

  IF to_regprocedure('public.advisor_is_current_user_representative()') IS NOT NULL
    OR to_regprocedure('public.advisor_is_current_user_employee()') IS NOT NULL
    OR to_regprocedure('public.advisor_create_conversation_with_first_message(text)') IS NOT NULL
    OR to_regprocedure('public.advisor_create_conversation_with_first_message(text,uuid)') IS NOT NULL
    OR to_regprocedure('public.advisor_claim_representative_request(uuid)') IS NOT NULL
    OR to_regprocedure('public.advisor_append_assistant_message(uuid,uuid,text)') IS NOT NULL
    OR to_regprocedure('public.advisor_create_calculation_snapshot(jsonb,jsonb)') IS NOT NULL
    OR to_regprocedure('public.advisor_confirm_employee_data_version(uuid)') IS NOT NULL
    OR to_regprocedure('public.advisor_assign_employee_data_version()') IS NOT NULL
    OR to_regprocedure('public.advisor_enforce_employee_data_version_transition()') IS NOT NULL
    OR to_regprocedure('public.advisor_prevent_calculation_snapshot_mutation()') IS NOT NULL
    OR to_regprocedure('public.advisor_touch_conversation_after_message()') IS NOT NULL
    OR to_regprocedure('public.advisor_mark_request_answered_on_representative_message()') IS NOT NULL THEN
    RAISE EXCEPTION 'A Phase 2 persistence function already exists; inspect and reconcile before applying';
  END IF;
END;
$$;

CREATE TABLE public.advisor_employee_profiles (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.advisor_employee_data_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'confirmed')),
  schema_version text NOT NULL,
  display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 120),
  occupation_title text NOT NULL CHECK (length(btrim(occupation_title)) BETWEEN 1 AND 120),
  base_salary numeric(12, 2) NOT NULL CHECK (base_salary BETWEEN 0 AND 1000000),
  commissions numeric(12, 2) NOT NULL DEFAULT 0 CHECK (commissions BETWEEN 0 AND 1000000),
  bonus numeric(12, 2) NOT NULL DEFAULT 0 CHECK (bonus BETWEEN 0 AND 1000000),
  employee_pension_percent numeric(5, 2) NOT NULL CHECK (employee_pension_percent BETWEEN 0 AND 30),
  employee_study_fund_percent numeric(5, 2) NOT NULL CHECK (employee_study_fund_percent BETWEEN 0 AND 30),
  tax_credit_points numeric(5, 2) NOT NULL CHECK (tax_credit_points BETWEEN 0 AND 50),
  eligible_children_count smallint NOT NULL CHECK (eligible_children_count BETWEEN 0 AND 40),
  current_vehicle_id text NULL REFERENCES public.vehicle_catalog(id) ON DELETE RESTRICT,
  current_participation numeric(10, 2) NOT NULL DEFAULT 0
    CHECK (current_participation BETWEEN 0 AND 100000),
  created_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz NULL,
  UNIQUE (user_id, version),
  UNIQUE (id, user_id),
  CHECK ((status = 'draft' AND confirmed_at IS NULL)
      OR (status = 'confirmed' AND confirmed_at IS NOT NULL))
);

CREATE TABLE public.advisor_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title text NULL CHECK (title IS NULL OR length(title) <= 160),
  status text NOT NULL DEFAULT 'open'
    CHECK (status = 'open'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_message_at timestamptz NOT NULL DEFAULT now(),
  client_request_id uuid NULL,
  closed_at timestamptz NULL,
  UNIQUE (id, owner_user_id),
  UNIQUE (owner_user_id, client_request_id),
  -- Conversations persist across sessions. This phase has no closing lifecycle.
  CHECK (closed_at IS NULL)
);

CREATE TABLE public.advisor_conversation_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES public.advisor_conversations(id) ON DELETE CASCADE,
  sender_type text NOT NULL
    CHECK (sender_type IN ('employee', 'assistant', 'representative')),
  sender_user_id uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  body text NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 16000),
  client_message_id uuid NULL,
  metadata jsonb NULL CHECK (metadata IS NULL OR jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (sender_type = 'assistant' AND sender_user_id IS NULL)
    OR sender_type IN ('employee', 'representative')
  ),
  UNIQUE (conversation_id, client_message_id)
);

CREATE TABLE public.advisor_calculation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL,
  owner_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  employee_data_version_id uuid NOT NULL,
  calculator_version text NOT NULL,
  rules_version text NOT NULL,
  tax_year integer NOT NULL CHECK (tax_year BETWEEN 2000 AND 2200),
  input_snapshot jsonb NOT NULL CHECK (jsonb_typeof(input_snapshot) = 'object'),
  baseline_snapshot jsonb NULL
    CHECK (baseline_snapshot IS NULL OR jsonb_typeof(baseline_snapshot) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (conversation_id, owner_user_id)
    REFERENCES public.advisor_conversations(id, owner_user_id) ON DELETE CASCADE,
  FOREIGN KEY (employee_data_version_id, owner_user_id)
    REFERENCES public.advisor_employee_data_versions(id, user_id) ON DELETE CASCADE,
  UNIQUE (id, owner_user_id)
);

CREATE TABLE public.advisor_calculation_scenarios (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL,
  owner_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  ordinal smallint NOT NULL CHECK (ordinal > 0),
  choice_type text NOT NULL CHECK (choice_type IN ('vehicle', 'waiver')),
  vehicle_id text NULL REFERENCES public.vehicle_catalog(id) ON DELETE RESTRICT,
  vehicle_snapshot jsonb NULL
    CHECK (vehicle_snapshot IS NULL OR jsonb_typeof(vehicle_snapshot) = 'object'),
  eligible boolean NOT NULL,
  result_snapshot jsonb NOT NULL CHECK (jsonb_typeof(result_snapshot) = 'object'),
  net_delta numeric NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (run_id, owner_user_id)
    REFERENCES public.advisor_calculation_runs(id, owner_user_id) ON DELETE CASCADE,
  UNIQUE (run_id, ordinal),
  CHECK (
    (choice_type = 'vehicle' AND vehicle_id IS NOT NULL)
    OR (choice_type = 'waiver' AND vehicle_id IS NULL)
  )
);

CREATE TABLE public.advisor_representative_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES public.advisor_conversations(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'claimed', 'answered', 'closed', 'cancelled')),
  topic text NULL CHECK (topic IS NULL OR length(topic) <= 120),
  assigned_representative_id uuid NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  requested_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz NULL,
  answered_at timestamptz NULL,
  closed_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (conversation_id, owner_user_id)
    REFERENCES public.advisor_conversations(id, owner_user_id) ON DELETE CASCADE,
  CHECK (
    (status = 'open' AND assigned_representative_id IS NULL AND claimed_at IS NULL)
    OR (status = 'claimed' AND assigned_representative_id IS NOT NULL AND claimed_at IS NOT NULL)
    OR (status = 'answered' AND assigned_representative_id IS NOT NULL AND answered_at IS NOT NULL)
    OR (status = 'closed' AND assigned_representative_id IS NOT NULL AND closed_at IS NOT NULL)
    OR (status = 'cancelled')
  )
);

CREATE INDEX advisor_employee_data_versions_owner_created_idx
  ON public.advisor_employee_data_versions(user_id, created_at DESC);
CREATE INDEX advisor_conversations_owner_recent_idx
  ON public.advisor_conversations(owner_user_id, last_message_at DESC, id DESC);
CREATE INDEX advisor_conversation_messages_conversation_recent_idx
  ON public.advisor_conversation_messages(conversation_id, created_at DESC, id DESC);
CREATE INDEX advisor_calculation_runs_owner_recent_idx
  ON public.advisor_calculation_runs(owner_user_id, created_at DESC);
CREATE INDEX advisor_calculation_scenarios_run_idx
  ON public.advisor_calculation_scenarios(run_id, ordinal);
CREATE INDEX advisor_representative_requests_queue_idx
  ON public.advisor_representative_requests(status, requested_at)
  WHERE status IN ('open', 'claimed', 'answered');
-- Answered requests retain reply access and remain active until explicitly closed.
CREATE UNIQUE INDEX advisor_representative_requests_one_active_per_conversation_idx
  ON public.advisor_representative_requests(conversation_id)
  WHERE status IN ('open', 'claimed', 'answered');

CREATE FUNCTION public.advisor_is_current_user_representative()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_profiles AS profile
    WHERE profile.id = (SELECT auth.uid())
      AND profile.role = 'representative'
  );
$$;
ALTER FUNCTION public.advisor_is_current_user_representative() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.advisor_is_current_user_representative()
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.advisor_is_current_user_representative()
  TO authenticated;

CREATE FUNCTION public.advisor_is_current_user_employee()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_profiles AS profile
    WHERE profile.id = (SELECT auth.uid())
      AND profile.role = 'employee'
  );
$$;
ALTER FUNCTION public.advisor_is_current_user_employee() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.advisor_is_current_user_employee()
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.advisor_is_current_user_employee()
  TO authenticated;

CREATE FUNCTION public.advisor_assign_employee_data_version()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(NEW.user_id::text, 0)
  );
  SELECT COALESCE(pg_catalog.max(version), 0) + 1
    INTO NEW.version
    FROM public.advisor_employee_data_versions
    WHERE user_id = NEW.user_id;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.advisor_assign_employee_data_version() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.advisor_assign_employee_data_version()
  FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER advisor_assign_employee_data_version_before_insert
  BEFORE INSERT ON public.advisor_employee_data_versions
  FOR EACH ROW EXECUTE FUNCTION public.advisor_assign_employee_data_version();

CREATE FUNCTION public.advisor_confirm_employee_data_version(p_version_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  current_user_id uuid := (SELECT auth.uid());
  confirmed_id uuid;
BEGIN
  IF current_user_id IS NULL OR NOT public.advisor_is_current_user_employee() THEN
    RAISE EXCEPTION 'Employee account required';
  END IF;

  UPDATE public.advisor_employee_data_versions
  SET status = 'confirmed', confirmed_at = pg_catalog.statement_timestamp()
  WHERE id = p_version_id
    AND user_id = current_user_id
    AND status = 'draft'
  RETURNING id INTO confirmed_id;

  IF confirmed_id IS NULL THEN
    RAISE EXCEPTION 'Draft version not found or already confirmed';
  END IF;
  RETURN confirmed_id;
END;
$$;
REVOKE ALL ON FUNCTION public.advisor_confirm_employee_data_version(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION public.advisor_confirm_employee_data_version(uuid) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION public.advisor_confirm_employee_data_version(uuid)
  TO authenticated;

CREATE FUNCTION public.advisor_touch_conversation_after_message()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.advisor_conversations
  SET last_message_at = GREATEST(last_message_at, NEW.created_at),
      updated_at = GREATEST(updated_at, NEW.created_at)
  WHERE id = NEW.conversation_id;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.advisor_touch_conversation_after_message()
  FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION public.advisor_touch_conversation_after_message() OWNER TO postgres;
CREATE TRIGGER advisor_touch_conversation_after_message_after_insert
  AFTER INSERT ON public.advisor_conversation_messages
  FOR EACH ROW EXECUTE FUNCTION public.advisor_touch_conversation_after_message();

CREATE FUNCTION public.advisor_mark_request_answered_on_representative_message()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.sender_type = 'representative' THEN
    UPDATE public.advisor_representative_requests
    SET status = 'answered',
        answered_at = COALESCE(answered_at, NEW.created_at),
        updated_at = NEW.created_at
    WHERE conversation_id = NEW.conversation_id
      AND assigned_representative_id = NEW.sender_user_id
      AND status IN ('claimed', 'answered');
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.advisor_mark_request_answered_on_representative_message()
  FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION public.advisor_mark_request_answered_on_representative_message() OWNER TO postgres;
CREATE TRIGGER advisor_mark_request_answered_after_representative_message
  AFTER INSERT ON public.advisor_conversation_messages
  FOR EACH ROW EXECUTE FUNCTION public.advisor_mark_request_answered_on_representative_message();

CREATE FUNCTION public.advisor_enforce_employee_data_version_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF OLD.status <> 'draft'
    OR NEW.id IS DISTINCT FROM OLD.id
    OR NEW.user_id IS DISTINCT FROM OLD.user_id
    OR NEW.version IS DISTINCT FROM OLD.version
    OR NEW.schema_version IS DISTINCT FROM OLD.schema_version
    OR NEW.display_name IS DISTINCT FROM OLD.display_name
    OR NEW.occupation_title IS DISTINCT FROM OLD.occupation_title
    OR NEW.base_salary IS DISTINCT FROM OLD.base_salary
    OR NEW.commissions IS DISTINCT FROM OLD.commissions
    OR NEW.bonus IS DISTINCT FROM OLD.bonus
    OR NEW.employee_pension_percent IS DISTINCT FROM OLD.employee_pension_percent
    OR NEW.employee_study_fund_percent IS DISTINCT FROM OLD.employee_study_fund_percent
    OR NEW.tax_credit_points IS DISTINCT FROM OLD.tax_credit_points
    OR NEW.eligible_children_count IS DISTINCT FROM OLD.eligible_children_count
    OR NEW.current_vehicle_id IS DISTINCT FROM OLD.current_vehicle_id
    OR NEW.current_participation IS DISTINCT FROM OLD.current_participation
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.status <> 'confirmed'
    OR NEW.confirmed_at IS NULL THEN
    RAISE EXCEPTION 'Only draft-to-confirmed transition is permitted; create a new version for changes';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.advisor_enforce_employee_data_version_transition()
  FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION public.advisor_enforce_employee_data_version_transition() OWNER TO postgres;
CREATE TRIGGER advisor_enforce_employee_data_version_transition_before_update
  BEFORE UPDATE ON public.advisor_employee_data_versions
  FOR EACH ROW EXECUTE FUNCTION public.advisor_enforce_employee_data_version_transition();

CREATE FUNCTION public.advisor_prevent_calculation_snapshot_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'Calculation history is immutable';
END;
$$;
REVOKE ALL ON FUNCTION public.advisor_prevent_calculation_snapshot_mutation()
  FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION public.advisor_prevent_calculation_snapshot_mutation() OWNER TO postgres;
CREATE TRIGGER advisor_calculation_runs_immutable
  BEFORE UPDATE ON public.advisor_calculation_runs
  FOR EACH ROW EXECUTE FUNCTION public.advisor_prevent_calculation_snapshot_mutation();
CREATE TRIGGER advisor_calculation_scenarios_immutable
  BEFORE UPDATE ON public.advisor_calculation_scenarios
  FOR EACH ROW EXECUTE FUNCTION public.advisor_prevent_calculation_snapshot_mutation();

CREATE FUNCTION public.advisor_create_conversation_with_first_message(
  p_body text,
  p_client_request_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  current_user_id uuid := (SELECT auth.uid());
  new_conversation_id uuid;
  inserted_conversation_id uuid;
BEGIN
  IF current_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;
  IF NOT public.advisor_is_current_user_employee() THEN
    RAISE EXCEPTION 'Employee account required';
  END IF;
  IF p_body IS NULL OR pg_catalog.length(pg_catalog.btrim(p_body)) NOT BETWEEN 1 AND 16000 THEN
    RAISE EXCEPTION 'Message must contain between 1 and 16000 characters';
  END IF;

  INSERT INTO public.advisor_employee_profiles(user_id)
    VALUES (current_user_id) ON CONFLICT (user_id) DO NOTHING;

  INSERT INTO public.advisor_conversations(owner_user_id, client_request_id)
    VALUES (current_user_id, p_client_request_id)
    ON CONFLICT (owner_user_id, client_request_id) DO NOTHING
    RETURNING id INTO inserted_conversation_id;

  IF inserted_conversation_id IS NULL THEN
    SELECT id INTO new_conversation_id
    FROM public.advisor_conversations
    WHERE owner_user_id = current_user_id
      AND client_request_id = p_client_request_id;

    IF NOT EXISTS (
      SELECT 1 FROM public.advisor_conversation_messages AS message
      WHERE message.conversation_id = new_conversation_id
        AND message.sender_type = 'employee'
        AND message.sender_user_id = current_user_id
        AND message.body = pg_catalog.btrim(p_body)
        AND message.id = (
          SELECT first_message.id
          FROM public.advisor_conversation_messages AS first_message
          WHERE first_message.conversation_id = new_conversation_id
          ORDER BY first_message.created_at, first_message.id
          LIMIT 1
        )
    ) THEN
      RAISE EXCEPTION 'Idempotency key reused with different request'
        USING ERRCODE = '23505';
    END IF;

    RETURN new_conversation_id;
  END IF;

  new_conversation_id := inserted_conversation_id;

  INSERT INTO public.advisor_conversation_messages(
    conversation_id, sender_type, sender_user_id, body
  ) VALUES (
    new_conversation_id, 'employee', current_user_id, pg_catalog.btrim(p_body)
  );

  RETURN new_conversation_id;
END;
$$;
ALTER FUNCTION public.advisor_create_conversation_with_first_message(text, uuid)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.advisor_create_conversation_with_first_message(text, uuid)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.advisor_create_conversation_with_first_message(text, uuid)
  TO authenticated;

CREATE FUNCTION public.advisor_claim_representative_request(p_request_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  current_user_id uuid := (SELECT auth.uid());
  claimed_id uuid;
BEGIN
  IF current_user_id IS NULL OR NOT public.advisor_is_current_user_representative() THEN
    RAISE EXCEPTION 'Representative account required';
  END IF;

  UPDATE public.advisor_representative_requests
  SET status = 'claimed',
      assigned_representative_id = current_user_id,
      claimed_at = pg_catalog.now(),
      updated_at = pg_catalog.now()
  WHERE id = p_request_id
    AND status = 'open'
    AND assigned_representative_id IS NULL
  RETURNING id INTO claimed_id;

  IF claimed_id IS NULL THEN
    RAISE EXCEPTION 'Request is unavailable or already claimed';
  END IF;

  RETURN claimed_id;
END;
$$;
ALTER FUNCTION public.advisor_claim_representative_request(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.advisor_claim_representative_request(uuid)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.advisor_claim_representative_request(uuid)
  TO authenticated;

CREATE FUNCTION public.advisor_append_assistant_message(
  p_conversation_id uuid,
  p_owner_user_id uuid,
  p_body text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  new_message_id uuid;
BEGIN
  IF p_owner_user_id IS NULL OR p_body IS NULL
    OR pg_catalog.length(pg_catalog.btrim(p_body)) NOT BETWEEN 1 AND 16000 THEN
    RAISE EXCEPTION 'Invalid assistant message input';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.advisor_conversations AS conversation
    WHERE conversation.id = p_conversation_id
      AND conversation.owner_user_id = p_owner_user_id
  ) THEN
    RAISE EXCEPTION 'Conversation not found';
  END IF;

  INSERT INTO public.advisor_conversation_messages(
    conversation_id, sender_type, sender_user_id, body
  ) VALUES (
    p_conversation_id, 'assistant', NULL, pg_catalog.btrim(p_body)
  ) RETURNING id INTO new_message_id;

  RETURN new_message_id;
END;
$$;
REVOKE ALL ON FUNCTION public.advisor_append_assistant_message(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION public.advisor_append_assistant_message(uuid, uuid, text) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION public.advisor_append_assistant_message(uuid, uuid, text)
  TO service_role;

CREATE FUNCTION public.advisor_create_calculation_snapshot(
  p_run jsonb,
  p_scenarios jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  new_run_id uuid;
  scenario jsonb;
BEGIN
  IF p_run IS NULL OR pg_catalog.jsonb_typeof(p_run) <> 'object'
    OR p_scenarios IS NULL OR pg_catalog.jsonb_typeof(p_scenarios) <> 'array'
    OR pg_catalog.jsonb_array_length(p_scenarios) < 1
    OR pg_catalog.jsonb_array_length(p_scenarios) > 20 THEN
    RAISE EXCEPTION 'Invalid calculation snapshot input';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.advisor_conversations AS conversation
    WHERE conversation.id = (p_run->>'conversation_id')::uuid
      AND conversation.owner_user_id = (p_run->>'owner_user_id')::uuid
  ) OR NOT EXISTS (
    SELECT 1 FROM public.advisor_employee_data_versions AS version
    WHERE version.id = (p_run->>'employee_data_version_id')::uuid
      AND version.user_id = (p_run->>'owner_user_id')::uuid
      AND version.status = 'confirmed'
  ) THEN
    RAISE EXCEPTION 'Conversation or confirmed employee data version not found';
  END IF;

  INSERT INTO public.advisor_calculation_runs(
    conversation_id, owner_user_id, employee_data_version_id,
    calculator_version, rules_version, tax_year,
    input_snapshot, baseline_snapshot
  ) VALUES (
    (p_run->>'conversation_id')::uuid,
    (p_run->>'owner_user_id')::uuid,
    (p_run->>'employee_data_version_id')::uuid,
    p_run->>'calculator_version',
    p_run->>'rules_version',
    (p_run->>'tax_year')::integer,
    p_run->'input_snapshot',
    NULLIF(p_run->'baseline_snapshot', 'null'::jsonb)
  ) RETURNING id INTO new_run_id;

  FOR scenario IN SELECT value FROM pg_catalog.jsonb_array_elements(p_scenarios)
  LOOP
    INSERT INTO public.advisor_calculation_scenarios(
      run_id, owner_user_id, ordinal, choice_type, vehicle_id,
      vehicle_snapshot, eligible, result_snapshot, net_delta
    ) VALUES (
      new_run_id,
      (p_run->>'owner_user_id')::uuid,
      (scenario->>'ordinal')::smallint,
      scenario->>'choice_type',
      scenario->>'vehicle_id',
      NULLIF(scenario->'vehicle_snapshot', 'null'::jsonb),
      (scenario->>'eligible')::boolean,
      scenario->'result_snapshot',
      NULLIF(scenario->>'net_delta', '')::numeric
    );
  END LOOP;

  RETURN new_run_id;
END;
$$;
REVOKE ALL ON FUNCTION public.advisor_create_calculation_snapshot(jsonb, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION public.advisor_create_calculation_snapshot(jsonb, jsonb) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION public.advisor_create_calculation_snapshot(jsonb, jsonb)
  TO service_role;

ALTER TABLE public.advisor_employee_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.advisor_employee_data_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.advisor_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.advisor_conversation_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.advisor_calculation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.advisor_calculation_scenarios ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.advisor_representative_requests ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.advisor_employee_profiles,
  public.advisor_employee_data_versions,
  public.advisor_conversations,
  public.advisor_conversation_messages,
  public.advisor_calculation_runs,
  public.advisor_calculation_scenarios,
  public.advisor_representative_requests FROM PUBLIC, anon, authenticated;

GRANT SELECT ON TABLE public.advisor_employee_profiles,
  public.advisor_employee_data_versions,
  public.advisor_conversations,
  public.advisor_conversation_messages,
  public.advisor_calculation_runs,
  public.advisor_calculation_scenarios,
  public.advisor_representative_requests TO authenticated;
GRANT INSERT (
  user_id, schema_version, display_name, occupation_title, base_salary,
  commissions, bonus, employee_pension_percent,
  employee_study_fund_percent, tax_credit_points,
  eligible_children_count, current_vehicle_id, current_participation
)
  ON public.advisor_employee_data_versions TO authenticated;
GRANT INSERT (conversation_id, sender_type, sender_user_id, body, client_message_id)
  ON public.advisor_conversation_messages TO authenticated;
GRANT INSERT (conversation_id, owner_user_id, topic)
  ON public.advisor_representative_requests TO authenticated;

CREATE POLICY advisor_employee_profiles_read_own
  ON public.advisor_employee_profiles FOR SELECT TO authenticated
  USING (
    user_id = (SELECT auth.uid())
    AND public.advisor_is_current_user_employee()
  );

CREATE POLICY advisor_employee_data_versions_read_own
  ON public.advisor_employee_data_versions FOR SELECT TO authenticated
  USING (
    user_id = (SELECT auth.uid())
    AND public.advisor_is_current_user_employee()
  );
CREATE POLICY advisor_employee_data_versions_insert_own_draft
  ON public.advisor_employee_data_versions FOR INSERT TO authenticated
  WITH CHECK (
    user_id = (SELECT auth.uid())
    AND public.advisor_is_current_user_employee()
    AND status = 'draft'
    AND confirmed_at IS NULL
  );
CREATE POLICY advisor_conversations_read_owner_or_assigned_rep
  ON public.advisor_conversations FOR SELECT TO authenticated
  USING (
    (
      public.advisor_is_current_user_employee()
      AND owner_user_id = (SELECT auth.uid())
    )
    OR (
      public.advisor_is_current_user_representative()
      AND EXISTS (
        SELECT 1 FROM public.advisor_representative_requests AS request
        WHERE request.conversation_id = advisor_conversations.id
          AND request.assigned_representative_id = (SELECT auth.uid())
          AND request.status IN ('claimed', 'answered')
      )
    )
  );
CREATE POLICY advisor_messages_read_owner_or_assigned_rep
  ON public.advisor_conversation_messages FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.advisor_conversations AS conversation
      WHERE conversation.id = advisor_conversation_messages.conversation_id
        AND public.advisor_is_current_user_employee()
        AND conversation.owner_user_id = (SELECT auth.uid())
    )
    OR (
      public.advisor_is_current_user_representative()
      AND EXISTS (
        SELECT 1 FROM public.advisor_representative_requests AS request
        WHERE request.conversation_id = advisor_conversation_messages.conversation_id
          AND request.assigned_representative_id = (SELECT auth.uid())
          AND request.status IN ('claimed', 'answered')
      )
    )
  );
CREATE POLICY advisor_employee_insert_own_message
  ON public.advisor_conversation_messages FOR INSERT TO authenticated
  WITH CHECK (
    sender_type = 'employee'
    AND sender_user_id = (SELECT auth.uid())
    AND public.advisor_is_current_user_employee()
    AND EXISTS (
      SELECT 1 FROM public.advisor_conversations AS conversation
      WHERE conversation.id = advisor_conversation_messages.conversation_id
        AND conversation.owner_user_id = (SELECT auth.uid())
    )
  );
CREATE POLICY advisor_representative_insert_assigned_reply
  ON public.advisor_conversation_messages FOR INSERT TO authenticated
  WITH CHECK (
    sender_type = 'representative'
    AND sender_user_id = (SELECT auth.uid())
    AND public.advisor_is_current_user_representative()
    AND EXISTS (
      SELECT 1 FROM public.advisor_representative_requests AS request
      WHERE request.conversation_id = advisor_conversation_messages.conversation_id
        AND request.assigned_representative_id = (SELECT auth.uid())
        AND request.status IN ('claimed', 'answered')
    )
  );

CREATE POLICY advisor_calculation_runs_read_owner_or_assigned_rep
  ON public.advisor_calculation_runs FOR SELECT TO authenticated
  USING (
    (
      public.advisor_is_current_user_employee()
      AND owner_user_id = (SELECT auth.uid())
    )
    OR (
      public.advisor_is_current_user_representative()
      AND EXISTS (
        SELECT 1 FROM public.advisor_representative_requests AS request
        WHERE request.conversation_id = advisor_calculation_runs.conversation_id
          AND request.assigned_representative_id = (SELECT auth.uid())
          AND request.status IN ('claimed', 'answered')
      )
    )
  );
CREATE POLICY advisor_calculation_scenarios_read_owner_or_assigned_rep
  ON public.advisor_calculation_scenarios FOR SELECT TO authenticated
  USING (
    (
      public.advisor_is_current_user_employee()
      AND owner_user_id = (SELECT auth.uid())
    )
    OR (
      public.advisor_is_current_user_representative()
      AND EXISTS (
        SELECT 1 FROM public.advisor_calculation_runs AS run
        JOIN public.advisor_representative_requests AS request
          ON request.conversation_id = run.conversation_id
        WHERE run.id = advisor_calculation_scenarios.run_id
          AND run.owner_user_id = advisor_calculation_scenarios.owner_user_id
          AND request.assigned_representative_id = (SELECT auth.uid())
          AND request.status IN ('claimed', 'answered')
      )
    )
  );

CREATE POLICY advisor_representative_requests_read_owner_or_queue
  ON public.advisor_representative_requests FOR SELECT TO authenticated
  USING (
    (
      public.advisor_is_current_user_employee()
      AND owner_user_id = (SELECT auth.uid())
    )
    OR (
      public.advisor_is_current_user_representative()
      AND (
        (status = 'open' AND assigned_representative_id IS NULL)
        OR assigned_representative_id = (SELECT auth.uid())
      )
    )
  );
CREATE POLICY advisor_employee_requests_insert_own_conversation
  ON public.advisor_representative_requests FOR INSERT TO authenticated
  WITH CHECK (
    owner_user_id = (SELECT auth.uid())
    AND public.advisor_is_current_user_employee()
    AND status = 'open'
    AND assigned_representative_id IS NULL
    AND claimed_at IS NULL
  );

COMMENT ON TABLE public.advisor_employee_data_versions IS
  'Employee-entered and employee-confirmed calculation inputs; not payroll source of truth.';
COMMENT ON TABLE public.advisor_calculation_runs IS
  'Immutable server-created historical calculation snapshots; contains sensitive salary data.';
COMMENT ON TABLE public.advisor_conversation_messages IS
  'Employee and assigned representative messages; assistant messages are server-created only.';
COMMENT ON COLUMN public.advisor_representative_requests.assigned_representative_id IS
  'ON DELETE RESTRICT intentionally prevents deleting a representative while retained requests reference them; reassign or explicitly retain/resolve those requests first.';
COMMENT ON COLUMN public.advisor_conversation_messages.sender_user_id IS
  'ON DELETE SET NULL preserves message content and sender type when a sender account is deleted; employee account deletion cascades its owned advisor_conversations and their messages.';

COMMIT;
