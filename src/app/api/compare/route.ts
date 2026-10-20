
import { NextResponse } from 'next/server';
import { z } from 'zod';

import {
  getCalculatorEmployee,
  getCalculatorOccupation
} from '@/lib/employee-repository';

import {
  getVehicles,
  toCalculatorCar
} from '@/lib/vehicle-repository';

import { getCalculationRules } from '@/lib/rules-repository';

import {
  calculateNet,
  eligibility,
  type Choice
} from '@/lib/calculator';
import { getAuthenticatedProfile } from '@/lib/require-authenticated-user';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const input = z.object({
  employeeId: z.string().min(1),
  carId: z.string().min(1)
});

export async function POST(request: Request) {
  // גישה זמנית לצורכי הדגמה בלבד.
  // אין לחשוף נתוני שכר ללא אימות והרשאות בסביבת Production.
  if (process.env.NODE_ENV !== 'development') {
    return NextResponse.json(
      { error: 'Demo API is disabled' },
      { status: 403 }
    );
  }

  try {
    const profile = await getAuthenticatedProfile();

    if (!profile) {
      return NextResponse.json(
        { error: 'נדרשת התחברות כדי לגשת לנתוני ההשוואה' },
        { status: 401 }
      );
    }

    if (profile.role !== 'representative') {
      return NextResponse.json(
        { error: 'ממשק ההשוואה לדוגמה זמין לנציגים מורשים בלבד' },
        { status: 403 }
      );
    }

    const { employeeId, carId } = input.parse(
      await request.json()
    );

    const [employee, occupation, rules] = await Promise.all([
      getCalculatorEmployee(employeeId),
      getCalculatorOccupation(employeeId),
      getCalculationRules()
    ]);

    let choice: Choice;

    if (carId === 'WAIVER') {
      choice = { type: 'waiver' };
    } else {
      const vehicles = await getVehicles();

      const vehicle = vehicles.find(
        vehicle => vehicle.id === carId
      );

      if (!vehicle) {
        return NextResponse.json(
          { error: 'הרכב המבוקש לא נמצא' },
          { status: 404 }
        );
      }

      const car = await toCalculatorCar(vehicle);

      choice = {
        type: 'car',
        car
      };
    }

    const eligibilityResult = eligibility(
      employee,
      choice,
      rules,
      occupation
    );

    if (!eligibilityResult.eligible) {
      return NextResponse.json(
        {
          eligible: false,
          reason: eligibilityResult.reason
        },
        { status: 422 }
      );
    }

    const result = calculateNet(
      employee,
      choice,
      rules,
      occupation
    );

    return NextResponse.json({
      eligible: true,
      reason: eligibilityResult.reason,
      result
    });
  } catch (error) {
    console.error('Compare API error:', error);

    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'נתוני הבקשה אינם תקינים' },
        { status: 400 }
      );
    }

    return NextResponse.json(
      { error: 'לא ניתן להשלים את החישוב' },
      { status: 500 }
    );
  }
}

export async function GET() {
  if (process.env.NODE_ENV !== 'development') {
    return NextResponse.json(
      { error: 'Demo API is disabled' },
      { status: 403 }
    );
  }

  try {
    const profile = await getAuthenticatedProfile();

    if (!profile) {
      return NextResponse.json(
        { error: 'נדרשת התחברות כדי לגשת לקטלוג' },
        { status: 401 }
      );
    }

    if (profile.role !== 'representative') {
      return NextResponse.json(
        { error: 'ממשק ההשוואה לדוגמה זמין לנציגים מורשים בלבד' },
        { status: 403 }
      );
    }

    const vehicles = await getVehicles();

    return NextResponse.json({
      cars: vehicles.length,
      status: 'ready',
      source: 'Supabase'
    });
  } catch (error) {
    console.error('Compare API error:', error);

    return NextResponse.json(
      { error: 'לא ניתן לטעון את קטלוג הרכבים' },
      { status: 500 }
    );
  }
}
