import 'server-only';
import {z} from 'zod';
import {InvalidProviderOutput} from './providers';

/**
 * JSON null for a field means "no value", exactly like omitting it. Models often write null for optional fields;
 * treating it as absent keeps the schema strict (unknown keys and wrong types are still rejected, and a
 * required field set to null is still missing).
 */
function withoutNulls(value:unknown):unknown {
  if (Array.isArray(value)) return value.map(withoutNulls);
  if (value&&typeof value==='object') return Object.fromEntries(Object.entries(value).filter(([,item])=>item!==null).map(([key,item])=>[key,withoutNulls(item)]));
  return value;
}

export function parseStructuredOutput<T>(raw:string,schema:z.ZodType<T>):T {
  if (raw.length>6000) throw new InvalidProviderOutput('output_too_large');
  const text=raw.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/,'$1');
  let value:unknown;
  try {value=JSON.parse(text);} catch {throw new InvalidProviderOutput('invalid_json');}
  const result=schema.safeParse(withoutNulls(value));
  if (!result.success) {
    // Only known schema field names, never issue messages, values or unknown keys.
    const allowed=['action','filters','operations','goal','root'] as const;
    const fields=result.error.issues.map(issue=>allowed.find(key=>key===issue.path[0])??'root');
    const codes=['invalid_type','invalid_value','unrecognized_keys','too_big','too_small','invalid_format','custom'];
    const issueCodes=result.error.issues.map(issue=>codes.includes(issue.code)?issue.code:'validation');
    throw new InvalidProviderOutput('invalid_plan',[...new Set(fields)],[...new Set(issueCodes)]);
  }
  return result.data;
}
