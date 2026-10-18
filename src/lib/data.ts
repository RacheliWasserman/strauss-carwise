
import carsData from '../../data/cars.json';
import occupationsData from '../../data/occupations.json';
import employeesData from '../../data/employees.json';
import referenceData from '../../data/reference.json';
import rulesData from '../../data/rules.json';
import taxData from '../../data/tax-records.json';

import type {
  Car,
  Occupation,
  Employee,
  Reference
} from './types';

// Re-export types for backward compatibility
export type {
  Group,
  Car,
  Occupation,
  Employee,
  Reference
} from './types';

// Temporary local data - will be replaced by Supabase
export const cars = carsData as Car[];
export const occupations = occupationsData as Occupation[];
export const employees = employeesData as Employee[];
export const references = referenceData as Reference[];
export const rules = rulesData;
export const taxRecords = taxData;

export function findCar(id: string): Car {
  const car = cars.find(c => c['מזהה'] === id);

  if (!car) {
    throw new Error(`Unknown car ${id}`);
  }

  return car;
}

export function findOccupation(name: string): Occupation {
  const occupation = occupations.find(
    o => o['עיסוק'] === name
  );

  if (!occupation) {
    throw new Error(`Unknown occupation ${name}`);
  }

  return occupation;
}

export function findEmployee(id: string): Employee {
  const employee = employees.find(
    e => e['מזהה'] === id
  );

  if (!employee) {
    throw new Error(`Unknown employee ${id}`);
  }

  return employee;
}

export function findCarByName(name: string): Car {
  const car = cars.find(
    c => c['דגם (כינוי מסחרי)'] === name
  );

  if (!car) {
    throw new Error(`Unknown car model ${name}`);
  }

  return car;
}

export function lookupOfficialValue(car: Car): number {
  const matches = taxRecords.filter(
    r =>
      r.taxYear === 2026 &&
      r.registrationYear === car['שנת רישום'] &&
      r.vehicleTypeCode === '1' &&
      r.manufacturerCode === car['קוד תוצר'] &&
      r.modelCode === car['קוד דגם']
  );

  if (matches.length !== 1) {
    throw new Error(
      `Expected one tax record for ${car['מזהה']}; found ${matches.length}`
    );
  }

  return matches[0].valueOfUse;
}
