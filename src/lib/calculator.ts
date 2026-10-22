
import type { Car, Employee, Group, Occupation } from './types';
import type { CalculationRules } from './rules-repository';

export type Choice =
  | { type: 'car'; car: Car; participation?: number }
  | { type: 'waiver' };

export type Calculation = {
  net: number;
  gross: number;
  taxableIncome: number;
  incomeTax: number;
  nationalInsurance: number;
  health: number;
  pension: number;
  studyFund: number;
  pensionTaxCredit: number;
  carValueOfUse: number;
  participation: number;
  familyExtra: number;
  maintenance: number;
  electricGrossUp: number;
  electricNetBonus: number;
};

export type Eligibility = {
  eligible: boolean;
  reason: string;
  familyExtra: number;
};

export function progressiveTax(
  income: number,
  calculationRules: CalculationRules
): number {
  let lower = 0;
  let total = 0;

  const brackets = calculationRules.netMethod.brackets as [
    number | null,
    number
  ][];

  for (const [upper, rate] of brackets) {
    const high = upper ?? Infinity;

    total += Math.max(
      0,
      Math.min(income, high) - lower
    ) * rate;

    if (income <= high) break;

    lower = high;
  }

  return total;
}

function socialTax(
  income: number,
  rate: {
    threshold: number;
    ceiling: number;
    lowRate: number;
    highRate: number;
  }
): number {
  const capped = Math.min(
    Math.max(0, income),
    rate.ceiling
  );

  return (
    Math.min(capped, rate.threshold) * rate.lowRate +
    Math.max(0, capped - rate.threshold) * rate.highRate
  );
}

/**
 * The fields eligibility reads (types only: the rule itself is unchanged). Every full Employee, Choice, rules and
 * Occupation still fits, and the vehicle catalog can ask the same rule without a calculation-ready car.
 */
export type EligibilityChoice =
  | { type: 'car'; car: Pick<Car, 'מזהה' | 'קבוצה' | 'עלות חודשית לחברה (דמה)'> }
  | { type: 'waiver' };

export function eligibility(
  employee: Pick<Employee, 'ילדים עד 23'>,
  choice: EligibilityChoice,
  calculationRules: Pick<CalculationRules, 'familyTrack' | 'budgets' | 'groupOrder'>,
  occupation: Pick<Occupation, 'קבוצת זכאות' | 'מותר לוותר'>
): Eligibility {
  if (choice.type === 'waiver') {
    return occupation['מותר לוותר'] === 'כן'
      ? {
          eligible: true,
          reason: 'העיסוק מאפשר ויתור על רכב',
          familyExtra: 0
        }
      : {
          eligible: false,
          reason: 'בעיסוק זה הרכב הוא חובה ולא ניתן לוותר',
          familyExtra: 0
        };
  }

  const car = choice.car;

  if (car['קבוצה'] === 'משפחתי') {
    if (
      employee['ילדים עד 23'] <
      calculationRules.familyTrack.minChildren
    ) {
      return {
        eligible: false,
        reason: 'מסלול משפחתי דורש לפחות ארבעה ילדים זכאים עד גיל 23',
        familyExtra: 0
      };
    }

    if (
      !calculationRules.familyTrack.cars.includes(car['מזהה'])
    ) {
      return {
        eligible: false,
        reason: 'הרכב אינו בקטלוג המסלול המשפחתי',
        familyExtra: 0
      };
    }

    const budget =
      calculationRules.budgets[occupation['קבוצת זכאות']];

    return {
      eligible: true,
      reason: 'זכאות למסלול המשפחתי',
      familyExtra:
        Math.max(
          0,
          car['עלות חודשית לחברה (דמה)'] - budget
        ) * calculationRules.familyTrack.gapSplitEmployee
    };
  }

  const allowed =
    calculationRules.groupOrder.indexOf(
      car['קבוצה'] as Group
    ) <=
    calculationRules.groupOrder.indexOf(
      occupation['קבוצת זכאות']
    );

  return {
    eligible: allowed,
    reason: allowed
      ? 'הרכב בקבוצת הזכאות שלך או בקבוצה נמוכה יותר'
      : 'הרכב בקבוצה גבוהה מקבוצת הזכאות',
    familyExtra: 0
  };
}

