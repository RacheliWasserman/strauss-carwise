
import { describe, it, expect } from 'vitest';

import {
  cars,
  employees,
  references,
  rules,
  findCarByName,
  findOccupation,
  lookupOfficialValue
} from '../src/lib/data';

import {
  calculateNet as calculateNetEngine,
  displayShekels,
  eligibility as eligibilityEngine,
  progressiveTax as progressiveTaxEngine,
  type Choice
} from '../src/lib/calculator';

import type { Employee } from '../src/lib/types';
import type { CalculationRules } from '../src/lib/rules-repository';

// נתוני ה-JSON משמשים כנתוני ייחוס לבדיקות בלבד.
// מנוע החישוב עצמו אינו תלוי בהם.
const testRules = rules as CalculationRules;

function calculateNet(employee: Employee, choice: Choice) {
  return calculateNetEngine(
    employee,
    choice,
    testRules,
    findOccupation(employee['עיסוק'])
  );
}

function eligibility(employee: Employee, choice: Choice) {
  return eligibilityEngine(
    employee,
    choice,
    testRules,
    findOccupation(employee['עיסוק'])
  );
}

function progressiveTax(income: number) {
  return progressiveTaxEngine(income, testRules);
}

function currentChoice(employee: Employee): Choice {
  return !employee['רכב היום'] || employee['רכב היום'].startsWith('אין')
    ? { type: 'waiver' }
    : {
        type: 'car',
        car: findCarByName(employee['רכב היום']),
        participation: employee['השתתפות היום']
      };
}

const alternatives: Record<string, string> = {
  'E-001': 'ATTO 3',
  'E-002': 'CARNIVAL',
  'E-003': 'MG4',
  'E-004': 'EV3',
  'E-005': 'WAIVER',
  'E-006': 'MODEL 3'
};

describe('official catalogue', () => {
  it('all 20 catalogue values match the 2026 tax records', () => {
    expect(cars).toHaveLength(20);

    for (const car of cars) {
      expect(lookupOfficialValue(car)).toBe(
        car['שווי שימוש חודשי']
      );
    }
  });
});

describe('reference calculations', () => {
  for (const ref of references) {
    it(
      `${ref['מזהה']} ${ref['שם']} matches the supplied worksheet`,
      () => {
        const employee = employees.find(
          e => e['מזהה'] === ref['מזהה']
        );

        expect(employee).toBeDefined();

        if (!employee) {
          throw new Error(`Employee not found: ${ref['מזהה']}`);
        }

        const alternativeName = alternatives[employee['מזהה']];

        if (!alternativeName) {
          throw new Error(
            `Alternative not found: ${employee['מזהה']}`
          );
        }

        const alternative: Choice =
          alternativeName === 'WAIVER'
            ? { type: 'waiver' }
            : {
                type: 'car',
                car: findCarByName(alternativeName)
              };

        const today = calculateNet(
          employee,
          currentChoice(employee)
        );

        const after = calculateNet(
          employee,
          alternative
        );

        expect(displayShekels(today.net)).toBe(
          ref['נטו היום']
        );

        expect(displayShekels(after.net)).toBe(
          ref['נטו בחלופה']
        );

        expect(
          displayShekels(after.net) -
          displayShekels(today.net)
        ).toBe(ref['הפרש']);

        expect(displayShekels(today.incomeTax)).toBe(
          ref['מס היום']
        );

        expect(displayShekels(after.incomeTax)).toBe(
          ref['מס בחלופה']
        );

        expect(
          displayShekels(
            today.nationalInsurance + today.health
          )
        ).toBe(ref['ביטוח לאומי+בריאות היום']);

        expect(
          displayShekels(
            after.nationalInsurance + after.health
          )
        ).toBe(ref['ביטוח לאומי+בריאות בחלופה']);

        expect(
          displayShekels(after.electricGrossUp)
        ).toBe(ref['החזר חשמל ברוטו']);

        expect(
          displayShekels(after.familyExtra)
        ).toBe(ref['חלק העובד במסלול המשפחתי']);

        if (
          alternative.type === 'car' &&
          alternative.car['הנעה'] === 'חשמלי'
        ) {
          expect(after.electricGrossUp).toBeGreaterThan(250);

          expect(after.electricNetBonus).toBeCloseTo(
            250,
            8
          );
        }
      }
    );
  }
});

describe('guardrails', () => {
  it('tax bracket boundary', () => {
    expect(progressiveTax(7010)).toBeCloseTo(701);
    expect(progressiveTax(10060)).toBeCloseTo(1128);
  });

  it('cannot choose a higher group', () => {
    const employee = employees.find(
      e => e['מזהה'] === 'E-002'
    )!;

    const car = cars.find(
      c => c['מזהה'] === 'CAR-14'
    )!;

    expect(
      eligibility(employee, { type: 'car', car }).eligible
    ).toBe(false);
  });

  it('cannot waive mandatory company car', () => {
    const employee = employees.find(
      e => e['מזהה'] === 'E-002'
    )!;

    expect(
      eligibility(employee, { type: 'waiver' }).eligible
    ).toBe(false);
  });

  it('family eligibility requires four eligible children', () => {
    const employee = employees.find(
      e => e['מזהה'] === 'E-001'
    )!;

    const car = cars.find(
      c => c['מזהה'] === 'CAR-19'
    )!;

    expect(
      eligibility(employee, { type: 'car', car }).eligible
    ).toBe(false);
  });
});
