import { redirect } from 'next/navigation';
import { EmployeeChat } from '@/components/chat/employee-chat';
import { getAuthenticatedProfile } from '@/lib/require-authenticated-user';
import { getOwnIdentity } from '@/lib/identity/identity-repository';
import { greetingName } from '@/lib/identity/greeting';
import { needsProfileCompletion } from '@/lib/identity/employee-identity';

export const dynamic = 'force-dynamic';

export default async function EmployeePage() {
  const profile = await getAuthenticatedProfile();
  if (!profile) redirect('/login');
  if (profile.role !== 'employee') redirect('/representative');
  const identity = await getOwnIdentity(profile.userId);
  // Accounts without a stored name complete it once; if identity storage is not available, nobody is blocked.
  if (needsProfileCompletion(identity.status)) redirect('/complete-profile');
  // The account's own stored name (never inferred from chat text). Absent until the identity migration is applied.
  const account = identity.status === 'complete'
    ? { firstName: greetingName(identity.firstName), fullName: `${identity.firstName} ${identity.lastName}`.trim() } : undefined;
  return <EmployeeChat key={profile.userId} userId={profile.userId} account={account} />;
}
