import { vehiclesMentioned, type CatalogRow } from './vehicle-selection';

/**
 * Identifies the employee's CURRENT company car from their own words, against the active catalog only.
 * Deterministic and independent of the language model: a model's guess is used only when the employee's text names
 * nothing recognisable, and never against what the text says (e.g. a guessed "TUCSON" for "יונדאי צ'כיה").
 * Results: one catalog row, a short list to choose from (a manufacturer, or several models), or nothing.
 */
export type VehicleIdentification =
  | { kind: 'match'; row: CatalogRow }
  | { kind: 'choose'; rows: CatalogRow[]; basis: 'manufacturer' | 'name'; manufacturer?: string }
  | { kind: 'none' };

/** Hebrew spellings of catalog model names (keyed by the catalog's display name; used only if that row is active). */
const MODEL_ALIASES: Record<string, string[]> = {
  'PICANTO': ['פיקנטו'], 'YARIS CROSS HSD': ['יאריס קרוס', 'יאריס קרוס הייבריד'], 'BYD DOLPHIN': ['דולפין', 'בי ווי די דולפין'],
  'LEON': ['לאון', 'ליאון'], 'NIRO': ['נירו'], 'MG4': ['אם גי 4', 'אמ גי 4', 'מג 4'], 'COROLLA': ['קורולה'], 'KONA EV': ['קונה', 'קונה חשמלית'],
  'COROLLA CROSS': ['קורולה קרוס'], 'ATTO 3': ['אטו 3', 'אטו3'], 'EV3': ['אי וי 3', 'איוי 3'], 'TUCSON': ['טוסון', 'טוקסון', 'טוסאן'],
  'MAZDA 3': ['מאזדה 3', 'מזדה 3'], 'MODEL 3': ['מודל 3', 'טסלה מודל 3'], 'OCTAVIA': ['אוקטביה', 'אוקטבייה'],
  'SPORTAGE HEV': ['ספורטז', 'ספורטאז', 'ספורטאג'], 'SEAL': ['סיל'], 'RAV4': ['ראב 4', 'ראב4', 'רב 4', 'ראו 4'],
  'CARNIVAL': ['קרניבל'], 'SANTA FE': ['סנטה פה', 'סנטפה']
};
/** Brand words (Hebrew and English) for each brand as the catalog writes it at the start of manufacturer_name. */
const BRANDS: Array<{ catalog: string; aliases: string[] }> = [
  { catalog: 'יונדאי', aliases: ['יונדאי', 'יונדאיי', 'hyundai'] }, { catalog: 'קיה', aliases: ['קיה', 'kia'] },
  { catalog: 'טויוטה', aliases: ['טויוטה', 'toyota'] }, { catalog: 'סיאט', aliases: ['סיאט', 'seat'] },
  { catalog: 'בי ווי די', aliases: ['בי ווי די', 'ביוואידי', 'byd'] }, { catalog: 'מג', aliases: ['מג', 'אם גי', 'mg'] },
  { catalog: 'מזדה', aliases: ['מזדה', 'מאזדה', 'mazda'] }, { catalog: 'טסלה', aliases: ['טסלה', 'tesla'] },
  { catalog: 'סקודה', aliases: ['סקודה', 'skoda'] }
];

/** Lower case, Hebrew punctuation (geresh, gershayim, quotes, dots) removed rather than spaced: "צ'כיה" = "צכיה". */
export const normalizeVehicleText = (text: string) => text.normalize('NFC').toLocaleLowerCase()
  .replace(/[׳״'"`’‘.]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const phrase = (text: string, words: string) => new RegExp(`(?:^| )(?:[והבלמש])?${words.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?: |$)`, 'u').test(` ${text} `);

/** Optimal string alignment distance (a transposition counts once), for small typos such as "TUSCON". */
function distance(a: string, b: string) {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i ? (j ? 0 : i) : j)));
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    rows[i][j] = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) rows[i][j] = Math.min(rows[i][j], rows[i - 2][j - 2] + 1);
  }
  return rows[a.length][b.length];
}

function modelsIn(text: string, rows: CatalogRow[]): CatalogRow[] {
  const normalized = normalizeVehicleText(text);
  const found = new Map<string, CatalogRow>();
  for (const row of vehiclesMentioned(text, rows)) found.set(row.id, row);
  for (const row of rows) {
    if ((MODEL_ALIASES[row.display_name] ?? []).some(alias => phrase(normalized, normalizeVehicleText(alias)))) found.set(row.id, row);
  }
  // "COROLLA CROSS" also contains "COROLLA": the longer catalog name is the one meant.
  const named = [...found.values()];
  const kept = named.filter(row => !named.some(other => other !== row &&
    normalizeVehicleText(other.display_name).includes(normalizeVehicleText(row.display_name)) && other.display_name.length > row.display_name.length));
  if (kept.length) return kept;
  // One-letter typos in a model word of five or more letters ("TUSCON", "PIKANTO"), only when exactly one row fits.
  const words = normalized.split(' ').filter(word => word.length >= 5);
  const typo = rows.filter(row => {
    const names = [row.display_name, ...(MODEL_ALIASES[row.display_name] ?? [])].map(name => normalizeVehicleText(name).replace(/ /g, ''));
    return names.some(name => name.length >= 5 && words.some(word => distance(word, name) <= 1));
  });
  return typo.length === 1 ? typo : [];
}

function manufacturerIn(text: string, rows: CatalogRow[]) {
  const normalized = normalizeVehicleText(text);
  for (const brand of BRANDS) {
    if (!brand.aliases.some(alias => phrase(normalized, normalizeVehicleText(alias)))) continue;
    const ofBrand = rows.filter(row => normalizeVehicleText(row.manufacturer_name).startsWith(normalizeVehicleText(brand.catalog)));
    if (!ofBrand.length) continue;
    // "יונדאי צ'כיה" names the full catalog manufacturer (brand + country): narrow to it when written.
    const exact = ofBrand.filter(row => normalized.includes(normalizeVehicleText(row.manufacturer_name)));
    const chosen = exact.length ? exact : ofBrand;
    return { rows: chosen, manufacturer: exact.length ? exact[0].manufacturer_name : brand.catalog };
  }
  return null;
}

export function identifyVehicle(text: string, rows: CatalogRow[]): VehicleIdentification {
  const models = modelsIn(text, rows);
  const manufacturer = manufacturerIn(text, rows);
  // A model of a different manufacturer than the one written is not trusted on its own.
  const consistent = manufacturer ? models.filter(row => manufacturer.rows.some(item => item.id === row.id) ||
    normalizeVehicleText(row.manufacturer_name).startsWith(normalizeVehicleText(manufacturer.manufacturer.split(' ')[0]))) : models;
  if (consistent.length === 1) return { kind: 'match', row: consistent[0] };
  if (consistent.length > 1) return { kind: 'choose', rows: consistent.slice(0, 6), basis: 'name' };
  if (manufacturer) return { kind: 'choose', rows: manufacturer.rows.slice(0, 6), basis: 'manufacturer', manufacturer: manufacturer.manufacturer };
  return { kind: 'none' };
}

/**
 * The employee's text decides; the language model's suggested name only fills in when the text names nothing.
 * A suggestion that is not among the candidates the text allows is ignored.
 */
export function identifyCurrentVehicle(text: string, modelName: string | undefined, rows: CatalogRow[]): VehicleIdentification {
  const fromText = identifyVehicle(text, rows);
  if (fromText.kind !== 'none') return fromText;
  return modelName ? identifyVehicle(modelName, rows) : fromText;
}
