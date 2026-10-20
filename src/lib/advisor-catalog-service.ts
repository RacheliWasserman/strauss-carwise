import 'server-only';
import { z } from 'zod';
import { createSupabaseServerClient } from './supabase-server';
import { searchVehicles } from './vehicle-repository';
import { advisorVehicleRowSchema, advisorVehicleSearchSchema, type AdvisorVehicleSearch } from './advisor-data-validation';

export class AdvisorCatalogDataError extends Error {
  constructor() { super('Invalid vehicle catalog data'); }
}

export async function searchAdvisorVehicles(input: AdvisorVehicleSearch) {
  const filters = advisorVehicleSearchSchema.parse(input);
  const client = await createSupabaseServerClient();
  const raw = await searchVehicles(client, filters);
  const validated = z.array(advisorVehicleRowSchema).max(filters.limit + 1).safeParse(raw);
  if (!validated.success) throw new AdvisorCatalogDataError();
  const rows = validated.data;
  // Do not normalize database IDs: they must be the exact stored identifier.
  if (raw.some((row, index) => (row as { id?: unknown }).id !== rows[index].id) ||
    new Set(rows.map(row => row.id)).size !== rows.length) throw new AdvisorCatalogDataError();
  const hasMore = rows.length > filters.limit;
  const page = rows.slice(0, filters.limit);
  return {
    vehicles: page.map(({ id, display_name, manufacturer_name, group_code, drive_type }) =>
      ({ id, display_name, manufacturer_name, group_code, drive_type })),
    match: rows.length === 0 ? 'none' as const : rows.length === 1 ? 'single' as const : 'multiple' as const,
    hasMore, nextCursor: hasMore ? page[page.length - 1].id : null
  };
}
