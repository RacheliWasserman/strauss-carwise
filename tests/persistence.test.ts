import { describe, expect, it } from 'vitest';
import { isUserRole } from '../src/lib/auth-types';
import {
  canPostEmployeeMessage,
  canPostRepresentativeReply,
  calculationHistoryQuerySchema,
  calculationRunIdSchema,
  employeeDataInputSchema,
  firstMessageSchema,
  messageInputSchema,
  ownsConversation,
  requestRepresentativeSchema,
  versionIdSchema
} from '../src/lib/persistence-validation';

const validEmployeeData = {
  display_name: 'Employee',
  occupation_title: 'Analyst',
  base_salary: 18000,
  commissions: 0,
  bonus: 0,
  employee_pension_percent: 6,
  employee_study_fund_percent: 2.5,
  tax_credit_points: 2.25,
  eligible_children_count: 0,
  current_vehicle_id: null,
  current_participation: 0
};

describe('persistence ownership and roles', () => {
  it('limits employee conversation access to its owner', () => {
    expect(ownsConversation('user-a', 'user-a', 'employee')).toBe(true);
    expect(ownsConversation('user-a', 'user-b', 'employee')).toBe(false);
    expect(ownsConversation('user-a', 'user-a', 'representative')).toBe(false);
  });

  it('allows representative replies only by the assigned representative', () => {
    expect(canPostRepresentativeReply('representative', 'rep-a', 'rep-a')).toBe(true);
    expect(canPostRepresentativeReply('representative', 'rep-a', 'rep-b')).toBe(false);
    expect(canPostRepresentativeReply('employee', 'rep-a', 'rep-a')).toBe(false);
  });

  it('does not let representative accounts post employee messages', () => {
    expect(canPostEmployeeMessage('employee')).toBe(true);
    expect(canPostEmployeeMessage('representative')).toBe(false);
  });

  it('recognizes only employee and representative roles', () => {
    expect(isUserRole('employee')).toBe(true);
    expect(isUserRole('representative')).toBe(true);
    expect(isUserRole('admin')).toBe(false);
  });
});

describe('persistence payload validation', () => {
  it('accepts a first employee message without employee or salary data', () => {
    expect(firstMessageSchema.safeParse({ body: 'שלום' }).success).toBe(true);
    expect(firstMessageSchema.safeParse({
      body: 'שלום',
      clientRequestId: '9a9dd2bf-2c8f-41d5-b160-842aa36baa19'
    }).success).toBe(true);
    expect(firstMessageSchema.safeParse({
      body: 'שלום',
      clientRequestId: 'not-a-uuid'
    }).success).toBe(false);
  });

  it('rejects forged assistant or representative sender fields', () => {
    expect(messageInputSchema.safeParse({
      body: 'forged',
      senderType: 'assistant',
      senderUserId: null
    }).success).toBe(false);
    expect(messageInputSchema.safeParse({
      body: 'forged',
      sender_type: 'representative',
      sender_user_id: 'some-user'
    }).success).toBe(false);
  });

  it('rejects invalid and oversized messages', () => {
    expect(firstMessageSchema.safeParse({ body: '   ' }).success).toBe(false);
    expect(firstMessageSchema.safeParse({ body: 'x'.repeat(16001) }).success).toBe(false);
  });

  it('rejects unknown employee data fields and out-of-range salary', () => {
    expect(employeeDataInputSchema.safeParse(validEmployeeData).success).toBe(true);
    expect(employeeDataInputSchema.safeParse({
      ...validEmployeeData,
      user_id: 'attacker-controlled'
    }).success).toBe(false);
    expect(employeeDataInputSchema.safeParse({
      ...validEmployeeData,
      base_salary: 1_000_001
    }).success).toBe(false);
  });

  it('validates representative request and version identifiers', () => {
    expect(requestRepresentativeSchema.safeParse({ topic: 'vehicle choice' }).success).toBe(true);
    expect(requestRepresentativeSchema.safeParse({ owner_user_id: 'spoofed' }).success).toBe(false);
    expect(versionIdSchema.safeParse({ versionId: 'not-a-uuid' }).success).toBe(false);
  });

  it('validates historical calculation query and run identifiers', () => {
    expect(calculationHistoryQuerySchema.safeParse({}).success).toBe(true);
    expect(calculationHistoryQuerySchema.safeParse({
      conversationId: '9a9dd2bf-2c8f-41d5-b160-842aa36baa19'
    }).success).toBe(true);
    expect(calculationHistoryQuerySchema.safeParse({ owner_user_id: 'forged' }).success).toBe(false);
    expect(calculationRunIdSchema.safeParse('not-a-uuid').success).toBe(false);
  });
});
