/**
 * The one answer to a sign-up that is waiting for e-mail confirmation. It is also the answer when the address or the
 * national ID already belongs to an account (non-enumerating), so it never claims that an e-mail was sent.
 */
export const REGISTRATION_RECEIVED =
  'קיבלנו את הבקשה. אם אפשר לפתוח חשבון עם הפרטים האלה, יישלח בדקות הקרובות אימייל לאישור החשבון. ' +
  'לא הגיע אימייל? ייתכן שכבר קיים חשבון עם הפרטים שהוזנו. אפשר לנסות להתחבר, או לפנות לתמיכה.';

export function getHebrewAuthError(message: string): string {
  const normalized = message.toLowerCase();

  if (
    normalized.includes('invalid login credentials') ||
    normalized.includes('invalid credentials')
  ) {
    return 'כתובת האימייל או הסיסמה שגויות.';
  }

  if (
    normalized.includes('already registered') ||
    normalized.includes('user already exists')
  ) {
    return 'כבר קיים חשבון עם כתובת האימייל הזו. אפשר להתחבר במקום.';
  }

  if (
    normalized.includes('password') &&
    (normalized.includes('short') || normalized.includes('weak'))
  ) {
    return 'הסיסמה אינה עומדת בדרישות. בחרו סיסמה חזקה יותר.';
  }

  if (normalized.includes('email not confirmed')) {
    return 'יש לאשר את כתובת האימייל דרך הקישור שנשלח אליכם.';
  }

  if (normalized.includes('rate limit')) {
    return 'בוצעו יותר מדי ניסיונות. נסו שוב בעוד מספר דקות.';
  }

  return 'הפעולה לא הושלמה. בדקו את הפרטים ונסו שוב.';
}