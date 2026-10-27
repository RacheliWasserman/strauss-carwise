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
export const MODEL_ALIASES: Readonly<Record<string, string[]>> = {
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

/** Drive types written as an answer ("היברידי", "חשמלית"), in the catalog's own spelling. */
export function driveTypeIn(text: string): string | undefined {
  const value = text.match(/(?:^|[^\p{L}])[והב]?(חשמלי(?:ת|ים|ות)?|היברידי(?:ת|ים|ות)?|בנזין|פלאג[-־ ]?אין)(?=$|[^\p{L}])/u)?.[1];
  if (!value) return undefined;
  return value.startsWith('חשמלי') ? 'חשמלי' : value.startsWith('היברידי') ? 'היברידי' : value.startsWith('פלאג') ? 'פלאג-אין' : 'בנזין';
}

/**
 * compared: named only as what another car is compared with ("ATTO 3 לעומת COROLLA CROSS"), not as today's car.
 * replaced: named after "במקום" — today's car, or the car being considered that the employee wants to replace
 * ("במקום ATTO 3 ארצה MODEL 3"); the conversation decides which.
 */
export type DirectedVehicle = { row: CatalogRow; text: string; compared?: boolean; replaced?: boolean };
const COMPARED_BEFORE = /(?:לעומת|מאשר)[\s\-־]*(?:ה[\s\-־]*)?$/u;
const REPLACED_BEFORE = /במקום[\s\-־]*(?:ה[\s\-־]*)?$/u;
const BRAND_WORD = new RegExp(`(?:${BRANDS.flatMap(brand => brand.aliases).map(alias => alias.replace(/ /g, '\\s+')).join('|')})[\\s\\-־]*$`, 'iu');
// Words before a name that make it the car the employee drives TODAY ("מ-", "במקום", "יש לי", "לעומת").
// ("מה ATTO 3 עולה?" is a question word, not "from": "מה" counts only as "מה-".)
const FROM_BEFORE = [/(?:^|[^\p{L}])ו?(?:מ[\s\-־]*|מה[\-־]\s*)$/u, /(?:במקום|לעומת|מאשר|להחליף(?:\s+את)?)[\s\-־]*(?:ה[\s\-־]*)?$/u,
  /(?:יש\s+לי|הרכב\s+(?:שלי|הנוכחי(?:\s+שלי)?|הצמוד(?:\s+שלי)?)(?:\s+(?:הוא|זה))?|נוהג(?:ת)?\s+ב|נוסע(?:ת)?\s+(?:עם|ב)|כיום|היום)[\s:\-־]*(?:ה[\s\-־]*)?$/u];
// ...and the car the employee WANTS ("ל-", "לעבור ל", "רוצה", "להחליף ... ב-").
const TO_BEFORE = [/(?:^|[^\p{L}])ו?לה?[\s\-־]*$/u,
  /(?:רוצה|רוצים|מעוניין|מעוניינת|שוקל|שוקלת|בוחר|בוחרת|לבחור|לקחת)(?:\s+(?:את|ב|ל))?[\s\-־]*(?:ה[\s\-־]*)?$/u];
/**
 * Which written catalog cars are the employee's car today and which are the car they want, from the words directly
 * before each name: "לעבור מ-COROLLA CROSS ל-BYD ATTO 3", "במקום הקורולה קרוס", "יש לי COROLLA CROSS ואני רוצה ATTO 3".
 * A brand word between them ("ל-BYD ATTO 3") is skipped. A name with no such words is neither.
 */
export function vehicleDirection(text: string, rows: CatalogRow[]): { from: DirectedVehicle[]; to: DirectedVehicle[] } {
  const replace = /להחליף/u.test(text);
  const hits: Array<{ item: DirectedVehicle; start: number; end: number; side?: 'from' | 'to' }> = [];
  for (const row of rows) {
    for (const spelling of [row.display_name, ...(MODEL_ALIASES[row.display_name] ?? [])]) {
      const pattern = spelling.split(/\s+/).map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s\\-־]*');
      // A Hebrew spelling may carry its prefix letters ("מקורולה קרוס", "לאטו 3").
      const found = new RegExp(`(?:^|[^\\p{L}\\p{N}])((?:[ומלבה]{1,2})?)(${pattern})(?![\\p{L}\\p{N}])`, 'giu');
      for (const match of text.matchAll(found)) {
        const end = match.index! + match[0].length;
        const start = end - match[2].length - match[1].length;
        const before = text.slice(Math.max(0, start - 40), start).replace(BRAND_WORD, '');
        // Prefix letters written on the name itself ("מקורולה קרוס", "לאטו 3") decide first.
        // (A bare article "ה" says nothing: "במקום הקורולה קרוס" is decided by the words before it.)
        const attached = match[1].replace(/^ו/u, '').replace(/^ה$/u, '');
        // "להחליף את X ב-Y": after "להחליף", "ב-" names the wanted car.
        const replacing = replace && (attached.startsWith('ב') || /(?:^|[^\p{L}])ב[\s\-־]*$/u.test(before));
        // An attached "ב" is read with the words before it: "אני נוסע בקורולה קרוס" (today's car), "רוצה בקורולה" (wanted).
        const words = attached.startsWith('ב') ? `${before}${attached}` : attached ? '' : before;
        const side = attached.startsWith('מ') || (!replacing && words && FROM_BEFORE.some(rule => rule.test(words))) ? 'from'
          : attached.startsWith('ל') || replacing || (words && TO_BEFORE.some(rule => rule.test(words))) ? 'to' : undefined;
        const compared = side === 'from' && !attached && COMPARED_BEFORE.test(before);
        const replaced = side === 'from' && !attached && REPLACED_BEFORE.test(before);
        hits.push({ item: { row, text: match[2], ...(compared ? { compared } : {}), ...(replaced ? { replaced } : {}) }, start, end, side });
      }
    }
  }
  // "COROLLA CROSS" also contains "COROLLA": the longer name written is the one meant.
  const kept = hits.filter(hit => !hits.some(other => other !== hit && other.start <= hit.start && other.end >= hit.end && other.end - other.start > hit.end - hit.start));
  const from = new Map(kept.filter(hit => hit.side === 'from').map(hit => [hit.item.row.id, hit.item]));
  // A car named as both (e.g. repeated) counts as the wanted one only if it is never named as today's car.
  const to = new Map(kept.filter(hit => hit.side === 'to' && !from.has(hit.item.row.id)).map(hit => [hit.item.row.id, hit.item]));
  return { from: [...from.values()], to: [...to.values()] };
}