function compute(
  employee: Employee,
  choice: Choice,
  electricGrossUp: number,
  calculationRules: CalculationRules,
  occupation: Occupation
): Calculation {
  const allowed = eligibility(
    employee,
    choice,
    calculationRules,
    occupation
  );

  if (!allowed.eligible) {
    throw new Error(allowed.reason);
  }

  const gross =
    employee['שכר בסיס'] +
    employee['עמלות'] +
    employee['בונוס'];

  const pension =
    gross * employee['פנסיה עובד %'] / 100;

  const studyFund =
    gross * employee['קרן השתלמות עובד %'] / 100;

  const taxMethod = calculationRules.netMethod;

  const pensionTaxCredit =
    taxMethod.pensionCredit.rate *
    Math.min(
      pension,
      taxMethod.pensionCredit.maxContributionRate *
        taxMethod.pensionCredit.incomeCeiling
    );

  const carValueOfUse =
    choice.type === 'car'
      ? choice.car['שווי שימוש חודשי']
      : 0;

  const participation =
    choice.type === 'car'
      ? (
          choice.participation ??
          choice.car['השתתפות עובד ברירת מחדל (דמה)']
        )
      : 0;

  const maintenance =
    choice.type === 'waiver'
      ? occupation['אחזקת רכב בוויתור (₪)']
      : 0;

  const taxableIncome =
    gross +
    carValueOfUse +
    maintenance +
    electricGrossUp;

  const incomeTax = Math.max(
    0,
    progressiveTax(taxableIncome, calculationRules) -
      employee['נקודות זיכוי'] *
        taxMethod.creditPointValue -
      pensionTaxCredit
  );

  const nationalInsurance = socialTax(
    taxableIncome,
    taxMethod.nationalInsurance
  );

  const health = socialTax(
    taxableIncome,
    taxMethod.health
  );

  const net =
    gross +
    maintenance +
    electricGrossUp -
    incomeTax -
    nationalInsurance -
    health -
    pension -
    studyFund -
    participation -
    allowed.familyExtra;

  return {
    net,
    gross,
    taxableIncome,
    incomeTax,
    nationalInsurance,
    health,
    pension,
    studyFund,
    pensionTaxCredit,
    carValueOfUse,
    participation,
    familyExtra: allowed.familyExtra,
    maintenance,
    electricGrossUp,
    electricNetBonus: 0
  };
}

export function calculateNet(
  employee: Employee,
  choice: Choice,
  calculationRules: CalculationRules,
  occupation: Occupation
): Calculation {
  const base = compute(
    employee,
    choice,
    0,
    calculationRules,
    occupation
  );

  if (
    choice.type !== 'car' ||
    choice.car['הנעה'] !== 'חשמלי'
  ) {
    return base;
  }

  const target = calculationRules.electric.netBonus;

  let low = 0;
  let high = target;

  while (
    compute(
      employee,
      choice,
      high,
      calculationRules,
      occupation
    ).net - base.net < target
  ) {
    high *= 2;

    if (high > 1_000_000) {
      throw new Error('Gross-up did not converge');
    }
  }

  for (let i = 0; i < 90; i++) {
    const mid = (low + high) / 2;

    if (
      compute(
        employee,
        choice,
        mid,
        calculationRules,
        occupation
      ).net - base.net < target
    ) {
      low = mid;
    } else {
      high = mid;
    }
  }

  const result = compute(
    employee,
    choice,
    (low + high) / 2,
    calculationRules,
    occupation
  );

  return {
    ...result,
    electricNetBonus: result.net - base.net
  };
}

export function compare(
  employee: Employee,
  current: Choice,
  alternative: Choice,
  calculationRules: CalculationRules,
  occupation: Occupation
) {
  const currentResult = calculateNet(
    employee,
    current,
    calculationRules,
    occupation
  );

  const alternativeResult = calculateNet(
    employee,
    alternative,
    calculationRules,
    occupation
  );

  return {
    current: currentResult,
    alternative: alternativeResult,
    delta: alternativeResult.net - currentResult.net
  };
}

export function displayShekels(value: number): number {
  return Math.round(value);
}
