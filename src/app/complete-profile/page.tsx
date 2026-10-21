import { redirect } from 'next/navigation';
import { ProfileCompletionForm } from '@/components/profile-completion-form';
import { getAuthenticatedProfile } from '@/lib/require-authenticated-user';
import { getOwnIdentity } from '@/lib/identity/identity-repository';
import { needsProfileCompletion } from '@/lib/identity/employee-identity';

export const dynamic = 'force-dynamic';

export default async function CompleteProfilePage() {
  const profile = await getAuthenticatedProfile();
  if (!profile) redirect('/login');
  if (profile.role !== 'employee') redirect('/representative');
  // Only an employee whose identity is known to be missing sees the form; 'unavailable' never blocks anyone.
  if (!needsProfileCompletion((await getOwnIdentity(profile.userId)).status)) redirect('/employee');
  return <ProfileCompletionForm />;
}
