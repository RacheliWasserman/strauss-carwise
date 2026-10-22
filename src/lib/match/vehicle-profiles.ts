import 'server-only';
import { z } from 'zod';
import draft from '../../../data/vehicle-specs-draft.json';
import type { VehicleProfile } from './match-engine';

/**
 * Supplemental vehicle information for CarWise Match (data/vehicle-specs-draft.json): general MODEL-LEVEL knowledge,
 * explicitly "research_draft_unverified" and not checked against the exact trim. It is joined to the catalog by exact
 * CAR ID and used only for soft lifestyle signals. The catalog stays the only source of identity, group, powertrain,
 * eligibility and money; nothing here overwrites it. Unknown, null or self-contradictory values become "no data".
 */
const status = z.enum(['unverified_model_level', 'unknown', 'catalog_provided']);
const field = <T extends z.ZodTypeAny>(value: T) => z.object({ value: value.nullable(), status, note: z.string() }).strict();
const vehicleSchema = z.object({
  vehicleId: z.string().regex(/^CAR-\d{2}$/), manufacturer: z.string(), model: z.string(), registrationYear: z.number().int(),
  catalogPowertrain: field(z.enum(['gasoline', 'hybrid', 'electric', 'plug_in'])),
  specifications: z.object({
    bodyType: field(z.enum(['hatchback', 'sedan', 'small_suv', 'suv', 'crossover', 'minivan', 'unknown'])),
    seats: field(z.number().int()), trunkLitersApprox: field(z.number()),
    wltpRangeKmByVariant: z.object({ min: z.number().nullable(), max: z.number().nullable(), status, note: z.string() }).strict(),
    fuelConsumptionLPer100Km: field(z.number()), batteryKWh: field(z.number()), dcChargingKw: field(z.number()),
    lengthMm: field(z.number()), safetyRating: field(z.union([z.number(), z.string()]))
  }).strict(),
  qualitativeTags: z.object({
    typicalUse: field(z.enum(['city', 'mixed', 'long_distance', 'family'])),
    sizeClass: field(z.enum(['small', 'compact', 'family', 'large_family']))
  }).strict(),
  exactTrimVerified: z.boolean(), sourceUrls: z.array(z.string()),
  approvedForAutomatedRanking: z.object({ powertrain: z.boolean(), seats: z.boolean(), trunk: z.boolean(), range: z.boolean(), qualitativeTags: z.boolean() }).strict(),
  verificationNeeded: z.array(z.string())
}).strict();
export const vehicleSpecsSchema = z.object({
  schemaVersion: z.literal('1.0'), datasetPurpose: z.string(), createdOn: z.string(), importantWarnings: z.array(z.string()),
  verificationStatus: z.literal('research_draft_unverified'), vehicles: z.array(vehicleSchema).max(200)
}).strict().refine(data => new Set(data.vehicles.map(vehicle => vehicle.vehicleId)).size === data.vehicles.length, 'Duplicate vehicle IDs');
type SpecVehicle = z.infer<typeof vehicleSchema>;

const known = <T>(item: { value: T | null; status: string }) => item.status === 'unknown' || item.value === null ? undefined : item.value;
const plausible = (value: number | undefined, min: number, max: number) => value !== undefined && value >= min && value <= max ? value : undefined;

export function toVehicleProfile(vehicle: SpecVehicle): VehicleProfile {
  const spec = vehicle.specifications;
  const body = known(spec.bodyType);
  const range = spec.wltpRangeKmByVariant;
  const profile: VehicleProfile = {
    bodyType: body && body !== 'unknown' ? body : undefined,
    seats: plausible(known(spec.seats) ?? undefined, 2, 9),
    trunkLiters: plausible(known(spec.trunkLitersApprox) ?? undefined, 50, 2000),
    rangeKm: range.status !== 'unknown' && range.min !== null && range.max !== null && range.min > 0 && range.min <= range.max
      ? { min: range.min, max: range.max } : undefined,
    typicalUse: known(vehicle.qualitativeTags.typicalUse) ?? undefined,
    sizeClass: known(vehicle.qualitativeTags.sizeClass) ?? undefined
  };
  return Object.fromEntries(Object.entries(profile).filter(([, value]) => value !== undefined)) as VehicleProfile;
}

// Validated once, at module load; an invalid file fails loudly in tests and builds rather than silently.
const dataset = vehicleSpecsSchema.parse(draft);
const profiles = new Map(dataset.vehicles.map(vehicle => [vehicle.vehicleId, { year: vehicle.registrationYear, profile: toVehicleProfile(vehicle) }]));

/**
 * The model-level profile for an exact catalog ID. When the catalog's registration year is known and differs, the
 * record may describe another vehicle, so no profile is used (unknown, never a guess).
 */
export function vehicleProfileFor(id: string, catalogRegistrationYear?: number): VehicleProfile | undefined {
  const entry = profiles.get(id);
  if (!entry || (catalogRegistrationYear !== undefined && catalogRegistrationYear !== entry.year)) return undefined;
  return entry.profile;
}
export const vehicleSpecsDataset = dataset;
