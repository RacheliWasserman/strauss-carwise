import { redirect } from 'next/navigation';
import { LogoutButton } from '@/components/logout-button';
import { RepresentativeConsole } from '@/components/representative/representative-console';
import { getAuthenticatedProfile } from '@/lib/require-authenticated-user';

export const dynamic = 'force-dynamic';

export default async function RepresentativePage() {
  // The middleware already restricts this page; the server check keeps it safe on its own.
  const profile = await getAuthenticatedProfile();
  if (!profile) redirect('/login');
  if (profile.role !== 'representative') redirect('/employee');
  return (
    <div className="min-h-screen bg-[#f3f7f7]" dir="rtl">
      <header className="bg-gradient-to-l from-[#0f3542] via-[#123f50] to-[#17606a] text-white shadow-md">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-4 px-6 py-6">
          <div className="min-w-0">
            <p className="text-xs font-semibold tracking-wide text-teal-200">STRAUSS CARWISE · נציגים</p>
            <h1 className="mt-1 text-2xl font-bold leading-snug md:text-3xl">מרכז הפניות לנציגים</h1>
            <p className="mt-1 text-sm leading-relaxed text-slate-200">שאלות ממוקדות על פרט שכר חסר. כל תשובה נכנסת לפרופיל רק אחרי אישור בשיחה.</p>
          </div>
          <LogoutButton />
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
        <RepresentativeConsole userId={profile.userId} />
      </main>
    </div>
  );
}
