import 'server-only';

// The SDK stores Google's JSON error envelope in Error.message. Inspect it in
// memory, but return only fixed classifications: never return upstream text.
export function geminiDiagnostic(error: unknown) {
  const record = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const statuses = ['INVALID_ARGUMENT', 'FAILED_PRECONDITION', 'NOT_FOUND', 'PERMISSION_DENIED', 'UNAUTHENTICATED', 'RESOURCE_EXHAUSTED', 'UNAVAILABLE', 'DEADLINE_EXCEEDED', 'INTERNAL'];
  // Bounded unwrapping covers ApiError.message JSON, prefixed SDK messages and
  // response/data/cause wrappers. No wrapper, field value or message is logged.
  const queue: Array<{ value: unknown; depth: number }> = [{ value: error, depth: 0 }];
  const seen = new Set<unknown>();
  const messages: string[] = [];
  let envelope: Record<string, unknown> = {};
  let envelopeShape = 'not_recognized';
  for (let count = 0; queue.length && count < 32; count++) {
    const { value, depth } = queue.shift()!;
    if (depth > 6 || seen.has(value)) continue;
    seen.add(value);
    if (typeof value === 'string') {
      if (value.length > 65536) continue;
      messages.push(value);
      const start = value.indexOf('{');
      try { queue.push({ value: JSON.parse(value), depth: depth + 1 }); }
      catch {
        if (start >= 0) try { queue.push({ value: JSON.parse(value.slice(start)), depth: depth + 1 }); } catch { /* Unstructured text. */ }
      }
      continue;
    }
    const item = record(value);
    if (typeof item.status === 'string' && statuses.includes(item.status)) {
      envelope = item;
      envelopeShape = depth <= 3 ? 'google_error' : 'nested_google_error';
      break;
    }
    for (const key of ['error', 'message', 'response', 'data', 'cause']) {
      if (item[key] !== undefined) queue.push({ value: item[key], depth: depth + 1 });
    }
  }
  const googleStatus = typeof envelope.status === 'string' && statuses.includes(envelope.status) ? envelope.status : 'unknown';
  let message = typeof envelope.message === 'string' ? envelope.message.slice(0, 65536) : messages.join(' ').slice(0, 65536);
  if (Array.isArray(envelope.details)) for (const entry of envelope.details.slice(0, 20)) {
    const violations = record(entry).fieldViolations;
    if (Array.isArray(violations)) for (const violation of violations.slice(0, 20)) {
      const description = record(violation).description;
      if (typeof description === 'string' && message.length < 65536) message += '\n' + description.slice(0, 65536 - message.length);
    }
  }
  const reasons = Array.isArray(envelope.details) ? envelope.details.slice(0, 20).map(detail => record(detail).reason) : [];
  const fieldGroups = new Set<string>();
  const fieldCodes = new Set<string>();
  if (Array.isArray(envelope.details)) for (const entry of envelope.details.slice(0, 20)) {
    const violations = record(entry).fieldViolations;
    if (!Array.isArray(violations)) continue;
    for (const violation of violations.slice(0, 20)) {
      const field = record(violation).field;
      // Only emit a fixed field group, never an arbitrary server-provided path.
      const group = typeof field === 'string' ? field.split(/[.\[]/, 1)[0].replace(/_/g, '').toLowerCase() : '';
      const known = ({ contents: 'contents', model: 'model', generationconfig: 'generationConfig', systeminstruction: 'systemInstruction', tools: 'tools', toolconfig: 'toolConfig', safetysettings: 'safetySettings' } as Record<string, unknown>)[group];
      fieldGroups.add(typeof known === 'string' ? known : 'other');
      const normalized = typeof field === 'string' ? field.replace(/\[\d+\]/g, '[]').replace(/_/g, '').toLowerCase() : '';
      const knownPaths = new Map([
        ['generationconfig.maxoutputtokens', 'generationConfig.maxOutputTokens'],
        ['generationconfig.temperature', 'generationConfig.temperature'],
        ['contents[].role', 'contents.role'], ['contents[].parts[].text', 'contents.parts.text'],
        ['systeminstruction.parts[].text', 'systemInstruction.parts.text']
      ]);
      fieldCodes.add(knownPaths.get(normalized) ?? 'other');
    }
  }
  let detail = 'unclassified';
  if (/deadline[^\n]*(?:too short|minimum allowed)|minimum[^\n]*(?:deadline|timeout)/i.test(message)) detail = 'deadline_too_short';
  else if (reasons.includes('API_KEY_INVALID') || /API key not valid|API_KEY_INVALID/i.test(message)) detail = 'api_key_invalid';
  else if (/API key.*(?:expired|blocked|leaked)|API_KEY_(?:EXPIRED|BLOCKED)/i.test(message)) detail = 'api_key_restricted';
  else if (/Requests ending with a model turn|last.*turn.*(?:must be user|model.*not supported)/i.test(message)) detail = 'final_model_turn';
  else if (/(?:temperature|top_p|top_k).*(?:not supported|unsupported|deprecated|not allowed)/i.test(message)) detail = 'unsupported_sampling_parameter';
  else if (/roles?.*(?:user.*model|not supported|invalid)|(?:invalid|unsupported).*role/i.test(message)) detail = 'invalid_role';
  else if (/contents.*(?:not specified|empty|required)/i.test(message)) detail = 'missing_contents';
  else if (/model.*(?:not found|not supported|unsupported|not available)|(?:unsupported|unknown|invalid) model|not supported for generateContent/i.test(message)) detail = 'model_unavailable';
  else if (/billing|free tier|location.*not supported|country.*not supported/i.test(message)) detail = 'billing_or_region';
  else if (/Unknown name|Invalid JSON payload/i.test(message)) detail = 'invalid_payload_field';
  else if (/too many states|response_?schema|response_?json_?schema|schema.*(?:not supported|unsupported|invalid|complex)/i.test(message)) detail = 'response_schema';
  else if (fieldGroups.size) detail = 'invalid_field';
  return { googleStatus, detail, envelopeShape, ...(fieldGroups.size ? { fields: [...fieldGroups].sort(), fieldCodes: [...fieldCodes].sort() } : {}) };
}
