# Phase 2 advisor persistence review

The migration is unapplied. Local tests and a build do not establish database
compatibility or validate PostgreSQL execution. Do not execute this migration
without a separate approval and database review.

## Isolation and API behavior

The seven new tables are `advisor_employee_profiles`,
`advisor_employee_data_versions`, `advisor_conversations`,
`advisor_conversation_messages`, `advisor_calculation_runs`,
`advisor_calculation_scenarios`, and `advisor_representative_requests`.
All new functions, indexes, triggers, and policies also use `advisor_` names.
The migration aborts on existing advisor relations or routines and runs inside
one transaction. It does not reconcile, replace, grant access to, or change
legacy tables or Phase 1 objects.

HTTP route names remain unchanged. Message pagination now requires both
`before` (the exact PostgreSQL timestamp) and `beforeId` (UUID), or neither.
Responses preserve `messages` in chronological order and add `nextCursor`:
`{ before, beforeId }` or `null`. Send cursor fields with `URLSearchParams`
so timezone `+` signs are correctly encoded. A full final page may return a
cursor whose following page is empty. Timestamp-only requests return 400.

Representative requests insert only granted columns; the database supplies
the initial `open` status. `open`, `claimed`, and `answered` all count toward
the single-active-request constraint. Answered requests stay visible to their
assigned representative, who can continue replying. A new assignment requires
explicitly closing/cancelling the previous request through a future controlled
workflow; closing/reassignment endpoints are not implemented in this change.
The repository also bounds assignment lookup to one row defensively.

Employee reads remain owner-only. Representatives can inspect only open queue
request metadata before claiming; conversation, messages, and calculation
snapshots require assignment. Request policies do not query conversations,
avoiding a recursive RLS dependency. Composite foreign keys enforce request,
calculation-run, and employee-version ownership. Assistant and calculation RPCs
remain service-role-only, behind authenticated server ownership checks.

## Read-only checks required before application

Run only with approved read-only database access. Review results locally;
do not publish function definitions if they contain embedded credentials.

```sql
-- Existing advisor objects must be absent, including overloads and indexes.
SELECT n.nspname, c.relname, c.relkind, c.relrowsecurity, c.relacl
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND left(c.relname, 8) = 'advisor_';

SELECT p.oid::regprocedure, pg_get_userbyid(p.proowner),
       p.prosecdef, p.proconfig, p.proacl
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND left(p.proname, 8) = 'advisor_';

-- Verify types, defaults, and nullability of existing shared/legacy relations.
SELECT table_name, column_name, data_type, udt_name,
       is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN ('user_profiles', 'vehicle_catalog', 'conversations',
                     'messages', 'comparison_results', 'representative_requests')
ORDER BY table_name, ordinal_position;

-- Confirm vehicle_catalog.id and auth.users.id have eligible unique keys.
-- Include all public FKs to preserve a record of legacy relationships.
SELECT c.conrelid::regclass, c.conname, c.contype,
       c.confrelid::regclass, pg_get_constraintdef(c.oid)
FROM pg_constraint c JOIN pg_class r ON r.oid = c.conrelid
JOIN pg_namespace n ON n.oid = r.relnamespace
WHERE n.nspname = 'public' OR c.conrelid = 'auth.users'::regclass
ORDER BY c.conrelid::regclass::text, c.conname;

SELECT tablename, indexname, indexdef
FROM pg_indexes WHERE schemaname = 'public';

-- Capture baseline RLS, grants, triggers, and views.
SELECT * FROM pg_policies WHERE schemaname = 'public';
SELECT * FROM information_schema.table_privileges
WHERE table_schema = 'public';
SELECT * FROM information_schema.column_privileges
WHERE table_schema = 'public';
SELECT t.tgrelid::regclass, t.tgname, pg_get_triggerdef(t.oid)
FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname IN ('public', 'auth') AND NOT t.tgisinternal;
SELECT schemaname, viewname, definition FROM pg_views
WHERE schemaname = 'public';
SELECT schemaname, matviewname, definition FROM pg_matviews
WHERE schemaname = 'public';

-- Read migration history only if the relation exists.
SELECT to_regclass('supabase_migrations.schema_migrations');
-- If present, separately run:
-- SELECT version FROM supabase_migrations.schema_migrations ORDER BY version;

-- Verify execution-role capabilities without changing permissions.
SELECT current_user, rolname, rolsuper, rolbypassrls
FROM pg_roles
WHERE rolname IN (current_user, 'postgres', 'authenticated', 'anon', 'service_role');
SELECT to_regprocedure('gen_random_uuid()');
SELECT * FROM pg_publication_tables WHERE schemaname = 'public';
```

