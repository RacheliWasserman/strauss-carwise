import { z } from 'zod';
import { catalogFiltersSchema, groupSchema } from '../catalog-message';

export const storedOccupationSchema = z.object({
  key:z.string().regex(/^[a-f0-9]{64}$/), title:z.string().min(1).max(120), group_code:groupSchema,
  car_mandatory:z.boolean(), waiver_allowed:z.boolean(), waiver_maintenance_amount:z.number().finite().nonnegative()
}).strict();
export const factFieldSchema = z.enum(['display_name','base_salary','commissions','bonus','employee_pension_percent',
  'employee_study_fund_percent','tax_credit_points','eligible_children_count','current_participation','current_vehicle_id']);
export type FactField = z.infer<typeof factFieldSchema>;
const vehicleIdSchema = z.string().min(1).max(100);
const codeSchema = z.string().regex(/^[A-F0-9]{8}$/);
export const advisorStateSchema = z.object({
  schemaVersion:z.literal(1), revision:z.number().int().positive(), userId:z.string().uuid(), conversationId:z.string().uuid(),
  lastProcessedMessageId:z.string().uuid(),
  goal:z.enum(['catalog','recommendation','comparison','net','waiver','family','help']),
  preferences:catalogFiltersSchema,
  group:groupSchema.optional(), groupSource:z.enum(['employee_reported','occupation_match']).optional(),
  occupation:z.object({
    reportedTitle:z.string().min(1).max(120), sourceMessageId:z.string().uuid(),
    status:z.enum(['matched','ambiguous','no_match','unavailable']),
    candidates:z.array(storedOccupationSchema).max(5), match:storedOccupationSchema.optional(),
    officialRoleVerified:z.literal(false)
  }).strict().optional(),
  pendingQuestion:z.enum(['occupation','occupation_choice','representative','group','financial','approval','vehicle_selection','next_step','correction']).nullable(),
  // Employee-reported values. Never a confirmed profile until an approved version is written.
  // current_vehicle_id uses 'NONE' for "no company car today" (a waiver baseline).
  pendingFacts:z.array(z.object({field:factFieldSchema,value:z.union([z.string().max(120),z.number().finite().nonnegative()]),
    sourceMessageId:z.string().uuid(),status:z.literal('pending_confirmation')})).max(12),
  unknownFacts:z.array(factFieldSchema).max(12).optional(),
  // The single financial question currently displayed, and how many times in a row it was asked.
  pendingField:factFieldSchema.optional(),
  pendingFieldAsks:z.number().int().min(1).max(50).optional(),
  shownVehicles:z.array(z.object({id:vehicleIdSchema,name:z.string().min(1).max(200)}).strict()).max(6).optional(),
  selectedVehicleIds:z.array(vehicleIdSchema).max(6).optional(),
  // Catalog vehicles the employee asked for before eligibility could be checked (occupation still unknown).
  vehicleInterest:z.array(vehicleIdSchema).max(6).optional(),
  pendingApproval:z.object({code:codeSchema,basedOnVersionId:z.string().uuid().nullable()}).strict().optional(),
  confirmedVersion:z.object({id:z.string().uuid(),version:z.number().int().positive()}).strict().optional(),
  calculations:z.array(z.object({key:z.string().regex(/^[a-f0-9]{64}$/),runId:z.string().uuid().nullable(),
    profileVersionId:z.string().uuid(),vehicleIds:z.array(vehicleIdSchema).max(6),waiver:z.boolean()}).strict()).max(20).optional(),
  representative:z.object({status:z.enum(['offered','requested']),code:codeSchema,topic:z.string().min(1).max(120),
    requestId:z.string().uuid().optional()}).strict().optional()
}).strict();
export type AdvisorState = z.infer<typeof advisorStateSchema>;
