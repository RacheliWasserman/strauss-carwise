
// import { NextResponse } from 'next/server';
// import {
//   getCalculatorEmployee,
//   getCalculatorOccupation
// } from '@/lib/employee-repository';
// import { getCalculationRules } from '@/lib/rules-repository';
// import { calculateNet } from '@/lib/calculator';
// import {
//   getVehicles,
//   toCalculatorCar
// } from '@/lib/vehicle-repository';

// export async function GET() {
//   if (process.env.NODE_ENV !== 'development') {
//     return new Response('Not found', { status: 404 });
//   }

//   try {
//     const [employee, occupation, rules, vehicles] =
//       await Promise.all([
//         getCalculatorEmployee('E-001'),
//         getCalculatorOccupation('E-001'),
//         getCalculationRules(),
//         getVehicles()
//       ]);

//     const vehicle = vehicles.find(
//       v => v.id === 'CAR-09'
//     );

//     if (!vehicle) {
//       throw new Error('Vehicle CAR-09 not found');
//     }

//     const car = await toCalculatorCar(vehicle);

//     const result = calculateNet(
//       employee,
//       { type: 'car', car },
//       rules,
//       occupation
//     );

//     return NextResponse.json({
//       success: true,
//       source: 'Supabase',
//       employee: employee['שם'],
//       car: car['דגם (כינוי מסחרי)'],
//       gross: result.gross,
//       net: result.net,
//       carValueOfUse: result.carValueOfUse,
//       incomeTax: result.incomeTax,
//       nationalInsurance: result.nationalInsurance,
//       health: result.health,
//       electricNetBonus: result.electricNetBonus
//     });
//   } catch (error) {
//     return NextResponse.json(
//       {
//         success: false,
//         error: error instanceof Error
//           ? error.message
//           : 'Unknown error'
//       },
//       { status: 500 }
//     );
//   }
// }

export {};