Also inspect relevant existing public function definitions for dependencies on
the four legacy relations, record their row counts without retrieving content,
and confirm external consumers and catalog maintenance behavior. Phase 1 was
manually applied; do not rerun it because a migration-history entry is absent.
Confirm the Phase 2 version is not recorded before revising an unapplied file.
The applying role must be permitted to assign new function ownership to postgres.
Verify schema usage/default ACLs and availability of the named Supabase roles.

## Required database validation after separate authorization

First use a disposable Supabase/PostgreSQL instance reproducing the legacy
schema, including populated legacy fixtures and existing FKs. Apply the migration
there only with explicit authorization. Compare legacy definitions, grants,
policies, triggers, and data before/after. Verify transaction rollback on a
collision and a failed installation. Test real JWT/role RLS behavior, direct
REST requests, wrong-owner FKs, anonymous denial, forged senders, service-only
RPCs, concurrent claims and retries, first-message atomicity, employee version
confirmation, immutable snapshots, and rollback of a failed scenario insert.
SQL text tests and mocked repository tests cannot replace these checks.

Vehicle references use TEXT and RESTRICT deletion of referenced catalog IDs.
Retain catalog IDs and deactivate vehicles instead of deleting them. Auth-user
deletion cascades owned advisor records; representative deletion is restricted
while requests reference that representative. History immutability prevents
updates, not authorized account-deletion cascades.

This change provides persistence only. Chat UI, Gemini orchestration, an employee
calculation adapter, and representative-request close/reassignment
APIs remain future work. Financial calculations must continue to run exclusively
in the existing TypeScript calculator. Store resolved rules, occupation, vehicle
tax inputs, and outputs when implementing calculation orchestration.

For application rollback, disable the new workflow or revert its application
changes while retaining advisor records. No legacy-table rollback is needed.


## Persistent conversation lifecycle

A conversation always stays `open` in this phase, with `closed_at` NULL. Refresh,
browser closure, sign-out, and sign-in do not end it, alter it, or delete it.
There is no conversation finish button, expiry, session FK, or automatic closing
job. Reads and replies do not depend on session age. Conversation details now
accept both authenticated roles; the user-scoped query and RLS restrict a
representative to assigned conversations. This does not grant access to other
employees or representatives. Request status is separate from conversation
status: a representative reply marks the request answered, never the conversation.
Message timestamps use GREATEST so concurrent older transactions cannot move
the conversation backwards in recent-history ordering.

The inspected SELECT-policy dependency graph has no cycle:
messages -> conversations -> requests; messages -> requests;
calculation scenarios -> runs -> requests. Requests query no advisor table.
Role helpers read only user_profiles as postgres with an empty search path.
No direct client UPDATE/DELETE grants or policies are provided.

Installation into an entirely empty Supabase project is intentionally not
standalone: the business vehicle_catalog with a suitable TEXT/VARCHAR unique
ID and the Phase 1 user_profiles must already exist. New preflight checks
require standard Supabase roles and a valid immediate non-partial vehicle ID
unique index. An invalid trailing character in the local Phase 1 migration was
removed solely to allow fresh-environment syntax validation; do not rerun the
applied Phase 1 migration on production. No local PostgreSQL or Docker executable
was available during this review, so installation and actual RLS execution remain
unverified. Structural SQL tests and mocked HTTP/session tests are not database
or browser end-to-end tests. Existing employee/representative pages remain
placeholders, and a full history UI is still required for ChatGPT-like navigation.
The conversation-list API now supports the same paired before/beforeId cursor
as messages, using last_message_at and id (default 50, maximum 100 per page),
so older conversations are no longer hidden behind a fixed first-page limit.
List pages sort newest first. Activity can move a conversation to an earlier
page, so clients should refresh/deduplicate the list when new messages arrive.
