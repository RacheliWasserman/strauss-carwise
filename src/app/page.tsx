
'use client';

import { useEffect, useState } from 'react';
import {
  displayShekels,
  type Calculation
} from '@/lib/calculator';
import { LogoutButton } from '@/components/logout-button';
import { CarWiseCarLoader } from '@/components/ui/carwise-car-loader';

type EmployeeOption = {
  id: string;
  name: string;
  occupation: string;
  salary: number;
  group: string;
};

type CarOption = {
  id: string;
  name: string;
  group: string;
};

type DashboardData = {
  employees: EmployeeOption[];
  cars: CarOption[];
};

type Comparison = {
  eligible: boolean;
  reason: string;
  today: Calculation;
  after: Calculation | null;
  delta: number | null;
};

const fmt = (value: number) =>
  new Intl.NumberFormat('he-IL', {
    maximumFractionDigits: 0
  }).format(displayShekels(value)) + ' ₪';

const rows: {
  label: string;
  key: keyof Calculation;
}[] = [
  { label: 'ברוטו', key: 'gross' },
  { label: 'שווי שימוש', key: 'carValueOfUse' },
  { label: 'בסיס מס', key: 'taxableIncome' },
  { label: 'מס הכנסה', key: 'incomeTax' },
  { label: 'ביטוח לאומי', key: 'nationalInsurance' },
  { label: 'ביטוח בריאות', key: 'health' },
  { label: 'פנסיה עובד', key: 'pension' },
  { label: 'קרן השתלמות עובד', key: 'studyFund' },
  { label: 'השתתפות ברכב', key: 'participation' },
  { label: 'תוספת מסלול משפחתי', key: 'familyExtra' },
  { label: 'אחזקת רכב בוויתור', key: 'maintenance' },
  { label: 'החזר חשמל ברוטו מגולם', key: 'electricGrossUp' }
];

