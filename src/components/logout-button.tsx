'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { CarWiseCarLoader } from './ui/carwise-car-loader';

export function LogoutButton() {
  const router = useRouter();
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);

  async function logout() {
    setPending(true);
    setError('');

    try {
      // The Supabase browser SDK is loaded only for this click, so it is not part of every page's first load.
      const { createSupabaseBrowserClient } = await import('@/lib/supabase-browser');
      const { error: signOutError } =
        await createSupabaseBrowserClient().auth.signOut();

      if (signOutError) {
        setError('לא הצלחנו להתנתק. נסו שוב.');
        setPending(false);
        return;
      }
    } catch {
      setError('לא הצלחנו להתנתק. נסו שוב.');
      setPending(false);
      return;
    }

    router.replace('/login');
    router.refresh();
  }

  return (
    <div className="flex flex-col items-start gap-2 sm:items-end">
      <button
        type="button"
        onClick={logout}
        onPointerEnter={() => { void import('@/lib/supabase-browser').catch(() => undefined); }}
        onFocus={() => { void import('@/lib/supabase-browser').catch(() => undefined); }}
        disabled={pending}
        className="rounded-lg border border-white/30 px-4 py-2 text-sm font-semibold text-white transition hover:bg-white/10 disabled:opacity-60"
      >
        {pending ? <CarWiseCarLoader variant="button" label="מתנתקים..." className="cw-on-dark" /> : 'התנתקות'}
      </button>
      {error && <span role="alert" className="text-xs text-rose-200">{error}</span>}
    </div>
  );
}