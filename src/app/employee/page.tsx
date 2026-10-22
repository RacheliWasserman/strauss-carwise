import { redirect } from 'next/navigation';
import { EmployeeChat, type VehicleIntent } from '@/components/chat/employee-chat';
import { getAuthenticatedProfile } from '@/lib/require-authenticated-user';
import { getOwnIdentity } from '@/lib/identity/identity-repository';
import { greetingName } from '@/lib/identity/greeting';
import { needsProfileCompletion } from '@/lib/identity/employee-identity';
import { resolveComparisonIntent, resolveVehicleIntent } from '@/lib/catalog/showroom-service';

export const dynamic = 'force-dynamic';

export default async function EmployeePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const profile = await getAuthenticatedProfile();
  if (!profile) redirect('/login');
  if (profile.role !== 'employee') redirect('/representative');
  // The account name and the catalog/Match links are independent reads: all start at once (each link is read only
  // when present in the URL).
  const params = await searchParams;
  const [identity, intent, comparison] = await Promise.all([getOwnIdentity(profile.userId),
    resolveVehicleIntent(params.vehicle) as Promise<VehicleIntent | undefined>, resolveComparisonIntent(params.compare)]);
  // Accounts without a stored name complete it once; if identity storage is not available, nobody is blocked.
  if (needsProfileCompletion(identity.status)) redirect('/complete-profile');
  // The account's own stored name (never inferred from chat text). Absent until the identity migration is applied.
  const account = identity.status === 'complete'
    ? { firstName: greetingName(identity.firstName), fullName: `${identity.firstName} ${identity.lastName}`.trim() } : undefined;
  // intent: a vehicle chosen on the catalog page (exact active catalog ID only); the chat sends its selection once.
  // comparison: vehicles to compare, chosen in CarWise Match (exact active catalog IDs only).
  return <EmployeeChat key={profile.userId} userId={profile.userId} account={account} vehicleIntent={intent} comparisonIntent={comparison} />;
}
