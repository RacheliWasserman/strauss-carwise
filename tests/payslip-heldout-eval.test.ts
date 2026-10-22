import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { extractPdfText } from '../src/lib/payslip/payslip-pdf';
import { parsePayslipLines } from '../src/lib/payslip/payslip-parser';
import { finalizeFields } from '../src/lib/payslip/payslip-service';
import { PAYSLIP_FIELD_ORDER, type ExtractedField, type PayslipField } from '../src/lib/payslip/payslip-contract';

/**
 * HELD-OUT evaluation of the local digital-PDF reader on layouts written after the rules and never used to tune them.
 * It measures; it does not encode the current output. The only hard requirement is safety: no wrong value and no
 * value where the document states none (abstaining is allowed and is reported separately).
 */
type Outcome = 'correct' | 'missed' | 'wrong_value' | 'false_positive' | 'correct_abstention';
const GOLDEN = JSON.parse(readFileSync('tests/fixtures/payslips/heldout-golden.json', 'utf8')) as Record<string, { fields: Record<PayslipField, number | null> }>;
const LAYOUTS = Object.keys(GOLDEN).filter(key => key.startsWith('heldout-'));
const outcome = (expected: number | null, actual: number | null): Outcome =>
  expected === null ? (actual === null ? 'correct_abstention' : 'false_positive')
    : actual === null ? 'missed' : Math.abs(actual - expected) < 1e-9 ? 'correct' : 'wrong_value';

describe('held-out evaluation: local digital-PDF reader (no model)', () => {
  it('measures per-field accuracy, misses and false positives; never a wrong or invented value', async () => {
    const rows: Array<{ layout: string; field: PayslipField; expected: number | null; actual: number | null; state: string; outcome: Outcome }> = [];
    for (const layout of LAYOUTS) {
      const text = await extractPdfText(new Uint8Array(readFileSync(`tests/fixtures/payslips/${layout}.pdf`)));
      const fields = finalizeFields(parsePayslipLines(text.lines).fields);
      const byField = Object.fromEntries(fields.map(item => [item.field, item])) as Record<PayslipField, ExtractedField>;
      for (const field of PAYSLIP_FIELD_ORDER) {
        const item = byField[field];
        const state = item.value !== null ? item.confidence : item.ambiguous ? 'ambiguous' : 'none';
        rows.push({ layout, field, expected: GOLDEN[layout].fields[field], actual: item.value, state, outcome: outcome(GOLDEN[layout].fields[field], item.value) });
      }
    }
    const count = (filter: (row: typeof rows[number]) => boolean) => rows.filter(filter).length;
    const report = [
      'layout | field | expected | read | state | outcome',
      ...rows.map(row => `${row.layout} | ${row.field} | ${row.expected ?? '—'} | ${row.actual ?? '—'} | ${row.state} | ${row.outcome}`),
      '', 'per field (correct / stated):',
      ...PAYSLIP_FIELD_ORDER.map(field => `${field}: ${count(row => row.field === field && row.outcome === 'correct')}/${count(row => row.field === field && row.expected !== null)}` +
        ` · missed ${count(row => row.field === field && row.outcome === 'missed')} · FP ${count(row => row.field === field && ['wrong_value', 'false_positive'].includes(row.outcome))}`),
      '', `TOTAL correct ${count(row => row.outcome === 'correct')}/${count(row => row.expected !== null)} · missed ${count(row => row.outcome === 'missed')}` +
        ` · wrong ${count(row => row.outcome === 'wrong_value')} · false positives ${count(row => row.outcome === 'false_positive')}` +
        ` · correct abstentions ${count(row => row.outcome === 'correct_abstention')}/${count(row => row.expected === null)}`
    ].join('\n');
    console.log(`\nHELD-OUT EVALUATION (local PDF reader)\n${report}`);
    expect(rows.filter(row => row.outcome === 'wrong_value' || row.outcome === 'false_positive')).toEqual([]);
  });
});
