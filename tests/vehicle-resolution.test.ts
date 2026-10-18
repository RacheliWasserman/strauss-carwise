import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cars } from '../src/lib/data';
import {
  findVehicleById,
  resolveCurrentVehicle
} from '../src/lib/current-vehicle';
import {
  getOfficialVehicleTaxValue,
  type VehicleRow
} from '../src/lib/vehicle-repository';

const query = vi.hoisted(() => ({
  from: vi.fn(),
  select: vi.fn(),
  eq: vi.fn(),
  limit: vi.fn()
}));

vi.mock('../lib/supabase', () => ({ supabase: {} }));
vi.mock('../src/lib/supabase-admin', () => ({
  supabaseAdmin: { from: query.from }
}));

const vehicle: VehicleRow = {
  id: 'CAR-09',
  group_code: 'ג',
  display_name: 'COROLLA CROSS',
  manufacturer_name: 'Toyota',
  tax_year: 2026,
  registration_year: 2025,
  vehicle_type_code: '1',
  manufacturer_code: '00413',
  model_code: '00296',
  drive_type: 'היברידי',
  monthly_company_cost: 4300,
  default_employee_participation: 300,
  model_description: 'ZVG12L-KHXGBW',
  list_price: 182990,
  active: true
};

describe('current vehicle resolution', () => {
  it('resolves CAR-09 by internal catalog ID, not commercial name', () => {
    const current = resolveCurrentVehicle('CAR-09', 300, cars);

    expect(current.type).toBe('car');
    if (current.type === 'car') {
      expect(current.car['מזהה']).toBe('CAR-09');
      expect(current.car['דגם (כינוי מסחרי)']).toBe('COROLLA CROSS');
      expect(current.participation).toBe(300);
    }
  });

  it('resolves current and alternative vehicles independently', () => {
    const current = resolveCurrentVehicle('CAR-09', 300, cars);
    const alternative = findVehicleById('CAR-10', cars);

    expect(current.type === 'car' && current.car['מזהה']).toBe('CAR-09');
    expect(alternative?.['מזהה']).toBe('CAR-10');
  });

  it('finds a different valid alternative by its own catalog ID', () => {
    expect(findVehicleById('CAR-10', cars)?.['דגם (כינוי מסחרי)'])
      .toBe('ATTO 3');
  });

  it('preserves the no-current-car waiver path', () => {
    expect(resolveCurrentVehicle(null, 0, cars)).toEqual({
      type: 'waiver'
    });
  });

  it('reports an actionable error for an invalid current vehicle ID', () => {
    expect(() => resolveCurrentVehicle('CAR-99', 0, cars)).toThrow(
      /employees\.current_vehicle_id.*active vehicle_catalog\.id/
    );
  });
});

describe('official tax value lookup', () => {
  beforeEach(() => {
    query.from.mockClear();
    query.select.mockClear();
    query.eq.mockClear();
    query.limit.mockReset();
    query.limit.mockResolvedValue({
      data: [{ monthly_value_of_use: 4070 }],
      error: null
    });

    query.from.mockImplementation(() => {
      const builder: Record<string, (...args: unknown[]) => unknown> = {};
      builder.select = (...args) => {
        query.select(...args);
        return builder;
      };
      builder.eq = (...args) => {
        query.eq(...args);
        return builder;
      };
      builder.limit = (...args) => query.limit(...args);
      return builder;
    });
  });

  it('continues querying official value by all five identifying columns', async () => {
    await expect(getOfficialVehicleTaxValue(vehicle)).resolves.toBe(4070);

    expect(query.from).toHaveBeenCalledWith('vehicle_tax_values');
    expect(query.select).toHaveBeenCalledWith('monthly_value_of_use');
    expect(query.eq.mock.calls).toEqual([
      ['tax_year', 2026],
      ['registration_year', 2025],
      ['vehicle_type_code', '1'],
      ['manufacturer_code', '00413'],
      ['model_code', '00296']
    ]);
    expect(query.limit).toHaveBeenCalledWith(2);
  });
});