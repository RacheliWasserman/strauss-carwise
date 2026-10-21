import { z } from 'zod';

/**
 * Employee identity as entered at sign-up or profile completion. The national ID is self-reported and unverified:
 * it is validated for format and checksum only, never shown in full, and never sent to an AI provider, a log,
 * a chat message or a calculation snapshot. Shared by the browser (early feedback) and the server (enforcement).
 */

/** Digits only, padded to 9 with leading zeros ("12345674" → "012345674"); null when not 5–9 digits. */
export function normalizeIsraeliId(input: string): string | null {
  const digits = input.replace(/[\s-]/g, '');
  if (!/^\d{5,9}$/.test(digits)) return null;
  return digits.padStart(9, '0');
}

/** Israeli ID check digit: digits weighted 1,2,1,2…; two-digit products are summed; the total divides by 10. */
export function isValidIsraeliId(input: string): boolean {
  const id = normalizeIsraeliId(input);
  if (!id || id === '000000000') return false;
  let sum = 0;
  for (let index = 0; index < 9; index++) {
    const product = Number(id[index]) * (index % 2 === 0 ? 1 : 2);
    sum += product > 9 ? product - 9 : product;
  }
  return sum % 10 === 0;
}

/** For the rare place an ID must be referred to on screen: the last two digits only. */
export const maskIsraeliId = (id: string) => `•••••••${(normalizeIsraeliId(id) ?? '').slice(-2)}`;

const NAME = /^[\p{L}][\p{L}\p{M}'’״"׳\- ]*$/u;
const name = (label: string) => z.string().trim().min(1, `יש למלא ${label}.`).max(60, `${label} ארוך מדי.`)
  .transform(value => value.replace(/\s+/g, ' '))
  .refine(value => NAME.test(value), `${label} יכול לכלול אותיות, רווח, מקף או גרש בלבד.`);

export const identityInputSchema = z.object({
  firstName: name('שם פרטי'),
  lastName: name('שם משפחה'),
  nationalId: z.string().trim().max(12).transform((value, context) => {
    const id = normalizeIsraeliId(value);
    if (!id || !isValidIsraeliId(id)) {
      context.addIssue({ code: 'custom', message: 'מספר תעודת הזהות אינו תקין. יש לבדוק את הספרות, כולל ספרת הביקורת.' });
      return z.NEVER;
    }
    return id;
  })
}).strict();
export type IdentityInput = z.infer<typeof identityInputSchema>;

export const registrationSchema = identityInputSchema.extend({
  email: z.string().trim().toLowerCase().email('כתובת האימייל אינה תקינה.').max(254),
  password: z.string().min(8, 'נדרשת סיסמה של 8 תווים לפחות.').max(128)
}).strict();

/** The first problem of a failed parse, as a sentence for the form (never echoes the submitted ID). */
export function firstIssue(error: z.ZodError) {
  const issue = error.issues[0];
  return issue?.code === 'unrecognized_keys' ? 'הבקשה כוללת שדות שאינם נתמכים.' : issue?.message ?? 'הפרטים אינם תקינים.';
}

/** Only an account whose identity is known to be missing completes it; 'unavailable' (e.g. migration not applied) never blocks. */
export const needsProfileCompletion = (status: 'complete' | 'missing' | 'unavailable') => status === 'missing';

/** The name the advisor uses: first name and last name exactly as the employee entered them. */
export const fullName = (identity: { first_name: string; last_name: string }) => `${identity.first_name} ${identity.last_name}`.trim();
