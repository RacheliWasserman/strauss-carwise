import { z } from 'zod';
import type { UserRole } from './auth-types';

export const MAX_MESSAGE_LENGTH = 16000;

const trimmedMessage = z.string().trim().min(1).max(MAX_MESSAGE_LENGTH);

export const firstMessageSchema = z.object({
  body: trimmedMessage,
  clientRequestId: z.string().uuid().optional()
}).strict();

export const messageInputSchema = z.object({
  body: trimmedMessage,
  clientMessageId: z.string().uuid().optional()
}).strict();

export const employeeDataInputSchema = z.object({
  display_name: z.string().trim().min(1).max(120),
  occupation_title: z.string().trim().min(1).max(120),
  base_salary: z.number().finite().min(0).max(1_000_000),
  commissions: z.number().finite().min(0).max(1_000_000).default(0),
  bonus: z.number().finite().min(0).max(1_000_000).default(0),
  employee_pension_percent: z.number().finite().min(0).max(30),
  employee_study_fund_percent: z.number().finite().min(0).max(30),
  tax_credit_points: z.number().finite().min(0).max(50),
  eligible_children_count: z.number().int().min(0).max(40),
  current_vehicle_id: z.string().trim().min(1).max(100).nullable(),
  current_participation: z.number().finite().min(0).max(100_000).default(0)
}).strict();

export const employeeDataDraftSchema = employeeDataInputSchema;

export const versionIdSchema = z.object({
  versionId: z.string().uuid()
}).strict();

export const calculationHistoryQuerySchema = z.object({
  conversationId: z.string().uuid().optional()
}).strict();

export const calculationRunIdSchema = z.string().uuid();

export const requestRepresentativeSchema = z.object({
  topic: z.string().trim().max(120).nullable().optional()
}).strict();

export function ownsConversation(
  ownerUserId: string,
  viewerUserId: string,
  viewerRole: UserRole
): boolean {
  return viewerRole === 'employee' && ownerUserId === viewerUserId;
}

export function canPostEmployeeMessage(role: UserRole): boolean {
  return role === 'employee';
}

export function canPostRepresentativeReply(
  role: UserRole,
  assignedRepresentativeId: string | null,
  viewerUserId: string
): boolean {
  return role === 'representative' && assignedRepresentativeId === viewerUserId;
}

// Keep PostgreSQL microseconds intact when constructing pagination filters.
export const messageCursorSchema = z.object({
  createdAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/).refine(
    value => Number.isFinite(Date.parse(value)), 'Invalid timestamp'
  ),
  id: z.string().uuid()
}).strict();
export type MessageCursor = z.infer<typeof messageCursorSchema>;
export const messagePageQuerySchema = z.object({
  before: messageCursorSchema.shape.createdAt.optional(),
  beforeId: messageCursorSchema.shape.id.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50)
}).strict().refine(value => Boolean(value.before) === Boolean(value.beforeId), {
  message: 'before and beforeId must be supplied together'
});
