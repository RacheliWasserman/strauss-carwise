import {beforeEach,expect,it,vi} from 'vitest';
vi.mock('server-only',()=>({}));
const mocks=vi.hoisted(()=>({from:vi.fn()}));
vi.mock('../src/lib/supabase-server',()=>({createSupabaseServerClient:async()=>({from:mocks.from})}));
import {listAdvisorOccupations} from '../src/lib/occupation-repository';
const row={title:'מפתח/ת תוכנה',group_code:'ב',car_mandatory:false,waiver_allowed:true,waiver_maintenance_amount:1234};
function query(data:unknown,error:unknown=null) {
  const result={select:vi.fn(),order:vi.fn(),limit:vi.fn()};
  result.select.mockReturnValue(result);result.order.mockReturnValue(result);result.limit.mockResolvedValue({data,error});
  mocks.from.mockReturnValue(result);return result;
}
beforeEach(()=>vi.resetAllMocks());
it('reads only occupations using the session client and known columns, never demo employees',async()=>{
  const q=query([row]);const result=await listAdvisorOccupations();
  expect(mocks.from).toHaveBeenCalledExactlyOnceWith('occupations');
  expect(q.select).toHaveBeenCalledWith('title, group_code, car_mandatory, waiver_allowed, waiver_maintenance_amount');
  expect(result[0]).toMatchObject(row);expect(result[0].key).toMatch(/^[a-f0-9]{64}$/);
  expect(q.limit).toHaveBeenCalledWith(201);
});
it('accepts valid database numeric amounts without converting missing or blank values to zero',async()=>{
  query([{...row,waiver_maintenance_amount:'1234.50'}]);expect((await listAdvisorOccupations())[0].waiver_maintenance_amount).toBe(1234.5);
});
it.each([null,'',-1,'not-a-number'])('rejects an invalid/missing allowance: %s',async value=>{
  query([{...row,waiver_maintenance_amount:value}]);await expect(listAdvisorOccupations()).rejects.toThrow();
});
it('does not turn permission failures into a privileged fallback',async()=>{
  query(null,{code:'42501',message:'private error'});
  await expect(listAdvisorOccupations()).rejects.toThrow('Occupation catalog unavailable');
  expect(mocks.from).toHaveBeenCalledTimes(1);
});
it('returns no matches for an RLS-hidden or empty list without inventing occupations',async()=>{
  query([]);expect(await listAdvisorOccupations()).toEqual([]);
});
it('rejects duplicated titles and truncated lists instead of claiming a safe unique match',async()=>{
  query([row,{...row,group_code:'ג'}]);await expect(listAdvisorOccupations()).rejects.toThrow();
  query(Array.from({length:201},(_,i)=>({...row,title:'Fixture '+i})));await expect(listAdvisorOccupations()).rejects.toThrow();
});
it('rejects invalid group and permission-like fields rather than inventing defaults',async()=>{
  query([{...row,group_code:'unknown'}]);await expect(listAdvisorOccupations()).rejects.toThrow();
  query([{...row,waiver_allowed:null}]);await expect(listAdvisorOccupations()).rejects.toThrow();
});
