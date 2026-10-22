import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getAuthenticatedProfile } from '@/lib/require-authenticated-user';
import { loadMatchContext } from '@/lib/match/match-service';
import { matchPreferencesSchema, nextQuestion, rankVehicles } from '@/lib/match/match-engine';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Only preferences: identity, eligibility and every value come from the server.
const input = z.object({ preferences: matchPreferencesSchema }).strict();
const headers = { 'Cache-Control': 'private, no-store' };

export async function POST(request: Request) {
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) return NextResponse.json({ error: 'אין הרשאה לפעולה הזו.' }, { status: 403, headers });
  const profile = await getAuthenticatedProfile();
  if (!profile) return NextResponse.json({ error: 'כדי להמשיך, צריך להתחבר שוב.' }, { status: 401, headers });
  if (profile.role !== 'employee') return NextResponse.json({ error: 'אין הרשאה לפעולה הזו.' }, { status: 403, headers });
  let preferences;
  try {
    const raw = await request.text();
    if (raw.length > 1024) throw new SyntaxError('Too large');
    preferences = input.parse(JSON.parse(raw)).preferences;
  } catch { return NextResponse.json({ error: 'הבקשה אינה תקינה.' }, { status: 400, headers }); }
  try {
    const context = await loadMatchContext(profile.userId);
    if (context.status === 'unavailable') return NextResponse.json({ status: 'unavailable', error: 'הנתונים להתאמה לא זמינים כרגע. אפשר לנסות שוב עוד מעט.' }, { status: 503, headers });
    if (context.status === 'needs_profile') return NextResponse.json(context, { headers });
    return NextResponse.json({ status: 'ready', basis: context.basis, powertrains: context.powertrains, notes: context.notes,
      outcome: rankVehicles(context.candidates, preferences), question: nextQuestion(context.candidates, preferences) }, { headers });
  } catch {
    console.warn('[carwise.match]', { outcome: 'unavailable' });
    return NextResponse.json({ status: 'unavailable', error: 'הנתונים להתאמה לא זמינים כרגע. אפשר לנסות שוב עוד מעט.' }, { status: 503, headers });
  }
}
