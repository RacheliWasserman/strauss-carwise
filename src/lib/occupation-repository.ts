import 'server-only';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { createSupabaseServerClient } from './supabase-server';

const amount = z.union([z.number(), z.string().regex(/^\d+(?:\.\d+)?$/).transform(Number)])
  .pipe(z.number().finite().nonnegative());
export const occupationSchema = z.object({
  title: z.string().trim().min(1).max(120), group_code: z.enum(['א','ב','ג','ד']),
  car_mandatory: z.boolean(), waiver_allowed: z.boolean(), waiver_maintenance_amount: amount
});
export type AdvisorOccupation = z.infer<typeof occupationSchema> & { key: string };

/** Key is an application reference derived from the official title, NOT an assumed DB id. */
export async function listAdvisorOccupations(): Promise<AdvisorOccupation[]> {
  const client = await createSupabaseServerClient();
  const { data, error } = await client.from('occupations')
    .select('title, group_code, car_mandatory, waiver_allowed, waiver_maintenance_amount')
    .order('title').limit(201);
  if (error) throw new Error('Occupation catalog unavailable');
  // Never claim uniqueness using a truncated or malformed candidate set.
  const rows = z.array(occupationSchema).max(200).parse(data);
  if (new Set(rows.map(row=>row.title)).size !== rows.length) throw new Error('Occupation titles are ambiguous');
  return rows.map(row=>({...row,key:createHash('sha256').update(row.title).digest('hex')}));
}
