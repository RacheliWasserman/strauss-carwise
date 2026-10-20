import type { z } from 'zod';
import type { catalogFiltersSchema } from '../catalog-message';

type Filters = z.infer<typeof catalogFiltersSchema>;
const normalize = (text: string) => text.normalize('NFC').trim().replace(/[׳״'".!]/g, '');
const newSearch = (text: string) => /(?:חיפוש חדש|חיפוש מחדש|נתחיל מחדש|חפשי מחדש|חפש מחדש)/u.test(text);
const clearDrive = (text: string) => /(?:כל סוגי ההנעה|בלי (?:מסנן|הגבלת) (?:סוג )?הנעה|לא משנה (?:לי )?(?:סוג )?ההנעה)/u.test(text);

function explicitDrive(text: string): string | undefined {
  const matches = [...text.matchAll(/(?:^|[^\p{L}])(חשמלי(?:ת|ים|ות)?|היברידי(?:ת|ים|ות)?|בנזין)(?=$|[^\p{L}])/gu)];
  const positive = matches.filter(match => !/(?:^|[^\p{L}])(?:לא|בלי)\s*$/u.test(text.slice(0, match.index)));
  const value = positive.at(-1)?.[1];
  return value?.startsWith('חשמלי') ? 'חשמלי' : value?.startsWith('היברידי') ? 'היברידי' : value;
}

function onlyGroupAnswer(text: string) {
  return /^(?:(?:הקבוצה שלי(?: היא)?|אני [במ]קבוצה|קבוצתי(?: היא)?|קבוצת (?:הזכאות|הרכב) שלי(?: היא)?)\s*[אבגד]|(?:קבוצה\s*)?[אבגד])$/u.test(normalize(text));
}

/** Omitted fields mean unchanged, never an instruction to broaden a search. */
export function accumulateCatalogFilters(saved: Filters | undefined, proposed: Filters, ownEmployeeTexts: string[]): Filters {
  const latest = ownEmployeeTexts.at(-1) ?? '';
  const reset = newSearch(latest);
  const previous = { ...saved };
  // Recover explicit propulsion from older conversations whose model omitted the filter.
  // New searches and explicit removals delimit recovery; no other sender is supplied here.
  if (!previous.driveType) {
    for (const text of ownEmployeeTexts.slice(0, -1)) {
      if (newSearch(text) || clearDrive(text)) delete previous.driveType;
      const drive = explicitDrive(text);
      if (drive) previous.driveType = drive;
    }
  }
  const patch: Filters = onlyGroupAnswer(latest) ? {} : { ...proposed };
  // A reset must not reintroduce filters merely repeated by the model from history.
  if (reset) for (const key of Object.keys(patch) as Array<keyof Filters>) {
    if (!latest.toLocaleLowerCase().includes(patch[key]!.toLocaleLowerCase())) delete patch[key];
  }
  const filters: Filters = { ...(reset ? {} : previous), ...patch };
  for (const key of ['manufacturer', 'name'] as const) {
    const label = key === 'manufacturer' ? /יצרן/u : /דגם/u;
    if (!reset && previous[key] && patch[key] && patch[key] !== previous[key] &&
      !latest.toLocaleLowerCase().includes(patch[key]!.toLocaleLowerCase()) && !label.test(latest)) {
      filters[key] = previous[key];
    }
  }
  // The model cannot change a saved propulsion preference without the employee saying so.
  if (!reset && previous.driveType && (!patch.driveType || !latest.toLocaleLowerCase().includes(patch.driveType.toLocaleLowerCase()))) {
    filters.driveType = previous.driveType;
  }
  const drive = explicitDrive(latest);
  if (drive) filters.driveType = drive;
  if (clearDrive(latest)) delete filters.driveType;
  if (/(?:בלי (?:מסנן|הגבלת) יצרן|כל היצרנים|לא משנה (?:לי )?היצרן)/u.test(latest)) delete filters.manufacturer;
  if (/(?:בלי (?:מסנן|הגבלת) דגם|כל הדגמים|לא משנה (?:לי )?הדגם)/u.test(latest)) delete filters.name;
  if (/(?:בלי (?:מסנן|הגבלת) קבוצה|כל הקבוצות)/u.test(latest)) delete filters.group;
  return filters;
}
