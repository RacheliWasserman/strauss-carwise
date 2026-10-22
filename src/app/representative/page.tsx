import { redirect } from 'next/navigation';
import { LogoutButton } from '@/components/logout-button';
import { BrandLockup } from '@/components/brand/brand-lockup';
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
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-x-6 gap-y-3 px-4 py-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-5">
            <BrandLockup tone="light" size="sm" />
            <div className="min-w-0 border-r border-white/20 pr-5">
              <h1 className="text-lg font-bold leading-snug md:text-xl">מרכז הפניות לנציגים</h1>
              <p className="hidden text-xs leading-relaxed text-slate-200 sm:block">שאלות ממוקדות על פרט שכר חסר. כל תשובה נכנסת לפרופיל רק אחרי אישור בשיחה.</p>
            </div>
          </div>
          <LogoutButton />
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-5 sm:px-6">
        <RepresentativeConsole userId={profile.userId} />
      </main>
    </div>
  );
}
