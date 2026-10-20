import type { AdvisorOccupation } from '../occupation-repository';

/**
 * Deterministic retrieval of official occupation candidates from employee text.
 * Forms are derived generically from the official titles (slash gender notation,
 * feminine ה, construct ת, one-letter prefixes); there are no per-phrase special cases.
 * The result only names rows from the supplied official list.
 */
export type OccupationDetection = { rows: AdvisorOccupation[]; exact: boolean; phrase: string };
type Token = { forms: Set<string>; start: number; end: number };

const PREFIX = /^[והבלשכ]{1,2}$/u;
const clean = (text: string) => text.normalize('NFC').replace(/[֑-ׇ]/gu, '').replace(/[׳״'"]/gu, '').toLocaleLowerCase();

/** Every surface form of one word, without and with common one/two-letter prefixes removed. */
function surface(word: string): Set<string> {
  const forms = new Set<string>();
  const add = (form: string) => {
    if (form.length < 2) return;
    forms.add(form);
    for (let size = 1; size <= 2; size++) {
      const rest = form.slice(size);
      if (rest.length >= 2 && PREFIX.test(form.slice(0, size))) forms.add(rest);
    }
  };
  const [base, suffix] = word.split('/');
  add(base);
  if (suffix) {
    add(base + suffix);
    if (suffix === 'ת') add(base + 'ה');
  }
  // Construct state (מחלקה → מחלקת) is a frequent natural variant.
  if (!suffix && base.endsWith('ה')) add(base.slice(0, -1) + 'ת');
  return forms;
}

function tokenize(text: string): Token[] {
  return [...text.matchAll(/[\p{L}\p{M}/׳״'"]+/gu)].flatMap(match => {
    const word = clean(match[0]).replace(/^\/+|\/+$/g, '');
    return word ? [{ forms: surface(word), start: match.index!, end: match.index! + match[0].length }] : [];
  });
}

const overlaps = (a: Set<string>, b: Set<string>) => [...a].some(form => b.has(form));
/** One inserted, deleted or replaced letter ("תכנה" ↔ "תוכנה"), only for words of four letters or more. */
function oneEditApart(a: string, b: string) {
  if (a === b || Math.min(a.length, b.length) < 4 || Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}
const nearly = (a: Set<string>, b: Set<string>) => [...a].some(x => [...b].some(y => oneEditApart(x, y)));

export function detectOccupation(text: string, occupations: AdvisorOccupation[], options: { partial?: boolean } = {}): OccupationDetection | null {
  const words = tokenize(text.slice(0, 1000));
  if (!words.length || !occupations.length) return null;
  const exact: Array<{ row: AdvisorOccupation; size: number; start: number; end: number }> = [];
  const partial: AdvisorOccupation[] = [];
  let partialStart = Infinity, partialEnd = -1;
  for (const row of occupations) {
    const title = tokenize(row.title);
    if (!title.length) continue;
    // Exact: all title words, contiguous and in order.
    for (let index = 0; index + title.length <= words.length; index++) {
      if (title.every((part, offset) => overlaps(part.forms, words[index + offset].forms))) {
        exact.push({ row, size: title.length, start: words[index].start, end: words[index + title.length - 1].end });
        break;
      }
    }
    const hits = words.filter(word => title.some(part => overlaps(part.forms, word.forms)));
    if (hits.length) {
      partial.push(row);
      partialStart = Math.min(partialStart, hits[0].start);
      partialEnd = Math.max(partialEnd, hits.at(-1)!.end);
    }
  }
  if (exact.length) {
    // A longer official title covering a shorter one is the more specific match.
    const best = exact.filter(match => !exact.some(other => other.size > match.size && other.start <= match.start && other.end >= match.end));
    return { rows: best.map(match => match.row).slice(0, 5), exact: true, phrase: text.slice(best[0].start, best[0].end).slice(0, 120) };
  }
  // A minor typo in a full official title is offered for confirmation, never decided silently.
  const near: Array<{ row: AdvisorOccupation; start: number; end: number }> = [];
  for (const row of occupations) {
    const title = tokenize(row.title);
    for (let index = 0; title.length > 1 && index + title.length <= words.length; index++) {
      const window = title.map((part, offset) => words[index + offset]);
      const exactParts = title.filter((part, offset) => overlaps(part.forms, window[offset].forms)).length;
      if (exactParts >= 1 && title.every((part, offset) => overlaps(part.forms, window[offset].forms) || nearly(part.forms, window[offset].forms))) {
        near.push({ row, start: window[0].start, end: window.at(-1)!.end });
        break;
      }
    }
  }
  if (near.length && near.length <= 5) return { rows: near.map(match => match.row), exact: false, phrase: text.slice(near[0].start, near[0].end).slice(0, 120) };
  // Partial candidates are only for an explicit occupation answer and never decide a match alone.
  if (!options.partial || !partial.length || partial.length > 5) return null;
  const phrase = text.trim().length <= 120 ? text.trim() : text.slice(partialStart, partialEnd).slice(0, 120);
  return { rows: partial, exact: false, phrase };
}
