import { redirect } from 'next/navigation';
import { EmployeeChat } from '@/components/chat/employee-chat';
import { getAuthenticatedProfile } from '@/lib/require-authenticated-user';

export const dynamic = 'force-dynamic';

export default async function EmployeePage() {
  const profile = await getAuthenticatedProfile();
  if (!profile) redirect('/login');
  if (profile.role !== 'employee') redirect('/representative');
  return <EmployeeChat key={profile.userId} userId={profile.userId} />;
}
