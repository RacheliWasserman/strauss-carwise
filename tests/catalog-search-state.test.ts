import { expect, it } from 'vitest';
import { accumulateCatalogFilters } from '../src/lib/ai/catalog-search-state';

it.each([['אני רוצה חשמלית','חשמלי'],['בעצם אני רוצה היברידי','היברידי'],['אני רוצה היברידית','היברידי'],['רכב בנזין בבקשה','בנזין']])('enforces explicit propulsion without a model filter: %s', (text,driveType) => {
  expect(accumulateCatalogFilters({manufacturer:'Fixture'}, {}, [text])).toEqual({manufacturer:'Fixture',driveType});
});
it('does not change any saved search fields on a group-only answer despite model drift', () => {
  const saved = {name:'Old Model',manufacturer:'Old Maker',driveType:'חשמלי'};
  expect(accumulateCatalogFilters(saved,{name:'Wrong Model',manufacturer:'Wrong Maker',driveType:'בנזין',group:'ב'},['אני בקבוצה ב׳'])).toEqual(saved);
});
it('recovers explicit propulsion omitted from a previously saved envelope', () => {
  expect(accumulateCatalogFilters({}, {}, ['אני מחפשת רכב חשמלי','אני בקבוצה ב׳'])).toEqual({driveType:'חשמלי'});
});
it('updates an explicitly changed manufacturer or model while retaining the other constraints', () => {
  const saved = {manufacturer:'Old Maker',name:'Model A',driveType:'חשמלי'};
  const maker = accumulateCatalogFilters(saved,{manufacturer:'New Maker'},['בעצם אני רוצה New Maker']);
  expect(maker).toEqual({...saved,manufacturer:'New Maker'});
  expect(accumulateCatalogFilters(maker,{name:'Model B'},['חפשי דגם Model B'])).toEqual({...maker,name:'Model B'});
});
it('does not let a model change unrelated manufacturer and model fields on a propulsion update', () => {
  const saved = {manufacturer:'Maker',name:'Model A',driveType:'חשמלי'};
  expect(accumulateCatalogFilters(saved,{manufacturer:'Wrong',name:'Wrong'},['בעצם אני רוצה היברידי'])).toEqual({...saved,driveType:'היברידי'});
});
it('clears search constraints on an explicit new search, even if the model repeats stale filters', () => {
  const saved = {manufacturer:'Maker',name:'Model A',driveType:'חשמלי'};
  expect(accumulateCatalogFilters(saved,saved,['חיפוש חדש'])).toEqual({});
  expect(accumulateCatalogFilters(saved,saved,['חיפוש חדש, רכב היברידי'])).toEqual({driveType:'היברידי'});
});
it('supports explicit removal without dropping other fields or reviving a recovered propulsion', () => {
  const saved = {manufacturer:'Maker',name:'Model A',driveType:'חשמלי'};
  expect(accumulateCatalogFilters(saved,{},['כל סוגי ההנעה'])).toEqual({manufacturer:'Maker',name:'Model A'});
  expect(accumulateCatalogFilters({}, {}, ['רכב חשמלי','כל סוגי ההנעה','אני בקבוצה ב׳'])).toEqual({});
  expect(accumulateCatalogFilters(saved,{},['כל היצרנים, לא משנה לי הדגם'])).toEqual({driveType:'חשמלי'});
});
it('takes the positively requested propulsion after an explicit correction', () => {
  expect(accumulateCatalogFilters({}, {}, ['לא חשמלי אלא היברידי'])).toEqual({driveType:'היברידי'});
});
