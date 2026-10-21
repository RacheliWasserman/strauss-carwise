import { z } from 'zod';

export const groupSchema = z.enum(['א', 'ב', 'ג', 'ד']);
export const catalogFiltersSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  manufacturer: z.string().trim().min(1).max(120).optional(),
  group: z.enum(['א', 'ב', 'ג', 'ד', 'משפחתי']).optional(),
  driveType: z.string().trim().min(1).max(60).optional()
}).strict();
export const catalogCardSchema = z.object({
  id: z.string().min(1).max(200), display_name: z.string().min(1).max(200),
  manufacturer_name: z.string().min(1).max(200),
  group_code: z.enum(['א', 'ב', 'ג', 'ד', 'משפחתי']), drive_type: z.string().min(1).max(100)
}).strict();
// Server-chosen quick replies. The body is sent as an ordinary employee message.
export const messageActionSchema = z.object({
  label: z.string().min(1).max(60), body: z.string().min(1).max(200), primary: z.boolean().optional()
}).strict();
// A human-readable proposal bound to a server-computed code. Approval requires that exact code.
export const approvalBlockSchema = z.object({
  code: z.string().regex(/^[A-F0-9]{8}$/), basedOnVersion: z.number().int().positive().nullable(),
  rows: z.array(z.object({ label: z.string().min(1).max(80), value: z.string().min(1).max(120),
    status: z.enum(['confirmed', 'new', 'changed', 'derived', 'representative', 'payslip', 'corrected', 'account']) }).strict()).min(1).max(14)
}).strict();
const money = z.number().finite();
export const calculationScenarioSchema = z.object({
  kind: z.enum(['vehicle', 'waiver']), vehicleId: z.string().min(1).max(100).nullable(),
  name: z.string().min(1).max(200), group_code: z.string().max(20).nullable(), drive_type: z.string().max(100).nullable(),
  eligible: z.boolean(), reason: z.string().max(300),
  net: money.nullable(), delta: money.nullable(), participation: money.nullable(), carValueOfUse: money.nullable(),
  electricGrossUp: money.nullable(), maintenance: money.nullable(), familyExtra: money.nullable(), incomeTax: money.nullable()
}).strict();
// Values are copied from deterministic calculator output, never model text.
export const calculationBlockSchema = z.object({
  runId: z.string().uuid().nullable(), saved: z.boolean(), profileVersion: z.number().int().positive(),
  rulesVersion: z.string().min(1).max(120), taxYear: z.number().int(),
  baseline: calculationScenarioSchema, scenarios: z.array(calculationScenarioSchema).min(1).max(6)
}).strict();
export const catalogMessageSchema = z.object({
  kind: z.literal('carwise.catalog.v1'), text: z.string().min(1).max(2000),
  purpose:z.enum(['catalog','profile_recall','conversation','hypothetical']).optional(),
  // Up to 24: a whole eligibility group (e.g. 13 cars for group C) fits, so nothing is silently cut off.
  cards: z.array(catalogCardSchema).max(24), recordedAt: z.string().datetime(),
  rulesVersion: z.string().max(120).optional(),
  state: z.object({ group: groupSchema.optional(), groupSource: z.enum(['employee_reported','occupation_match']).optional(),
    awaitingGroup: z.boolean(), filters: catalogFiltersSchema }).strict(),
  approval: approvalBlockSchema.optional(), calculation: calculationBlockSchema.optional(),
  actions: z.array(messageActionSchema).max(8).optional(),
  // The reply waits for a value that appears on a payslip: the chat offers the existing payslip upload under it.
  payslipUpload: z.literal(true).optional()
}).strict();
export type CatalogMessage = z.infer<typeof catalogMessageSchema>;
export function shouldRenderCatalog(message:CatalogMessage):boolean {
  return message.cards.length>0 && (!message.purpose||message.purpose==='catalog');
}
export type CalculationScenario = z.infer<typeof calculationScenarioSchema>;
export type MessageAction = z.infer<typeof messageActionSchema>;
export function decodeCatalogMessage(body: string): CatalogMessage | null {
  if (!body.startsWith('{') || body.length > 6000) return null;
  try { const parsed = catalogMessageSchema.safeParse(JSON.parse(body)); return parsed.success ? parsed.data : null; }
  catch { return null; }
}
export function encodeCatalogMessage(value: CatalogMessage): string {
  const body = JSON.stringify(catalogMessageSchema.parse(value));
  if (body.length > 6000) throw new Error('Catalog reply too large');
  return body;
}
