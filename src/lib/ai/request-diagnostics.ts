import 'server-only';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';

export function keyFingerprint(key?: string) {
  return key?.trim() ? createHash('sha256').update('carwise-gemini-key-v1\0').update(key.trim()).digest('hex').slice(0, 24) : null;
}

export function credentialSnapshot(key?: string, model = 'gemini-3.5-flash-lite',
  readLocal: () => Record<string, string | undefined> = () => parseEnv(readFileSync(resolve(process.cwd(), '.env.local'), 'utf8'))) {
  let localKey: string | undefined;
  let localModel: string | undefined;
  let fileReadable = false;
  try {
    const local = readLocal();
    localKey = local.GEMINI_API_KEY?.trim(); localModel = local.GEMINI_MODEL?.trim();
    fileReadable = true;
  } catch { /* Deployed servers need not have a local environment file. */ }
  const fingerprint = keyFingerprint(key);
  const localFingerprint = keyFingerprint(localKey);
  return { keyPresent: Boolean(key?.trim()), keyFingerprint: fingerprint,
    envLocalReadable: fileReadable, envLocalKeyPresent: Boolean(localKey), envLocalKeyFingerprint: localFingerprint,
    runtimeKeyMatchesEnvLocal: fingerprint && localFingerprint ? fingerprint === localFingerprint : null,
    envLocalModelOverridePresent: Boolean(localModel),
    runtimeModelMatchesEnvLocal: fileReadable ? model === (localModel || 'gemini-3.5-flash-lite') : null };
}

export function geminiWireShape(body: unknown) {
  const data = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const contents = Array.isArray(data.contents) ? data.contents : [];
  const roles: string[] = [];
  const lengths: number[] = [];
  let invalidParts = 0;
  let illFormedMessageCount = 0;
  let controlCharCount = 0;
  let replacementCharCount = 0;
  let bidiControlCount = 0;
  for (const item of contents) {
    roles.push(item?.role === 'user' || item?.role === 'model' ? item.role : 'unknown');
    const parts = Array.isArray(item?.parts) ? item.parts : [];
    if (!parts.length) invalidParts++;
    let length = 0;
    let illFormed = false;
    for (const part of parts) {
      if (typeof part?.text !== 'string') invalidParts++;
      else {
        length += part.text.length; if (/[\uD800-\uDFFF]/u.test(part.text)) illFormed = true;
        controlCharCount += (part.text.match(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g) || []).length;
        replacementCharCount += (part.text.match(/\uFFFD/g) || []).length;
        bidiControlCount += (part.text.match(/[\u202A-\u202E\u2066-\u2069]/g) || []).length;
      }
    }
    lengths.push(length);
    if (illFormed) illFormedMessageCount++;
  }
  const config = (data.generationConfig || {}) as Record<string, unknown>;
  const system = data.systemInstruction as { parts?: Array<{ text?: string }> } | undefined;
  const knownFields = new Set(['contents', 'systemInstruction', 'generationConfig', 'tools', 'toolConfig', 'safetySettings', 'cachedContent']);
  const knownConfig = new Set(['maxOutputTokens', 'temperature', 'topP', 'topK', 'thinkingConfig', 'responseMimeType', 'responseSchema']);
  return { fields: Object.keys(data).map(field => knownFields.has(field) ? field : 'other').sort(),
    messageCount: contents.length, roles, contentLengths: lengths, totalContentChars: lengths.reduce((a, b) => a + b, 0),
    emptyMessageCount: lengths.filter(length => !length).length, invalidParts, illFormedMessageCount,
    controlCharCount, replacementCharCount, bidiControlCount,
    adjacentSameRoleCount: roles.filter((role, index) => index > 0 && role === roles[index - 1]).length,
    systemInstructionChars: Array.isArray(system?.parts) ? system.parts.reduce((total, part) => total + (typeof part?.text === 'string' ? part.text.length : 0), 0) : 0,
    generationFields: Object.keys(config).map(field => knownConfig.has(field) ? field : 'other').sort(),
    maxOutputTokens: typeof config.maxOutputTokens === 'number' && Number.isFinite(config.maxOutputTokens) ? config.maxOutputTokens : null };
}

export function geminiHeaderShape(input?: HeadersInit) {
  const headers = new Headers(input);
  const timeout = headers.get('x-server-timeout');
  const seconds = timeout && /^\d+(\.\d+)?$/.test(timeout) ? Number(timeout) : null;
  const version = (headers.get('x-goog-api-client') || headers.get('user-agent') || '').match(/google-genai-sdk\/(\d+\.\d+\.\d+)/)?.[1] ?? null;
  return { serverTimeoutSeconds: seconds !== null && seconds > 0 && seconds <= 600 ? seconds : null,
    contentTypeIsJson: headers.get('content-type')?.split(';')[0].trim().toLowerCase() === 'application/json',
    sdkVersion: version, apiKeyHeaderPresent: headers.has('x-goog-api-key'), authorizationHeaderPresent: headers.has('authorization') };
}
