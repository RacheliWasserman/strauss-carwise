import { z } from 'zod';

const text = (max: number) => z.string().trim().min(1).max(max)
  .refine(value => !/[\u0000-\u001F\u007F]/u.test(value), 'Invalid text');
export const advisorVehicleSearchSchema = z.object({
  name: text(120).optional(), manufacturer: text(120).optional(),
  group: z.enum(['א', 'ב', 'ג', 'ד', 'משפחתי']).optional(),
  driveType: text(60).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  afterId: text(200).optional()
}).strict();

// No price/tax/participation/eligibility claims in this catalog-only step.
export const advisorVehicleRowSchema = z.object({
  id: text(200),
  display_name: text(200), manufacturer_name: text(200),
  group_code: z.enum(['א', 'ב', 'ג', 'ד', 'משפחתי']),
  drive_type: text(100), active: z.literal(true)
});
export type AdvisorVehicleSearch = z.infer<typeof advisorVehicleSearchSchema>;

const searchFields = Object.keys(advisorVehicleSearchSchema.shape);
type SearchIssue = { field: string; reason: 'unknown_parameter' | 'duplicate_parameter' | 'invalid_value' };
export function parseAdvisorVehicleSearch(params: URLSearchParams):
  { success: true; data: AdvisorVehicleSearch } | { success: false; issues: SearchIssue[] } {
  // A null-prototype dictionary avoids special property names; omitted fields
  // stay undefined so the schema supplies its existing default limit of 20.
  const input: Record<string, string> = Object.create(null);
  for (const [key, value] of params) {
    if (!searchFields.includes(key)) return { success: false, issues: [{ field: 'query', reason: 'unknown_parameter' }] };
    if (Object.hasOwn(input, key)) return { success: false, issues: [{ field: key, reason: 'duplicate_parameter' }] };
    input[key] = value;
  }
  const parsed = advisorVehicleSearchSchema.safeParse(input);
  if (parsed.success) return { success: true, data: parsed.data };
  return { success: false, issues: parsed.error.issues.map(issue => ({
    field: typeof issue.path[0] === 'string' && searchFields.includes(issue.path[0]) ? issue.path[0] : 'query',
    reason: 'invalid_value'
  })) };
}
