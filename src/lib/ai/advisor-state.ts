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
  // 'comparison': the employee asked to compare the selection with another car; the next explicit choice is ADDED to it.
  pendingQuestion:z.enum(['occupation','occupation_choice','representative','group','financial','approval','vehicle_selection','next_step','correction','comparison']).nullable(),
  // Employee-reported values. Never a confirmed profile until an approved version is written.
  // current_vehicle_id uses 'NONE' for "no company car today" (a waiver baseline).
  pendingFacts:z.array(z.object({field:factFieldSchema,value:z.union([z.string().max(120),z.number().finite().nonnegative()]),
    sourceMessageId:z.string().uuid(),status:z.literal('pending_confirmation'),
    // A verified representative answer the employee chose to use, or a reviewed payslip value (unchanged from the
    // document, or corrected by the employee). Every kind still needs the employee's approval in the summary.
    source:z.enum(['representative','payslip','corrected']).optional()}).strict()).max(12),
  unknownFacts:z.array(factFieldSchema).max(12).optional(),
  // Confirmed values the employee said are wrong in this conversation: not reused until replaced and approved.
  // The saved version history is never changed by a dispute.
  disputedFacts:z.array(factFieldSchema).max(12).optional(),
  // The single financial question currently displayed, and how many times in a row it was asked.
  pendingField:factFieldSchema.optional(),
  pendingFieldAsks:z.number().int().min(1).max(50).optional(),
  shownVehicles:z.array(z.object({id:vehicleIdSchema,name:z.string().min(1).max(200)}).strict()).max(24).optional(),
  selectedVehicleIds:z.array(vehicleIdSchema).max(6).optional(),
  // The employee's explicit financial goal. It survives corrections, representative consultation and approval,
  // and is resumed once after a new profile version is approved. Only an explicit choice replaces it.
  activeGoal:z.discriminatedUnion('kind',[
    z.object({kind:z.literal('vehicles'),vehicleIds:z.array(vehicleIdSchema).min(1).max(6)}).strict(),
    z.object({kind:z.literal('waiver')}).strict()
  ]).optional(),
  // Present on states that track activeGoal; older saved states get a one-time, conservative derivation.
  goalTracking:z.literal(1).optional(),
  // Catalog vehicles the employee asked for before eligibility could be checked (occupation still unknown).
  vehicleInterest:z.array(vehicleIdSchema).max(6).optional(),
  pendingApproval:z.object({code:codeSchema,basedOnVersionId:z.string().uuid().nullable()}).strict().optional(),
  confirmedVersion:z.object({id:z.string().uuid(),version:z.number().int().positive()}).strict().optional(),
  calculations:z.array(z.object({key:z.string().regex(/^[a-f0-9]{64}$/),runId:z.string().uuid().nullable(),
    profileVersionId:z.string().uuid(),vehicleIds:z.array(vehicleIdSchema).max(6),waiver:z.boolean()}).strict()).max(20).optional(),
  // 'superseded': the employee supplied the requested field themselves while the request was open; the request is
  // cancelled (where the database allows) and a late answer is not applied over the employee's newer value.
  representative:z.object({status:z.enum(['offered','requested','superseded']),code:codeSchema,topic:z.string().min(1).max(120),
    requestId:z.string().uuid().optional(),
    // The missing field this request asks about, and answers already used (duplicate clicks change nothing).
    field:factFieldSchema.optional(),usedAnswerIds:z.array(z.string().uuid()).max(10).optional()}).strict().optional(),
  // Every representative request opened in this conversation (several are allowed, one pending per topic): its own
  // id, topic, field and status, so each answer is matched to its own request. 'representative' above is the latest
  // offer/request (the button code); older states without this list are read through representativeEntries().
  representativeRequests:z.array(z.object({requestId:z.string().uuid(),topic:z.string().min(1).max(120),field:factFieldSchema.optional(),
    status:z.enum(['requested','superseded','used'])}).strict()).max(10).optional()
}).strict();
export type AdvisorState = z.infer<typeof advisorStateSchema>;
export type RepresentativeEntry = NonNullable<AdvisorState['representativeRequests']>[number];

/**
 * The conversation's representative requests. States saved before the list existed have one request in
 * 'representative': it is read as a single entry ('used' once an answer of it was used).
 */
export function representativeEntries(state: Pick<AdvisorState, 'representative' | 'representativeRequests'> | null | undefined): RepresentativeEntry[] {
  if (!state) return [];
  if (state.representativeRequests) return state.representativeRequests;
  const legacy = state.representative;
  if (!legacy?.requestId || legacy.status === 'offered') return [];
  return [{ requestId: legacy.requestId, topic: legacy.topic, ...(legacy.field ? { field: legacy.field } : {}),
    status: legacy.status === 'superseded' ? 'superseded' : legacy.usedAnswerIds?.length ? 'used' : 'requested' }];
}
/** Fields a representative is still being asked about (requested, answer not used yet). */
export const awaitedRepresentativeFields = (state: Pick<AdvisorState, 'representative' | 'representativeRequests'>) =>
  representativeEntries(state).flatMap(entry => entry.status === 'requested' && entry.field ? [entry.field] : []);
export const awaitingRepresentative = (state: Pick<AdvisorState, 'representative' | 'representativeRequests'>) =>
  representativeEntries(state).some(entry => entry.status === 'requested');
/**
 * The state in the format of the version before the list existed (Production 565e426, whose schema is strict and
 * rejects unknown keys): used while several requests are off, so a rollback still loads every conversation. Nothing
 * is lost then: with one request per conversation, 'representative' holds that request (requested / superseded /
 * used answers), and representativeEntries() reads it the same way.
 */
export function withoutRepresentativeList<T extends Pick<AdvisorState, 'representativeRequests'>>(state: T): T {
  if (!state.representativeRequests) return state;
  const copy = { ...state };
  delete copy.representativeRequests;
  return copy;
}
/** Records or updates one request (materializing the list from an older state first). */
export function putRepresentativeEntry(state: AdvisorState, entry: RepresentativeEntry) {
  const entries = representativeEntries(state).filter(item => item.requestId !== entry.requestId);
  state.representativeRequests = [...entries, entry].slice(-10);
}
