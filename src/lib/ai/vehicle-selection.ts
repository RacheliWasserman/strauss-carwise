import type { CatalogMessage } from '../catalog-message';

/**
 * Vehicle selection against the active catalog only. Names are matched generically from the catalog's own
 * display names and IDs (no per-model rules); eligibility uses the official group order from the rules.
 */
export type CatalogRow = CatalogMessage['cards'][number];
type Search = (input: { limit: number; afterId?: string }) => Promise<{ vehicles: CatalogRow[]; hasMore: boolean; nextCursor: string | null }>;

const normalize = (text: string) => text.normalize('NFC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** "ATTO 3" also matches "ATTO3", "ATTO-3" and "ל-ATTO 3", but never "ATTO 30". */
function namePattern(name: string) {
  const tokens = normalize(name).split(' ').filter(Boolean).map(escape);
  return tokens.length ? new RegExp(`(?<![\\p{L}\\p{N}])${tokens.join('\\s*')}(?![\\p{L}\\p{N}])`, 'u') : null;
}
/** Active catalog rows explicitly written in the text (name or ID), in order of appearance. */
export function vehiclesMentioned(text: string, rows: CatalogRow[]): CatalogRow[] {
  const haystack = normalize(text);
  const hits: Array<{ row: CatalogRow; start: number; end: number }> = [];
  for (const row of rows) {
    for (const label of [row.display_name, row.id]) {
      const match = namePattern(label)?.exec(haystack);
      if (match) { hits.push({ row, start: match.index, end: match.index + match[0].length }); break; }
    }
  }
  // A longer catalog name covering a shorter one ("COROLLA CROSS" ⊃ "COROLLA") is the one meant.
  const kept = hits.filter(hit => !hits.some(other => other !== hit && other.start <= hit.start && other.end >= hit.end &&
    other.end - other.start > hit.end - hit.start));
  return [...new Map(kept.sort((a, b) => a.start - b.start).map(hit => [hit.row.id, hit.row])).values()];
}

/** Catalog rows for a model name supplied by the model (possibly the catalog spelling of Hebrew text). */
export function vehiclesNamed(name: string, rows: CatalogRow[]): CatalogRow[] {
  const wanted = normalize(name);
  if (!wanted) return [];
  const exact = rows.filter(row => normalize(row.display_name) === wanted || normalize(row.id) === wanted);
  return exact.length ? exact : rows.filter(row => normalize(row.display_name).includes(wanted));
}

export async function activeCatalog(search: Search): Promise<CatalogRow[]> {
  const rows: CatalogRow[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const result = await search({ limit: 50, ...(cursor ? { afterId: cursor } : {}) });
    rows.push(...result.vehicles);
    if (!result.hasMore || !result.nextCursor || result.nextCursor === cursor) break;
    cursor = result.nextCursor;
  }
  return rows;
}

/** Same rule as catalog recommendations: own group or lower; family cars only from the official family list. */
export function selectableForGroup(row: CatalogRow, group: string, rules: { groupOrder: string[]; familyTrack: { cars: string[] } }) {
  if (row.group_code === 'משפחתי') return rules.familyTrack.cars.includes(row.id);
  const own = rules.groupOrder.indexOf(group);
  const index = rules.groupOrder.indexOf(row.group_code);
  return own >= 0 && index >= 0 && index <= own;
}

/** "ATTO 3", "ATTO 3 ו-EV3", "ATTO 3, EV3 ו-MG4" */
export function joinNames(names: string[]) {
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} ו־${names.at(-1)}` : names[0] ?? '';
}
