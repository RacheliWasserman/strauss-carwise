export type UserRole = 'employee' | 'representative';

export function isUserRole(value: unknown): value is UserRole {
  return value === 'employee' || value === 'representative';
}