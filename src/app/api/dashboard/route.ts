
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { supabaseAdmin } from '@/lib/supabase-admin';
import {
  getCalculatorEmployee,
  getCalculatorOccupation
} from '@/lib/employee-repository';
import {
  getVehicles,
  toCalculatorCar
} from '@/lib/vehicle-repository';
import {
  findVehicleById,
  resolveCurrentVehicle
} from '@/lib/current-vehicle';
import { getCalculationRules } from '@/lib/rules-repository';
import {
  calculateNet,
  eligibility,
  type Choice
} from '@/lib/calculator';
import type { Car } from '@/lib/types';
import { getAuthenticatedProfile } from '@/lib/require-authenticated-user';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const requestSchema = z.object({
  employeeId: z.string().min(1),
  carId: z.string().min(1)
});

function demoOnly() {
  return process.env.NODE_ENV === 'development';
}

async function loadCars(): Promise<Car[]> {
  const vehicles = await getVehicles();
  return Promise.all(vehicles.map(toCalculatorCar));
}

export async function GET() {
  if (!demoOnly()) {
    return NextResponse.json(
      { error: 'Demo API is disabled' },
      { status: 403 }
    );
  }

  try {
    const profile = await getAuthenticatedProfile();

    if (!profile) {
      return NextResponse.json(
        { error: 'נדרשת התחברות כדי לגשת לנתונים' },
        { status: 401 }
      );
    }

    if (profile.role !== 'representative') {
      return NextResponse.json(
        { error: 'נתוני ההדגמה זמינים לנציגים מורשים בלבד' },
        { status: 403 }
      );
    }

    const [employeeRows, cars] = await Promise.all([
      supabaseAdmin
        .from('employees')
        .select('*')
        ,
      loadCars()
    ]);

    if (employeeRows.error) {
      throw employeeRows.error;
    }

   console.log('EMPLOYEE COLUMNS:', Object.keys(employeeRows.data?.[0] ?? {}));
     const employeeIds = (employeeRows.data ?? [])
  .map(row => row.demo_employee_code as string)
  .filter(Boolean);

    const employees = await Promise.all(
      employeeIds.map(async id => {
        const [employee, occupation] = await Promise.all([
          getCalculatorEmployee(id),
          getCalculatorOccupation(id)
        ]);

        return {
          id,
          name: employee['שם'],
          occupation: employee['עיסוק'],
          salary: employee['שכר בסיס'],
          group: occupation['קבוצת זכאות']
        };
      })
    );

    return NextResponse.json({
      employees,
      cars: cars.map(car => ({
        id: car['מזהה'],
        name: car['דגם (כינוי מסחרי)'],
        group: car['קבוצה']
      })),
      source: 'Supabase'
    });
  } catch (error) {
    console.error('Dashboard GET error:', error);
    console.error(
      'ACTUAL ERROR:',
      error instanceof Error ? error.message : JSON.stringify(error)
    );
    return NextResponse.json(
      { error: 'לא ניתן לטעון את נתוני המסך' },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  if (!demoOnly()) {
    return NextResponse.json(
      { error: 'Demo API is disabled' },
      { status: 403 }
    );
  }

  try {
    const profile = await getAuthenticatedProfile();

    if (!profile) {
      return NextResponse.json(
        { error: 'נדרשת התחברות כדי לבצע חישוב' },
        { status: 401 }
      );
    }

    if (profile.role !== 'representative') {
      return NextResponse.json(
        { error: 'נתוני ההדגמה זמינים לנציגים מורשים בלבד' },
        { status: 403 }
      );
    }

    const { employeeId, carId } = requestSchema.parse(
      await request.json()
    );

    const [employee, occupation, rules, cars] =
      await Promise.all([
        getCalculatorEmployee(employeeId),
        getCalculatorOccupation(employeeId),
        getCalculationRules(),
        loadCars()
      ]);

    const current: Choice = resolveCurrentVehicle(
      employee.currentVehicleId ?? null,
      employee['השתתפות היום'],
      cars
    );

    let chosen: Choice;

    if (carId === 'WAIVER') {
      chosen = { type: 'waiver' };
    } else {
      const car = findVehicleById(carId, cars);

      if (!car) {
        return NextResponse.json(
          { error: 'הרכב המבוקש לא נמצא' },
          { status: 404 }
        );
      }

      chosen = { type: 'car', car };
    }

    const valid = eligibility(
      employee,
      chosen,
      rules,
      occupation
    );

    const today = calculateNet(
      employee,
      current,
      rules,
      occupation
    );

    if (!valid.eligible) {
      return NextResponse.json({
        eligible: false,
        reason: valid.reason,
        today,
        after: null,
        delta: null
      });
    }

    const after = calculateNet(
      employee,
      chosen,
      rules,
      occupation
    );

    return NextResponse.json({
      eligible: true,
      reason: valid.reason,
      today,
      after,
      delta: Math.round(after.net) - Math.round(today.net)
    });
  } catch (error) {
    console.error('Dashboard POST error:', error);

    return NextResponse.json(
      {
        error: 'לא ניתן להשלים את ההשוואה',
        ...(process.env.NODE_ENV === 'development' && {
          detail: error instanceof Error
            ? error.message
            : String(error)
        })
      },
      { status: 500 }
    );
  }
}
