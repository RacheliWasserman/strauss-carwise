/** Owner-supplied concept illustrations. Mapping adds presentation only, never catalog facts.
 * Original supplied JPEGs are preserved unchanged, including model-name plates.
 * These are not manufacturer photographs or verified trim/generation representations.
 */
export type VehiclePhoto = { src: string; shows: string; kind: 'ai-illustration' };
export const VEHICLE_PHOTOS: Readonly<Record<string, VehiclePhoto>> = {
  'CAR-01': { src: '/images/vehicles/CAR-01_Kia_Picanto_2025.jpg', shows: 'הדמיית AI להמחשה בלבד', kind: 'ai-illustration' },
  'CAR-02': { src: '/images/vehicles/CAR-02_Toyota_Yaris_Cross_2025.jpg', shows: 'הדמיית AI להמחשה בלבד', kind: 'ai-illustration' },
  'CAR-03': { src: '/images/vehicles/CAR-03_BYD_Dolphin_2025.jpg', shows: 'הדמיית AI להמחשה בלבד', kind: 'ai-illustration' },
  'CAR-04': { src: '/images/vehicles/CAR-04_SEAT_Leon_2025.jpg', shows: 'הדמיית AI להמחשה בלבד', kind: 'ai-illustration' },
  'CAR-05': { src: '/images/vehicles/CAR-05_Kia_Niro_2025.jpg', shows: 'הדמיית AI להמחשה בלבד', kind: 'ai-illustration' },
  'CAR-06': { src: '/images/vehicles/CAR-06_MG4_2025.jpg', shows: 'הדמיית AI להמחשה בלבד', kind: 'ai-illustration' },
  'CAR-07': { src: '/images/vehicles/CAR-07_Toyota_Corolla_2026.jpg', shows: 'הדמיית AI להמחשה בלבד', kind: 'ai-illustration' },
  'CAR-08': { src: '/images/vehicles/CAR-08_Hyundai_Kona_EV_2026.jpg', shows: 'הדמיית AI להמחשה בלבד', kind: 'ai-illustration' },
  'CAR-09': { src: '/images/vehicles/CAR-09_Toyota_Corolla_Cross_2025.jpg', shows: 'הדמיית AI להמחשה בלבד', kind: 'ai-illustration' },
  'CAR-10': { src: '/images/vehicles/CAR-10_BYD_Atto_3_2025.jpg', shows: 'הדמיית AI להמחשה בלבד', kind: 'ai-illustration' },
  'CAR-11': { src: '/images/vehicles/CAR-11_Kia_EV3_2025.jpg', shows: 'הדמיית AI להמחשה בלבד', kind: 'ai-illustration' },
  'CAR-12': { src: '/images/vehicles/CAR-12_Hyundai_Tucson_2025.jpg', shows: 'הדמיית AI להמחשה בלבד', kind: 'ai-illustration' },
  'CAR-13': { src: '/images/vehicles/CAR-13_Mazda_3_2025.jpg', shows: 'הדמיית AI להמחשה בלבד', kind: 'ai-illustration' },
  'CAR-14': { src: '/images/vehicles/CAR-14_Tesla_Model_3_2025.jpg', shows: 'הדמיית AI להמחשה בלבד', kind: 'ai-illustration' },
  'CAR-15': { src: '/images/vehicles/CAR-15_Skoda_Octavia_2025.jpg', shows: 'הדמיית AI להמחשה בלבד', kind: 'ai-illustration' },
  'CAR-16': { src: '/images/vehicles/CAR-16_Kia_Sportage_HEV_2026.jpg', shows: 'הדמיית AI להמחשה בלבד', kind: 'ai-illustration' },
  'CAR-17': { src: '/images/vehicles/CAR-17_BYD_Seal_2025.jpg', shows: 'הדמיית AI להמחשה בלבד', kind: 'ai-illustration' },
  'CAR-18': { src: '/images/vehicles/CAR-18_Toyota_RAV4_2025.jpg', shows: 'הדמיית AI להמחשה בלבד', kind: 'ai-illustration' },
  'CAR-19': { src: '/images/vehicles/CAR-19_Kia_Carnival_2025.jpg', shows: 'הדמיית AI להמחשה בלבד', kind: 'ai-illustration' },
  'CAR-20': { src: '/images/vehicles/CAR-20_Hyundai_Santa_Fe_2025.jpg', shows: 'הדמיית AI להמחשה בלבד', kind: 'ai-illustration' },
};
export const vehiclePhoto = (id: string): VehiclePhoto | null => VEHICLE_PHOTOS[id] ?? null;
