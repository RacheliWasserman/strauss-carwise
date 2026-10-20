import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL('../supabase/migrations/202610180002_phase2_persistence.sql', import.meta.url),
  'utf8'
);

describe('Phase 2 migration security invariants', () => {
  it('enables RLS on all seven persistence tables', () => {
    const tables = [
      'advisor_employee_profiles',
      'advisor_employee_data_versions',
      'advisor_conversations',
      'advisor_conversation_messages',
      'advisor_calculation_runs',
      'advisor_calculation_scenarios',
      'advisor_representative_requests'
    ];

    for (const table of tables) {
      expect(migration).toMatch(
        new RegExp(`ALTER TABLE public\\.${table} ENABLE ROW LEVEL SECURITY;`, 'i')
      );
    }
  });

  it('creates the first employee message atomically without an employee table link', () => {
    expect(migration).toMatch(/to_regprocedure\('public\.advisor_create_conversation_with_first_message\(text\)'\)/i);
    expect(migration).toMatch(/advisor_create_conversation_with_first_message\([\s\S]*?p_client_request_id uuid default null/i);
    expect(migration).toMatch(/unique \(owner_user_id, client_request_id\)/i);
    expect(migration).toMatch(/on conflict \(owner_user_id, client_request_id\) do nothing/i);
    expect(migration).toMatch(/idempotency key reused with different request/i);
    expect(migration).toMatch(/insert into public\.advisor_conversations\(owner_user_id, client_request_id\)/i);
    expect(migration).toMatch(/'employee', current_user_id, pg_catalog\.btrim\(p_body\)/i);
    expect(migration).not.toMatch(/advisor_create_conversation_with_first_message[\s\S]{0,1500}public\.employees/i);
    expect(migration).not.toMatch(/grant insert \(owner_user_id, title\)[\s\S]{0,100}public\.advisor_conversations/i);
    expect(migration).toMatch(/references public\.advisor_employee_data_versions\(id, user_id\) on delete cascade/i);
  });

  it('keeps assistant message creation service-role-only', () => {
    expect(migration).toMatch(/revoke all on function public\.advisor_append_assistant_message\(uuid, uuid, text\)[\s\S]*?from public, anon, authenticated, service_role/i);
    expect(migration).toMatch(/grant execute on function public\.advisor_append_assistant_message\(uuid, uuid, text\)[\s\S]*?to service_role/i);
  });

  it('qualifies PostgreSQL built-ins used by empty-search-path definer functions', () => {
    const definerBodies = Array.from(
      migration.matchAll(/CREATE FUNCTION public\.[\s\S]*?SECURITY DEFINER[\s\S]*?AS \$\$([\s\S]*?)\$\$;/gi),
      match => match[1]
    ).join('\n');

    expect(migration).toMatch(/pg_catalog\.pg_advisory_xact_lock\([\s\S]*?pg_catalog\.hashtextextended\(/i);
    expect(migration).toMatch(/pg_catalog\.max\(version\)/i);
    expect(migration).toMatch(/pg_catalog\.statement_timestamp\(\)/i);
    expect(migration).toMatch(/pg_catalog\.jsonb_typeof\(/i);
    expect(migration).toMatch(/pg_catalog\.jsonb_array_elements\(/i);
    expect(migration).toMatch(/pg_catalog\.length\(pg_catalog\.btrim\(p_body\)\)/i);
    expect(definerBodies).not.toMatch(/(?<!pg_catalog\.)\b(pg_advisory_xact_lock|hashtextextended|statement_timestamp|jsonb_typeof|jsonb_array_length|jsonb_array_elements|length|btrim|now|max)\s*\(/i);
  });

  it('keeps RLS dependencies acyclic and owner access employee-only', () => {
    const conversationPolicy = migration.match(
      /CREATE POLICY advisor_conversations_read_owner_or_assigned_rep[\s\S]*?;/i
    )?.[0] ?? '';
    const requestReadPolicy = migration.match(
      /CREATE POLICY advisor_representative_requests_read_owner_or_queue[\s\S]*?;/i
    )?.[0] ?? '';

    expect(conversationPolicy).toMatch(/public\.advisor_is_current_user_employee\(\)[\s\S]*?owner_user_id = \(SELECT auth\.uid\(\)\)/i);
    expect(conversationPolicy).toMatch(/public\.advisor_is_current_user_representative\(\)[\s\S]*?FROM public\.advisor_representative_requests/i);
    expect(requestReadPolicy).toMatch(/public\.advisor_is_current_user_employee\(\)[\s\S]*?owner_user_id = \(SELECT auth\.uid\(\)\)/i);
    expect(requestReadPolicy).not.toMatch(/FROM public\.advisor_conversations/i);
    const requestInsertPolicy = migration.match(
      /CREATE POLICY advisor_employee_requests_insert_own_conversation[\s\S]*?;/i
    )?.[0] ?? '';
    expect(requestInsertPolicy).not.toMatch(/FROM public\.advisor_conversations/i);
    expect(migration).toMatch(/FOREIGN KEY \(conversation_id, owner_user_id\)[\s\S]*?REFERENCES public\.advisor_conversations\(id, owner_user_id\)/i);
    expect(migration).toMatch(/GRANT SELECT ON TABLE[\s\S]*?public\.advisor_conversations[\s\S]*?public\.advisor_representative_requests TO authenticated/i);
    expect(migration).toMatch(/public\.advisor_is_current_user_employee\(\)[\s\S]*?conversation\.owner_user_id = \(SELECT auth\.uid\(\)\)/i);
  });

  it('preserves sender history while defining account-deletion behavior', () => {
    expect(migration).toMatch(/sender_user_id uuid NULL REFERENCES auth\.users\(id\) ON DELETE SET NULL/i);
    expect(migration).toMatch(/assigned_representative_id uuid NULL REFERENCES auth\.users\(id\) ON DELETE RESTRICT/i);
    expect(migration).toMatch(/owner_user_id uuid NOT NULL REFERENCES auth\.users\(id\) ON DELETE CASCADE/i);
    expect(migration).toMatch(/COMMENT ON COLUMN public\.advisor_representative_requests\.assigned_representative_id IS[\s\S]*?ON DELETE RESTRICT intentionally/i);
    expect(migration).toMatch(/COMMENT ON COLUMN public\.advisor_conversation_messages\.sender_user_id IS[\s\S]*?ON DELETE SET NULL preserves message content/i);
  });

  it('makes employee message retries idempotent and blocks client impersonation', () => {
    expect(migration).toMatch(/unique \(conversation_id, client_message_id\)/i);
    expect(migration).toMatch(/sender_type = 'employee'[\s\S]*?sender_user_id = \(select auth\.uid\(\)\)/i);
    expect(migration).toMatch(/sender_type = 'representative'[\s\S]*?sender_user_id = \(select auth\.uid\(\)\)/i);
    expect(migration).not.toMatch(/grant insert[\s\S]{0,180}sender_type, sender_user_id[\s\S]{0,100}assistant/i);
  });

  it('limits active representative requests to one per conversation', () => {
    expect(migration).toMatch(/create unique index advisor_representative_requests_one_active_per_conversation_idx[\s\S]*?where status in \('open', 'claimed', 'answered'\)/i);
    expect(migration).toMatch(/advisor_claim_representative_request[\s\S]*?where id = p_request_id[\s\S]*?and status = 'open'[\s\S]*?and assigned_representative_id is null/i);
  });

  it('does not grant clients writes to calculation snapshots', () => {
    expect(migration).not.toMatch(/grant insert[\s\S]{0,200}on public\.advisor_calculation_runs to authenticated/i);
    expect(migration).not.toMatch(/grant insert[\s\S]{0,200}on public\.advisor_calculation_scenarios to authenticated/i);
    expect(migration).toMatch(/advisor_calculation_runs_immutable[\s\S]*?before update on public\.advisor_calculation_runs/i);
    expect(migration).toMatch(/advisor_calculation_scenarios_immutable[\s\S]*?before update on public\.advisor_calculation_scenarios/i);
    expect(migration).toMatch(/create function public\.advisor_create_calculation_snapshot[\s\S]*?security definer[\s\S]*?set search_path = ''[\s\S]*?alter function public\.advisor_create_calculation_snapshot\(jsonb, jsonb\) owner to postgres/i);
  });
});


describe('isolated advisor namespace', () => {
  it('creates exactly seven advisor tables and never targets legacy relations', () => {
    const tables = [...migration.matchAll(/CREATE TABLE public\.(\w+)/g)].map(match => match[1]);
    expect(tables).toHaveLength(7);
    expect(tables.every(name => name.startsWith('advisor_'))).toBe(true);
    const publicObjects = [...migration.matchAll(/public\.(\w+)/g)].map(match => match[1]);
    expect(publicObjects.every(name => name.startsWith('advisor_') || ['user_profiles', 'vehicle_catalog'].includes(name))).toBe(true);
    expect(migration).not.toMatch(/\b(DROP|TRUNCATE|RENAME)\s/i);
    for (const match of migration.matchAll(/CREATE (?:FUNCTION public\.|(?:UNIQUE )?INDEX |TRIGGER |POLICY )(\w+)/g)) {
      expect(match[1]).toMatch(/^advisor_/);
      expect(match[1].length).toBeLessThanOrEqual(63);
    }
  });

  it('wraps installation in a transaction and rejects advisor namespace collisions', () => {
    expect(migration).toMatch(/BEGIN;[\s\S]*DO \$\$/);
    expect(migration.trim()).toMatch(/COMMIT;$/);
    expect(migration).toContain("left(relation.relname, 8) = 'advisor_'");
    expect(migration).toContain("left(routine.proname, 8) = 'advisor_'");
  });

  it('uses text vehicle references and restricts request insertion to defaulted status', () => {
    expect(migration).toMatch(/current_vehicle_id text NULL REFERENCES public\.vehicle_catalog\(id\)/);
    expect(migration).toMatch(/vehicle_id text NULL REFERENCES public\.vehicle_catalog\(id\)/);
    expect(migration).toMatch(/GRANT INSERT \(conversation_id, owner_user_id, topic\)[\s\S]*?ON public\.advisor_representative_requests TO authenticated/);
  });
});