export default function Home() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [employeeId, setEmployeeId] = useState('');
  const [choiceId, setChoiceId] = useState('CAR-10');
  const [comparison, setComparison] =
    useState<Comparison | null>(null);
  const [loading, setLoading] = useState(true);
  const [calculating, setCalculating] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;

    async function load() {
      try {
        const response = await fetch('/api/dashboard', {
          cache: 'no-store'
        });

        if (!response.ok) {
          throw new Error('טעינת הנתונים נכשלה');
        }

        const result: DashboardData = await response.json();

        if (!active) return;

        setData(result);
        setEmployeeId(result.employees[0]?.id ?? '');
      } catch (err) {
        if (active) {
          setError(
            err instanceof Error ? err.message : 'שגיאה בטעינה'
          );
        }
      } finally {
        if (active) setLoading(false);
      }
    }

    void load();

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!employeeId) return;

    const controller = new AbortController();

    async function calculate() {
      setCalculating(true);
      setComparison(null);
      setError('');

      try {
        const response = await fetch('/api/dashboard', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            employeeId,
            carId: choiceId
          }),
          signal: controller.signal
        });

        const result = await response.json();

        if (!response.ok) {
          throw new Error(
            result.detail ?? result.error ?? 'שגיאה בחישוב'
          );
        }

        if (!controller.signal.aborted) {
          setComparison(result as Comparison);
        }
      } catch (err) {
        if (
          !controller.signal.aborted &&
          !(err instanceof Error && err.name === 'AbortError')
        ) {
          setError(
            err instanceof Error ? err.message : 'שגיאה בחישוב'
          );
        }
      } finally {
        if (!controller.signal.aborted) {
          setCalculating(false);
        }
      }
    }

    void calculate();

    return () => controller.abort();
  }, [employeeId, choiceId]);

  const employee = data?.employees.find(
    item => item.id === employeeId
  );

  const today = comparison?.today;
  const after = comparison?.after;
  const delta = comparison?.delta;

  return (
    <main
      dir="rtl"
      className="mx-auto max-w-5xl px-5 py-10 space-y-8"
    >
      <header className="rounded-3xl bg-[#123f50] text-white p-8 shadow-lg">
        <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
          <div className="text-sm text-teal-200">
            STRAUSS · CAR ADVISOR · DEMO
          </div>
          <LogoutButton />
        </div>
        <h1 className="text-3xl font-bold mb-3">
          יועץ הרכב החכם של שטראוס
        </h1>
        <p className="text-slate-200">
          השוואת רכבים והשפעתם על הנטו — על בסיס נתוני
          האתגר, בחישוב שקוף ודטרמיניסטי.
        </p>
      </header>

      {loading && (
        <div className="bg-white rounded-2xl">
          <CarWiseCarLoader variant="inline" label="הנתונים נטענים..." className="justify-center p-6" />
        </div>
      )}

      {error && (
        <p className="bg-rose-50 text-rose-800 p-5 rounded-xl">
          {error}
        </p>
      )}

      {data && employee && (
        <section className="grid md:grid-cols-2 gap-5">
          <label className="block bg-white p-6 rounded-2xl shadow-sm">
            <span className="block font-bold mb-3">
              בחירת פרופיל לדוגמה
            </span>

            <select
              className="w-full rounded-xl border border-slate-300 p-3"
              value={employeeId}
              onChange={event => {
                setEmployeeId(event.target.value);
                setChoiceId('WAIVER');
              }}
            >
              {data.employees.map(item => (
                <option key={item.id} value={item.id}>
                  {item.name} · {item.occupation}
                </option>
              ))}
            </select>

            <div className="mt-4 text-sm text-slate-600">
              שכר בסיס: {fmt(employee.salary)}
              {' · '}
              קבוצת זכאות: {employee.group}
            </div>
          </label>

          <label className="block bg-white p-6 rounded-2xl shadow-sm">
            <span className="block font-bold mb-3">
              בחירת חלופה
            </span>

            <select
              className="w-full rounded-xl border border-slate-300 p-3"
              value={choiceId}
              onChange={event => setChoiceId(event.target.value)}
            >
              <option value="WAIVER">
                ויתור על רכב (אם זכאים)
              </option>

              {data.cars.map(car => (
                <option key={car.id} value={car.id}>
                  {car.name} · קבוצה {car.group}
                </option>
              ))}
            </select>

            {calculating && (
              <CarWiseCarLoader variant="inline" label="ההשוואה בחישוב..." className="mt-4" />
            )}

            {comparison && !calculating && (
              <div
                className={
                  'mt-4 text-sm ' +
                  (comparison.eligible
                    ? 'text-emerald-700'
                    : 'text-rose-700')
                }
              >
                {comparison.eligible ? '✓ ' : '✕ '}
                {comparison.reason}
              </div>
            )}
          </label>
        </section>
      )}

      {today !== undefined &&
 after != null &&
 delta != null &&
 !calculating && (
        <>
          <section className="grid md:grid-cols-3 gap-4">
            <article className="bg-white rounded-2xl p-6 shadow-sm">
              <p className="text-slate-500 mb-2">
                נטו היום
              </p>
              <strong className="text-3xl">
                {fmt(today.net)}
              </strong>
            </article>

            <article className="bg-white rounded-2xl p-6 shadow-sm">
              <p className="text-slate-500 mb-2">
                נטו בחלופה
              </p>
              <strong className="text-3xl">
                {fmt(after.net)}
              </strong>
            </article>

            <article
             className="bg-teal-50 rounded-2xl p-6 shadow-sm">
              <p className="text-slate-600 mb-2">
                השינוי בנטו
              </p>
              <strong
                className={
                  'text-3xl ' +
                  (delta >= 0
                    ? 'text-emerald-700'
                    : 'text-rose-700')
                }
              >
                {delta > 0 ? '+' : ''}
                {fmt(delta)}
              </strong>
            </article>
          </section>

          <section className="bg-white rounded-2xl p-6 shadow-sm">
            <h2 className="text-xl font-bold mb-4">
              פירוט החישוב
            </h2>

            <div className="grid grid-cols-3 border-b pb-3 font-bold text-sm">
              <span>רכיב</span>
              <span>היום</span>
              <span>חלופה</span>
            </div>

            {rows.map(row => (
              <div
                key={row.key}
                className="grid grid-cols-3 py-3 border-b border-slate-100 text-sm"
              >
                <span>{row.label}</span>
                <span>{fmt(today[row.key] ?? 0)}</span>
                <span>{fmt(after[row.key] ?? 0)}</span>
              </div>
            ))}
          </section>
        </>
      )}

      {comparison && !comparison.eligible && !calculating && (
        <p className="bg-rose-50 text-rose-800 p-5 rounded-xl">
          לא ניתן לחשב חלופה שאינה עומדת בכללי הזכאות.
        </p>
      )}

      <footer className="text-xs text-slate-500 leading-6">
        סביבת הדגמה: העובדים והנתונים פיקטיביים.
        הנתונים נטענים מ־Supabase. הסימולציה משתמשת
        בלוחות המס ובפישוטי השכר של האתגר (2025),
        ואינה תחליף לתלוש שכר רשמי.
      </footer>
    </main>
  );
}