/** A brand or the word "מודל" written in Hebrew ("טסלה מודל Y"): the message may name a car without Latin words. */
export function namesVehicleInHebrew(text: string): boolean {
  const normalized = normalizeVehicleText(text);
  return /(?:^|[^\p{L}])[ובלמה]?מודל(?=$|[^\p{L}])/u.test(text) ||
    BRANDS.some(brand => brand.aliases.some(alias => /\p{Script=Hebrew}/u.test(alias) && phrase(normalized, normalizeVehicleText(alias))));
}

/**
 * Car models the employee names that are not in the active catalog ("Tesla Model Y", "מודל Y"), with the catalog cars of
 * the same brand. A brand followed by a model word that names no catalog row counts; a brand alone ("יש לכם קיה?") or a
 * catalog model ("BYD ATTO 3") does not.
 */
export function unlistedVehicles(text: string, rows: CatalogRow[]): Array<{ name: string; brandRows: CatalogRow[] }> {
  const found = new Map<string, { name: string; brandRows: CatalogRow[] }>();
  const known = (words: string) => vehiclesMentioned(words, rows).length > 0 ||
    rows.some(row => (MODEL_ALIASES[row.display_name] ?? []).some(alias => phrase(normalizeVehicleText(words), normalizeVehicleText(alias))));
  const model = '((?:model|מודל)[\\s\\-־]*[A-Za-z0-9]{1,4}|[A-Za-z][A-Za-z0-9]{0,11}(?:[\\s\\-־]+[A-Za-z0-9]{1,6})?)';
  for (const brand of BRANDS) {
    const ofBrand = rows.filter(row => normalizeVehicleText(row.manufacturer_name).startsWith(normalizeVehicleText(brand.catalog)));
    for (const alias of brand.aliases) {
      const pattern = new RegExp(`(?:^|[^\\p{L}\\p{N}])[ובלמה]?(${alias.replace(/ /g, '\\s+')})[\\s\\-־]+${model}(?![\\p{L}\\p{N}])`, 'giu');
      for (const match of text.matchAll(pattern)) {
        if (known(match[2]) || known(`${match[1]} ${match[2]}`)) continue;
        const name = `${match[1]} ${match[2]}`.replace(/\s+/g, ' ');
        found.set(normalizeVehicleText(name), { name, brandRows: ofBrand });
      }
    }
  }
  // "Model Y" without a brand: a model word with a short code that names no catalog row.
  for (const match of text.matchAll(/(?:^|[^\p{L}\p{N}])((?:model|מודל)[\s\-־]*[A-Za-z0-9]{1,3})(?![\p{L}\p{N}])/giu)) {
    if (known(match[1]) || [...found.values()].some(item => normalizeVehicleText(item.name).includes(normalizeVehicleText(match[1])))) continue;
    const tesla = rows.filter(row => normalizeVehicleText(row.manufacturer_name).startsWith(normalizeVehicleText('טסלה')));
    found.set(normalizeVehicleText(match[1]), { name: match[1], brandRows: tesla });
  }
  return [...found.values()];
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
