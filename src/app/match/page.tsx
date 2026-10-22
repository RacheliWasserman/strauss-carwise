import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { MatchApp } from '@/components/match/match-app';
import { getAuthenticatedProfile } from '@/lib/require-authenticated-user';
import { getOwnIdentity } from '@/lib/identity/identity-repository';
import { greetingName } from '@/lib/identity/greeting';
import { needsProfileCompletion } from '@/lib/identity/employee-identity';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'CarWise Match · התאמה אישית של רכב' };

export default async function MatchPage() {
  const profile = await getAuthenticatedProfile();
  if (!profile) redirect('/login');
  if (profile.role !== 'employee') redirect('/representative');
  const identity = await getOwnIdentity(profile.userId);
  if (needsProfileCompletion(identity.status)) redirect('/complete-profile');
  const account = identity.status === 'complete'
    ? { firstName: greetingName(identity.firstName), fullName: `${identity.firstName} ${identity.lastName}`.trim() } : undefined;
  return <MatchApp userId={profile.userId} account={account} />;
}
