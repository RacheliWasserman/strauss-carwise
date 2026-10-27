import { describe, expect, it } from 'vitest';
import { cars } from '../src/lib/data';
import { driveTypeIn, identifyCurrentVehicle, identifyVehicle, normalizeVehicleText, vehicleDirection } from '../src/lib/ai/vehicle-identification';

// The real catalog data of the challenge, as active catalog rows.
const rows = cars.map(car => ({ id: car['מזהה'], display_name: car['דגם (כינוי מסחרי)'], manufacturer_name: car['תוצר'],
  group_code: car['קבוצה'], drive_type: car['הנעה'] }));
const id = (text: string) => { const found = identifyVehicle(text, rows); return found.kind === 'match' ? found.row.id : found.kind === 'choose' ? found.rows.map(row => row.id) : null; };

describe('identifying the current car from the employee\'s words', () => {
  it.each(['TUCSON', 'tucson', 'יש לי TUCSON', 'HYUNDAI TUCSON', 'יונדאי טוסון', 'טוסון', 'כן, יונדאי טוסון מצ\'כיה', 'בטוסון', 'Tucson 2023', 'TUSCON', 'TUCSOM'])(
    '"%s" → TUCSON (CAR-12)', text => expect(id(text)).toBe('CAR-12'));
  it.each([
    ['COROLLA CROSS', 'CAR-09'], ['קורולה קרוס', 'CAR-09'], ['קורולה', 'CAR-07'], ['COROLLA', 'CAR-07'], ['MG4', 'CAR-06'], ['ATTO3', 'CAR-10'],
    ['אטו 3', 'CAR-10'], ['ראב 4', 'CAR-18'], ['RAV4', 'CAR-18'], ['קיה פיקנטו', 'CAR-01'], ['PIKANTO', 'CAR-01'], ['ספורטז\'', 'CAR-16'], ['מודל 3', 'CAR-14'],
    ['CAR-12', 'CAR-12'], ['הרכב הצמוד שלי היום: KONA EV (CAR-08)', 'CAR-08']
  ])('"%s" → %s', (text, expected) => expect(id(text)).toBe(expected));
  it('a manufacturer (with or without country, with or without geresh) is a choice among its catalog models, never a guessed model', () => {
    for (const text of ["יונדאי צ'כיה", 'יונדאי צכיה', 'כן יונדאי צ׳כיה', 'Hyundai Czech']) {
      const found = identifyVehicle(text, rows);
      if (text === 'Hyundai Czech') { expect(found).toMatchObject({ kind: 'choose', basis: 'manufacturer' }); continue; }
      expect(found).toMatchObject({ kind: 'choose', basis: 'manufacturer', manufacturer: "יונדאי צ'כיה" });
      expect(found.kind === 'choose' && found.rows.map(row => row.id)).toEqual(['CAR-08', 'CAR-12']);
    }
    expect(id('יונדאי')).toEqual(['CAR-08', 'CAR-12', 'CAR-20']);
    expect(id('יונדאי קוריאה')).toEqual(['CAR-20']); // A single model is confirmed, not assumed.
    expect(identifyVehicle('קיה', rows)).toMatchObject({ kind: 'choose', basis: 'manufacturer' });
  });
  it('several models written are a choice; nothing recognisable is "none"', () => {
    expect((id('קורולה או RAV4') as string[]).sort()).toEqual(['CAR-07', 'CAR-18']);
    for (const text of ['כן', 'יש לי רכב', 'רכב ישן של העבודה', 'פיאט פנדה']) expect(identifyVehicle(text, rows)).toEqual({ kind: 'none' });
  });
  it('the employee\'s words outrank a model\'s guess; the guess only fills in when the words name nothing', () => {
    expect(identifyCurrentVehicle("כן יונדאי צ'כיה", 'HYUNDAI TUCSON', rows)).toMatchObject({ kind: 'choose', basis: 'manufacturer' });
    expect(identifyCurrentVehicle('קורולה ישנה', 'COROLLA CROSS', rows)).toMatchObject({ kind: 'match', row: { id: 'CAR-07' } });
    expect(identifyCurrentVehicle('את זה עם הגג הנפתח', 'TUCSON', rows)).toMatchObject({ kind: 'match', row: { id: 'CAR-12' } });
    expect(identifyCurrentVehicle('משהו אחר', 'FIAT PANDA', rows)).toEqual({ kind: 'none' });
  });
  it('normalizes Hebrew punctuation instead of splitting words', () => {
    expect(normalizeVehicleText("צ'כיה")).toBe('צכיה');expect(normalizeVehicleText('צ׳כיה')).toBe('צכיה');
    expect(normalizeVehicleText('מ.ג סין')).toBe('מג סין');
  });
});

describe('today\'s car and the wanted car in one sentence', () => {
  const sides = (text: string) => { const found = vehicleDirection(text, rows); return { from: found.from.map(item => item.row.id), to: found.to.map(item => item.row.id) }; };
  it.each([
    ['אני רוצה לעבור מ-COROLLA CROSS ל-BYD ATTO 3. כמה זה ישפיע לי על הנטו?', ['CAR-09'], ['CAR-10']],
    ['אני רוצה לעבור מ-COROLLA CROSS ל-ATTO 3', ['CAR-09'], ['CAR-10']],
    ['לעבור מקורולה קרוס לאטו 3', ['CAR-09'], ['CAR-10']],
    ['מ COROLLA CROSS ל ATTO 3', ['CAR-09'], ['CAR-10']],
    ['במקום הקורולה קרוס אני רוצה ATTO 3', ['CAR-09'], ['CAR-10']],
    ['יש לי COROLLA CROSS ואני רוצה ATTO 3', ['CAR-09'], ['CAR-10']],
    ['להחליף את COROLLA CROSS ב-ATTO 3', ['CAR-09'], ['CAR-10']],
    ['ATTO 3 לעומת COROLLA CROSS', ['CAR-09'], []],
    ['הרכב הנוכחי שלי הוא COROLLA CROSS', ['CAR-09'], []]
  ])('"%s"', (text, from, to) => expect(sides(text)).toEqual({ from, to }));
  it('names without such words are neither; a question word is not "from"', () => {
    expect(sides('מה ATTO 3 עולה?')).toEqual({ from: [], to: [] });
    expect(sides('כמה BYD Atto 3 ישנה לי בנטו לעומת הרכב שיש לי היום?')).toEqual({ from: [], to: [] });
    expect(sides('COROLLA CROSS')).toEqual({ from: [], to: [] });
    // "COROLLA" inside "COROLLA CROSS" is not a second car.
    expect(sides('לעבור מ-COROLLA CROSS ל-MAZDA 3')).toEqual({ from: ['CAR-09'], to: ['CAR-13'] });
  });
  it('reads a drive type written as an answer', () => {
    expect([driveTypeIn('היברידי'), driveTypeIn('חשמלית'), driveTypeIn('בנזין'), driveTypeIn('פלאג-אין'), driveTypeIn('COROLLA')])
      .toEqual(['היברידי', 'חשמלי', 'בנזין', 'פלאג-אין', undefined]);
  });
});
