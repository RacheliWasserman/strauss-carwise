import { NextResponse } from 'next/server';
import { requireApiRole } from '@/lib/persistence-api-auth';
import { listRepresentativeQueue } from '@/lib/representative-request-repository';
// Relative path: runs for real in the route tests (the test runner has no '@/' alias).
import { getEmployeeOccupations, getEmployeeSummaries } from '../../../lib/identity/identity-repository';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The representative's queue: open requests and requests assigned to this representative (RLS-scoped).
 * Each request carries the employee's stored name, occupation title and the LAST FOUR ID digits (to tell identical
 * names apart), read server-side for exactly these requests. The full national ID, conversation content, salary data
 * and calculations are never part of this response; the full ID has its own endpoint for the assigned representative.
 */
export async function GET() {
  const access = await requireApiRole('representative');
  if (access.response) return access.response;

  try {
    const queue = await listRepresentativeQueue();
    const owners = queue.map(request => request.owner_user_id);
    const [people, occupations] = await Promise.all([getEmployeeSummaries(owners), getEmployeeOccupations(owners)]);
    const requests = queue.map(request => ({ id: request.id, conversation_id: request.conversation_id, status: request.status,
      topic: request.topic, assigned_representative_id: request.assigned_representative_id, requested_at: request.requested_at,
      answered_at: request.answered_at, employee_name: people.get(request.owner_user_id)?.name ?? null,
      employee_id_last4: people.get(request.owner_user_id)?.idLast4 ?? null, occupation: occupations.get(request.owner_user_id) ?? null }));
    // Identity coverage only (counts), to tell a missing identity record from a missing migration in the logs.
    console.info('[carwise.representative.queue]', { requests: requests.length, withName: requests.filter(item => item.employee_name).length });
    return NextResponse.json({ requests }, { headers: { 'Cache-Control': 'no-store, private' } });
  } catch {
    return NextResponse.json({ error: 'לא ניתן לטעון את תור הבקשות' }, { status: 500 });
  }
}
