# יועץ הרכב של שטראוס — אבן דרך 1

פרויקט Next.js + TypeScript להצגת השוואת נטו בין רכב קיים לחלופה לפי **כללי האתגר**. נתוני זמן הריצה העסקיים מגיעים מ־Supabase. קובצי JSON נשמרו עבור בדיקות בלבד. אין עדיין AI או כלי עבודה לנציגים.

## הפעלה

דרוש Node.js 20.9 ומעלה.

```bash
npm install
npm test
npm run dev
```

פותחים http://localhost:3000. לבדיקה של גרסת Production: `npm run build` ואז `npm start`.

## קבצים חשובים

- `data/rules.json` — הכללים המקוריים של האתגר.
- `data/cars.json`, `data/occupations.json`, `data/employees.json`, `data/reference.json` — חילוץ גיליונות Excel.
- `data/tax-records.json` — 21 רשומות מאגר רשות המסים לשנת 2026 שמתאימות ל־20 רכבי הקטלוג (רכב אחד מופיע בשתי רשומות שונות). לא כלל המאגר.
- `src/lib/data.ts` — שכבת נתונים, מפתחות וקבלת שווי שימוש.
- `src/lib/calculator.ts` — זכאות, מס, ביטוח לאומי ובריאות, הפרשות, השתתפות, ויתור, מסלול משפחתי וגילום.
- `tests/calculator.test.ts` — בדיקות נתוני המקור וששת תרחישי הייחוס.
- `src/app/page.tsx` — מסך השוואה ראשון, מבוסס על ששת העובדים הפיקטיביים.
- `src/app/api/compare/route.ts` — API חישוב לחלופה (ללא שמירת נתונים).
- `src/lib/supabase-browser.ts`, `src/lib/supabase-server.ts` ו־`middleware.ts` — Supabase Auth, cookies ובקרת גישה לפי role.
- `supabase/migrations/202610180001_auth_profiles.sql` — טבלת פרופילים ו־RLS. יש לעבור עליה ולהריץ ידנית.

## החלטות ואזהרות

- חישוב המס **חודשי ולא מצטבר** ולפי לוחות **2025**, כנדרש בקובץ האתגר. אינו מתאים להפקת תלוש שכר אמיתי.
- קוד תוצר וקוד דגם נשמרים כמחרוזות, לרבות אפסים מובילים.
- חיפוש רשומת המס כולל שנת מס, שנת רישום, קוד סוג רכב, קוד תוצר וקוד דגם. כל רכבי הדוגמה אומתו עם קוד סוג רכב 1.
- לא מתבצע עיגול במהלך החישוב; עיגול לשקל בתצוגה בלבד.
- החזר חשמל הוא **250 ₪ נטו** דרך גילום ברוטו, ללא השפעה על בסיס ההפרשות.
- התוצאות מתייחסות לנתוני דמה, ולא למערכת השכר של שטראוס.
- ממשקי ההשוואה הישנים עובדים עם ששת עובדי הדמו. ה־API שלהם פתוח רק ב־development ונחסם בפרודקשן עד לחיבור מאובטח לעובד המחובר.
- לפני פריסה עם שכר אמיתי נדרשים קישור עובד ל־`auth.users`, הרשאות API מצומצמות, מדיניות פרטיות ושמירה, הגבלת בקשות ובדיקות אבטחה.

## Supabase Auth — Phase 1

1. העתיקו את `.env.example` ל־`.env.local` והגדירו `NEXT_PUBLIC_SUPABASE_URL` ו־`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` מתוך Supabase Project Settings → API. `SUPABASE_SECRET_KEY` נדרש רק עבור פעולות שרת קיימות; לעולם אין לחשוף אותו בדפדפן.
2. בדקו את `supabase/migrations/202610180001_auth_profiles.sql` מול הסכמה הקיימת והריצו אותו ידנית ב־Supabase SQL Editor או דרך תהליך migrations מאושר. הוא יוצר `user_profiles`, RLS, פרופיל employee אוטומטי ופעולת role ייעודית ל־`service_role`; הוא אינו משנה טבלאות עסקיות. אין להריץ את קובץ ה־SQL אוטומטית מהאפליקציה.
3. בפרודקשן הגדירו Site URL כ־`https://strauss-carwise.vercel.app`, והוסיפו Redirect URL מדויק `https://strauss-carwise.vercel.app/auth/callback`. הגדירו ב־Vercel Production גם `APP_SITE_URL=https://strauss-carwise.vercel.app`. לפיתוח מקומי אפשר להוסיף בנפרד `http://localhost:3000/auth/callback`. ראו [הגדרות אימות אימייל בפרודקשן](docs/auth-production-redirects.md), כולל תבנית האימייל ובדיקת הפרויקט הנכון.
4. הפעילו אימות אימייל או בחרו במדיניות הארגונית הרצויה. מסך ההרשמה שולח redirect ל־callback; לאחר אישור נוצרת session ונקרא role מטבלת `user_profiles`.
5. משתמשים חדשים מקבלים `employee` דרך trigger ולא דרך metadata. לקביעת נציג, מנהל מורשה יכול להריץ פעולה מאומתת דרך `public.set_user_profile_role(user_uuid, 'representative')` באמצעות `service_role` בלבד. אין endpoint ציבורי לשינוי role.

