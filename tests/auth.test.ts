import { describe, expect, it } from 'vitest';
import { getHebrewAuthError } from '../src/lib/auth-errors';
import { isUserRole } from '../src/lib/auth-types';

describe('authentication role validation', () => {
  it('accepts only the two supported database roles', () => {
    expect(isUserRole('employee')).toBe(true);
    expect(isUserRole('representative')).toBe(true);
    expect(isUserRole('admin')).toBe(false);
    expect(isUserRole(null)).toBe(false);
  });
});

describe('Hebrew authentication errors', () => {
  it('maps invalid credentials to a safe Hebrew message', () => {
    expect(getHebrewAuthError('Invalid login credentials'))
      .toBe('כתובת האימייל או הסיסמה שגויות.');
  });

  it('does not expose unrecognized provider error details', () => {
    expect(getHebrewAuthError('database internal server diagnostic'))
      .toBe('הפעולה לא הושלמה. בדקו את הפרטים ונסו שוב.');
  });
});