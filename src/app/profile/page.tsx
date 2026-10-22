import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { ProfileApp } from '@/components/profile/profile-app';
import { getAuthenticatedProfile } from '@/lib/require-authenticated-user';
import { getOwnIdentity } from '@/lib/identity/identity-repository';
import { greetingName } from '@/lib/identity/greeting';
import { needsProfileCompletion } from '@/lib/identity/employee-identity';
import { loadOwnProfile } from '@/lib/profile/profile-service';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'הפרופיל שלי · CarWise' };

export default async function ProfilePage() {
  const profile = await getAuthenticatedProfile();
  if (!profile) redirect('/login');
  if (profile.role !== 'employee') redirect('/representative');
  // The account name and the profile data are independent reads: both start at once.
  const [identity, data] = await Promise.all([getOwnIdentity(profile.userId), loadOwnProfile(profile.userId)]);
  if (needsProfileCompletion(identity.status)) redirect('/complete-profile');
  const account = identity.status === 'complete'
    ? { firstName: greetingName(identity.firstName), fullName: `${identity.firstName} ${identity.lastName}`.trim() } : undefined;
  // Only the name is passed for display; the national ID is never read here.
  const accountName = identity.status === 'complete' ? { firstName: identity.firstName, lastName: identity.lastName } : null;
  return <ProfileApp userId={profile.userId} account={account} accountName={accountName} data={data} />;
}
