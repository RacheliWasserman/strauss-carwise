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