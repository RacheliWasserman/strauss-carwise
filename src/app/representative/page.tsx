import { LogoutButton } from '@/components/logout-button';

export default function RepresentativePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-4xl flex-col justify-center px-6 py-16" dir="rtl">
      <div className="mb-8 flex items-center justify-between gap-4 rounded-xl bg-[#123f50] p-5 text-white">
        <p className="text-sm font-semibold text-teal-200">
          STRAUSS CARWISE · נציגים
        </p>
        <LogoutButton />
      </div>
      <h1 className="mt-4 text-3xl font-bold text-slate-900">
        ממשק הנציגים
      </h1>
      <p className="mt-3 max-w-xl text-slate-600">
        החשבון אומת כנציג. כלי העבודה לנציגים יתווספו בשלב הבא.
      </p>
    </main>
  );
}