import { AuthForm } from '@/components/auth-form';

const messages: Record<string, string> = {
  profile: 'לא נמצא פרופיל פעיל לחשבון. פנו לתמיכה הארגונית.',
  config: 'הגדרות ההתחברות חסרות. יש לפנות למנהלת המערכת.',
  callback: 'קישור האישור אינו תקף או שפג תוקפו. בקשו קישור חדש.'
};

export default async function LoginPage({
  searchParams
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

  return <AuthForm mode="login" initialError={error ? messages[error] ?? '' : ''} />;
}