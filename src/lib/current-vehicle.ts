import type { Choice } from './calculator';
import type { Car } from './types';

export function findVehicleById(
  vehicleId: string,
  cars: Car[]
): Car | undefined {
  return cars.find(car => car['מזהה'] === vehicleId);
}

export function resolveCurrentVehicle(
  currentVehicleId: string | null,
  participation: number,
  cars: Car[]
): Choice {
  if (currentVehicleId === null) {
    return { type: 'waiver' };
  }

  if (!currentVehicleId.trim()) {
    throw new Error(
      'Employee current_vehicle_id is empty; use null for an employee without a current vehicle.'
    );
  }

  const car = findVehicleById(currentVehicleId, cars);

  if (!car) {
    throw new Error(
      `Current vehicle id "${currentVehicleId}" from employees.current_vehicle_id was not found in the active vehicle_catalog.id records. Verify the employee reference or activate/add that exact catalog vehicle.`
    );
  }

  return {
    type: 'car',
    car,
    participation
  };
}