### בדיקה ידנית

1. הפעילו `npm run dev` ופתחו `/register`.
2. הירשמו עם כתובת אימייל שבשליטתכם ובדקו הודעת אישור בעברית.
3. פתחו את קישור האישור; הוא אמור לחזור דרך `/auth/callback` ולפתוח את ממשק העובד.
4. רעננו את העמוד וודאו שה־session נשמר.
5. לחצו על „התנתקות”, ודאו מעבר ל־`/login`, ואז נסו לפתוח `/` כשהמשתמש מנותק; middleware אמור להפנות חזרה להתחברות.
6. כדי לבדוק נציג, שנו role רק באמצעות פעולה ניהולית מורשית, התחברו מחדש וודאו הפניה אל `/representative`. אין ממשק נציג עסקי בשלב זה.

ה־dashboard וה־compare APIs הישנים נשארים במצב demo וחסומים בפרודקשן. ב־development נציגים מורשים יכולים להמשיך להשתמש בדמו; עובדים אינם יכולים לבקש נתוני שכר לפי employee ID ומגיעים למסך אישי מוגן שממתין לקישור רשומת עובד ל־`auth.uid()` ולהרשאה לפי בעלות. בפרודקשן נציגים מגיעים בינתיים למסך placeholder.

## Phase 2 — Persistence foundation

- `supabase/migrations/202610180002_phase2_persistence.sql` מוסיף שיחות, הודעות, גרסאות נתוני עובד, snapshots ובקשות נציג עם RLS. יש לבדוק ולהריץ ידנית רק אחרי Phase 1; האפליקציה אינה מריצה migrations.
- Routes זמינים: `GET/POST /api/conversations`, `GET /api/conversations/:id`, `GET/POST /api/conversations/:id/messages`, `GET/POST /api/employee-data`, `POST /api/employee-data/confirm`, `POST /api/conversations/:id/representative-requests`, `GET /api/representative-requests`, `POST /api/representative-requests/:id/claim`.
- הודעת AI נשמרת רק באמצעות repository שרת שמשתמש ב־service-only RPC לאחר בדיקת בעלות. אין כרגע קריאה למודל AI או יצירת תשובת AI אוטומטית.
- נתוני עובד שהוזנו נשמרים בטבלת גרסאות נפרדת ואינם נכתבים לטבלת `employees`. חישובים היסטוריים נקראים דרך repository; כתיבת snapshots מיועדת למסלול שרת שמחשב בפועל.

## השלב הבא

לאחר שכל בדיקות הייחוס עוברות: שמירת שיחות מאובטחת, מסך נציג, אינטגרציית Gemini עם function calling שמפעיל רק פונקציות חישוב מאומתות, ושכבת אישור לשאלות ללא מענה.


## Isolated advisor persistence (unapplied)

Phase 2 creates only the seven `advisor_` tables and prefixed RPCs, indexes, triggers, and policies. Legacy `conversations`, `messages`, `comparison_results`, `representative_requests`, and Phase 1 authentication objects are preserved. Never apply the old unprefixed SQL.

See [the Phase 2 review and validation guide](docs/phase2-persistence.md) before any database application. The migration has not been executed or verified against live Supabase.

Run `node scripts/validate-phase2.cjs` for TypeScript, Vitest, and a production build in an isolated temporary copy. It excludes environment files, uses dummy credentials, and blocks HTTP/fetch requests. It does not run SQL.
