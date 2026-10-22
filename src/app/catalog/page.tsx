import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { CatalogApp } from '@/components/catalog/catalog-app';
import { getAuthenticatedProfile } from '@/lib/require-authenticated-user';
import { getOwnIdentity } from '@/lib/identity/identity-repository';
import { greetingName } from '@/lib/identity/greeting';
import { needsProfileCompletion } from '@/lib/identity/employee-identity';
import { loadShowroom } from '@/lib/catalog/showroom-service';
import { MODEL_ALIASES } from '@/lib/ai/vehicle-identification';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'קטלוג רכבי החברה · CarWise' };

export default async function CatalogPage() {
  const profile = await getAuthenticatedProfile();
  if (!profile) redirect('/login');
  if (profile.role !== 'employee') redirect('/representative');
  // The account name and the catalog with personal eligibility are independent reads: both start at once.
  const [identity, showroom] = await Promise.all([getOwnIdentity(profile.userId), loadShowroom(profile.userId)]);
  if (needsProfileCompletion(identity.status)) redirect('/complete-profile');
  const account = identity.status === 'complete'
    ? { firstName: greetingName(identity.firstName), fullName: `${identity.firstName} ${identity.lastName}`.trim() } : undefined;
  // Hebrew spellings for search, only for vehicles actually in the active catalog.
  const aliases = showroom.status === 'ready'
    ? Object.fromEntries(showroom.vehicles.map(vehicle => [vehicle.id, MODEL_ALIASES[vehicle.display_name] ?? []])) : {};
  return <CatalogApp userId={profile.userId} account={account} showroom={showroom} aliases={aliases} />;
}
