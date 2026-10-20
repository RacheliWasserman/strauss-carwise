// Structural SQL/source checks, not PostgreSQL execution or a browser test.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const migration = read('supabase/migrations/202610180002_phase2_persistence.sql');
const policies = [...migration.matchAll(
  /CREATE POLICY (\w+)\s+ON public\.(\w+) FOR (SELECT|INSERT) TO authenticated\s+([\s\S]*?);/g
)].map(([, name, table, action, body]) => ({ name, table, action, body }));

describe('advisor RLS structure', () => {
  it('has acyclic SELECT dependencies across every advisor policy', () => {
    const graph = new Map<string, string[]>();
    for (const policy of policies.filter(policy => policy.action === 'SELECT')) {
      graph.set(policy.table, [...policy.body.matchAll(/(?:FROM|JOIN) public\.(\w+)/g)].map(match => match[1]));
    }
    expect(graph.size).toBe(7);
    const walk = (table: string, ancestors: string[]) => {
      expect(ancestors, `RLS cycle at ${table}`).not.toContain(table);
      for (const dependency of graph.get(table) ?? []) walk(dependency, [...ancestors, table]);
    };
    for (const table of graph.keys()) walk(table, []);
    expect(graph.get('advisor_representative_requests')).toEqual([]);
    expect(graph.get('advisor_conversations')).toEqual(['advisor_representative_requests']);
    expect(graph.get('advisor_conversation_messages')).toEqual([
      'advisor_conversations', 'advisor_representative_requests'
    ]);
  });

  it('requires assignment and representative role for all representative content policies', () => {
    for (const table of ['advisor_conversations', 'advisor_conversation_messages', 'advisor_calculation_runs', 'advisor_calculation_scenarios']) {
      const policy = policies.find(policy => policy.table === table && policy.action === 'SELECT');
      expect(policy).toBeDefined();
      expect(policy!.body).toContain('public.advisor_is_current_user_representative()');
      expect(policy!.body).toContain('request.assigned_representative_id = (SELECT auth.uid())');
      expect(policy!.body).toContain("request.status IN ('claimed', 'answered')");
      expect(policy!.body).not.toContain("request.status = 'open'");
    }
  });

  it('keeps request insert ownership in a composite FK without a recursive policy', () => {
    const policy = policies.find(policy => policy.name === 'advisor_employee_requests_insert_own_conversation');
    expect(policy!.body).toContain('owner_user_id = (SELECT auth.uid())');
    expect(policy!.body).not.toMatch(/FROM|JOIN/);
    expect(migration).toMatch(/FOREIGN KEY \(conversation_id, owner_user_id\)\s+REFERENCES public\.advisor_conversations\(id, owner_user_id\)/);
  });
});

describe('persistent conversations and safe entry points', () => {
  it('permits only open conversations with no closed timestamp', () => {
    const table = migration.match(/CREATE TABLE public\.advisor_conversations \(([\s\S]*?)\n\);/)![1];
    expect(table).toContain("CHECK (status = 'open')");
    expect(table).toContain('CHECK (closed_at IS NULL)');
    expect(table).not.toMatch(/closed'|archived'/);
    // Neither a session identifier nor expiry drives retention.
    expect(table).not.toMatch(/session_id|expires_at/);
  });

  it('never closes conversations in any migration UPDATE or deletes advisor data', () => {
    const updates = [...migration.matchAll(/UPDATE public\.advisor_conversations\s+SET ([\s\S]*?)WHERE/g)];
    expect(updates).toHaveLength(1);
    expect(updates[0][1]).not.toMatch(/status|closed_at|owner_user_id/);
    expect(updates[0][1]).toContain('GREATEST(last_message_at, NEW.created_at)');
    expect(migration).not.toMatch(/DELETE FROM public\.advisor_/);
    expect(migration).not.toMatch(/GRANT (?:UPDATE|DELETE|ALL)[\s\S]*?TO authenticated/);
  });

  it('authentication and logout code contain no persistence writes or unload cleanup', () => {
    for (const file of ['src/components/logout-button.tsx', 'src/components/auth-form.tsx', 'src/app/auth/callback/route.ts', 'src/middleware.ts']) {
      const source = read(file);
      expect(source).not.toMatch(/advisor_|\.delete\(|\.update\(|\.rpc\(|beforeunload|onunload/);
    }
    expect(read('src/components/logout-button.tsx')).toContain('.auth.signOut()');
  });

  it('grants execute only on the intended RPCs and role helpers', () => {
    const grants = [...migration.matchAll(/GRANT EXECUTE ON FUNCTION public\.(\w+)\([^;]*?\)\s+TO (\w+);/g)]
      .map(([, name, role]) => [name, role]);
    expect(grants).toEqual([
      ['advisor_is_current_user_representative', 'authenticated'],
      ['advisor_is_current_user_employee', 'authenticated'],
      ['advisor_confirm_employee_data_version', 'authenticated'],
      ['advisor_create_conversation_with_first_message', 'authenticated'],
      ['advisor_claim_representative_request', 'authenticated'],
      ['advisor_append_assistant_message', 'service_role'],
      ['advisor_create_calculation_snapshot', 'service_role']
    ]);
    const functions = [...migration.matchAll(/CREATE FUNCTION public\.(\w+)\([\s\S]*?AS \$\$([\s\S]*?)\$\$;/g)];
    expect(functions).toHaveLength(12);
    for (const [definition, name] of functions) {
      expect(definition).toContain("SET search_path = ''");
      expect(migration).toMatch(new RegExp(`ALTER FUNCTION public\\.${name}\\([^;]*?\\)\\s+OWNER TO postgres;`));
      expect(migration).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${name}\\([^;]*?\\)\\s+FROM PUBLIC, anon,`));
    }
  });

  it('checks shared prerequisites without creating or changing them', () => {
    expect(migration).toContain('Phase 2 requires public.user_profiles from Phase 1');
    expect(migration).toContain('key.indisunique AND key.indisvalid AND key.indimmediate');
    expect(migration).toContain('key.indpred IS NULL AND key.indexprs IS NULL');
    expect(migration).toContain('key.indnkeyatts = 1');
    expect(migration).not.toMatch(/(?:CREATE|ALTER) TABLE (?:public\.(?:user_profiles|vehicle_catalog)|auth\.users)/);
    const phase1 = read('supabase/migrations/202610180001_auth_profiles.sql');
    expect(phase1).toMatch(/owner to postgres;\s+grant execute on function public\.set_user_profile_role/);
  });
});
