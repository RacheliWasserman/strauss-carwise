import { redirect } from 'next/navigation';
import { EmployeeChat, type VehicleIntent } from '@/components/chat/employee-chat';
import { getAuthenticatedProfile } from '@/lib/require-authenticated-user';
import { getOwnIdentity } from '@/lib/identity/identity-repository';
import { greetingName } from '@/lib/identity/greeting';
import { needsProfileCompletion } from '@/lib/identity/employee-identity';
import { resolveVehicleIntent } from '@/lib/catalog/showroom-service';

export const dynamic = 'force-dynamic';

export default async function EmployeePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const profile = await getAuthenticatedProfile();
  if (!profile) redirect('/login');
  if (profile.role !== 'employee') redirect('/representative');
  const identity = await getOwnIdentity(profile.userId);
  // Accounts without a stored name complete it once; if identity storage is not available, nobody is blocked.
  if (needsProfileCompletion(identity.status)) redirect('/complete-profile');
  // The account's own stored name (never inferred from chat text). Absent until the identity migration is applied.
  const account = identity.status === 'complete'
    ? { firstName: greetingName(identity.firstName), fullName: `${identity.firstName} ${identity.lastName}`.trim() } : undefined;
  // A vehicle chosen on the catalog page (exact active catalog ID only); the chat sends its selection once.
  const intent: VehicleIntent | undefined = await resolveVehicleIntent((await searchParams).vehicle);
  return <EmployeeChat key={profile.userId} userId={profile.userId} account={account} vehicleIntent={intent} />;
}
