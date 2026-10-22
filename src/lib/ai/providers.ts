import 'server-only';
import { AI_LIMITS, CARWISE_SYSTEM, providerSettings, type ProviderName } from './config';
import { guardOutput, type AiContext } from './context';
import { geminiDiagnostic } from './gemini-diagnostics';
import { credentialSnapshot, geminiWireShape, geminiHeaderShape } from './request-diagnostics';

export class ProviderFailure extends Error {
  constructor(public retryable: boolean, public reason: string = 'unknown', public status?: number,
    public diagnostic?: ReturnType<typeof geminiDiagnostic>) { super('AI provider unavailable'); }
}
export class InvalidProviderOutput extends ProviderFailure {
  constructor(reason:'invalid_json'|'invalid_plan'|'invalid_plan_reference'|'invalid_plan_evidence'|'output_too_large',
    public fields:Array<'action'|'filters'|'operations'|'goal'|'root'> = [],public issueCodes:string[] = []) { super(true,reason,200); }
}
export type AiProvider = { name: ProviderName; model?: string; generate: (context: AiContext) => Promise<string> };
const transient = (status: number) => status === 408 || status === 429 || (status >= 500 && status <= 599 && status !== 501);
function httpFailure(status: number) {
  const reason = status === 401 ? 'authentication' : status === 403 ? 'permission_denied' : status === 404 ? 'model_or_endpoint_not_found'
    : status === 429 ? 'rate_limit' : status === 408 ? 'timeout' : status >= 500 ? 'provider_unavailable' : 'invalid_request';
  return new ProviderFailure(transient(status), reason, Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined);
}
function safeModel(model?: string) {
  if (!model || !/^[a-zA-Z0-9][a-zA-Z0-9/._:-]{0,100}$/.test(model)) return 'unspecified';
  if (['GEMINI_API_KEY', 'GROQ_API_KEY', 'OPENROUTER_API_KEY', 'SUPABASE_SECRET_KEY'].some(name => process.env[name]?.trim() && model.includes(process.env[name]!.trim()))) return 'redacted';
  return model;
}

async function gemini(key: string, model: string, context: AiContext, signal: AbortSignal, systemInstruction: string) {
  try {
    // Text chat must finish with the employee turn, never a model prefill.
    if (!context.length || context.at(-1)?.role !== 'user' || context.some(message =>
      !['user', 'assistant'].includes(message.role) || typeof message.content !== 'string' || !message.content.trim())) {
      throw new ProviderFailure(false, 'invalid_context');
    }
    const { GoogleGenAI } = await import('@google/genai');
    const client = new GoogleGenAI({ apiKey: key, httpOptions: { timeout: AI_LIMITS.geminiTimeoutMs, retryOptions: { attempts: 1 },
      fetch: async (url, options) => {
        // Inspect the serialized SDK request, not a guessed REST representation.
        let wire: unknown;
        try { wire = typeof options?.body === 'string' ? JSON.parse(options.body) : {}; } catch { wire = {}; }
        let backend = 'unknown';
        let apiVersion = 'unknown';
        let generateContentEndpoint = false;
        try {
          const target = new URL(String(url));
          backend = target.hostname === 'generativelanguage.googleapis.com' ? 'gemini_api' : 'other_backend';
          apiVersion = target.pathname.startsWith('/v1beta/') ? 'v1beta' : target.pathname.startsWith('/v1/') ? 'v1' : 'other';
          generateContentEndpoint = target.pathname.endsWith(':generateContent');
        } catch { /* No URL text is logged. */ }
        console.info('[carwise.ai.gemini.request]', { model: safeModel(model), modelMatchesProbe: model === 'gemini-3.5-flash-lite',
          backend, apiVersion, generateContentEndpoint, timeoutMs: AI_LIMITS.geminiTimeoutMs, ...credentialSnapshot(key, model), ...geminiWireShape(wire), ...geminiHeaderShape(options?.headers) });
        return fetch(url, options);
      }
    } });
    const result = await client.models.generateContent({ model,
      contents: context.map(message => ({ role: message.role === 'assistant' ? 'model' : 'user', parts: [{ text: message.content }] })),
      // Sampling parameters are deprecated for Gemini 3.5 Flash-Lite and later.
      config: { systemInstruction, maxOutputTokens: AI_LIMITS.maxOutputTokens, abortSignal: signal }
    });
    const reason = result.candidates?.[0]?.finishReason;
    // Token counts only (never text): shows whether prompt size or hidden reasoning dominates a slow reply.
    const tokens = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null;
    console.info('[carwise.ai.gemini.usage]', { promptTokens: tokens(result.usageMetadata?.promptTokenCount),
      thoughtsTokens: tokens(result.usageMetadata?.thoughtsTokenCount), outputTokens: tokens(result.usageMetadata?.candidatesTokenCount),
      finishReason: typeof reason === 'string' && /^[A-Z_]{1,40}$/.test(reason) ? reason : null });
    if (result.promptFeedback?.blockReason) throw new ProviderFailure(false,'safety_or_unsupported_output');
    if (reason === 'MAX_TOKENS') throw new ProviderFailure(true,'truncated_output',200);
    if (reason && reason !== 'STOP') throw new ProviderFailure(false, 'safety_or_unsupported_output');
    if (!result.text?.trim()) throw new ProviderFailure(true, 'empty_response');
    return result.text;
  } catch (error) {
    if (error instanceof ProviderFailure) throw error;
    const status = typeof error === 'object' && error !== null && 'status' in error ? Number(error.status) : 0;
    if (signal.aborted || (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name))) throw new ProviderFailure(true, 'timeout');
    if (status) {
      const failure = httpFailure(status);
      failure.diagnostic = geminiDiagnostic(error);
      throw failure;
    }
    // The Google SDK can wrap fetch failures in a plain Error. Never log its message.
    const network = error instanceof TypeError || (error instanceof Error && /^fetch failed\b/i.test(error.message));
    throw new ProviderFailure(network, network ? 'network' : 'sdk_or_configuration');
  }
}

async function compatible(name: 'groq' | 'openrouter', key: string, model: string, context: AiContext, signal: AbortSignal, systemInstruction: string) {
  const endpoint = name === 'groq' ? 'https://api.groq.com/openai/v1/chat/completions' : 'https://openrouter.ai/api/v1/chat/completions';
  let response: Response;
  try {
    response = await fetch(endpoint, { method: 'POST', signal, cache: 'no-store',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'system', content: systemInstruction }, ...context],
        max_tokens: AI_LIMITS.maxOutputTokens, temperature: 0.35,
        ...(name === 'groq' ? { reasoning_effort: 'low' } : { provider: { allow_fallbacks: false } }) })
    });
  } catch (error) {
    if (signal.aborted) throw new ProviderFailure(true, 'timeout');
    throw new ProviderFailure(error instanceof TypeError, error instanceof TypeError ? 'network' : 'internal_transport');
  }
  if (!response.ok) throw httpFailure(response.status);
  let data;
  try { data = await response.json(); } catch { throw new ProviderFailure(true, 'invalid_response'); }
  if (!data || typeof data !== 'object') throw new ProviderFailure(true, 'invalid_response');
  if (data.error) throw httpFailure(Number(data.error.code));
  const choice = data.choices?.[0];
  if (choice?.finish_reason === 'content_filter' || choice?.message?.tool_calls?.length) throw new ProviderFailure(false, 'safety_or_unsupported_output');
  if (choice?.finish_reason === 'length') throw new ProviderFailure(true,'truncated_output',200);
  if (!choice || typeof choice.message?.content !== 'string' || !choice.message.content.trim()) throw new ProviderFailure(true, 'empty_response');
  return choice.message.content;
}

function timed(generate: (signal: AbortSignal) => Promise<string>, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new ProviderFailure(true, 'timeout')); }, timeoutMs);
  });
  return Promise.race([generate(controller.signal), deadline]).finally(() => clearTimeout(timer));
}

export function configuredProviders(systemInstruction = CARWISE_SYSTEM): AiProvider[] {
  return providerSettings().flatMap(settings => settings.key ? [{ name: settings.name, model: settings.model,
    generate: (context: AiContext) => timed(signal => settings.name === 'gemini'
      ? gemini(settings.key!, settings.model, context, signal, systemInstruction)
      : compatible(settings.name, settings.key!, settings.model, context, signal, systemInstruction),
      settings.name === 'gemini' ? AI_LIMITS.geminiTimeoutMs : AI_LIMITS.providerTimeoutMs)
  }] : []);
}

export async function generateReply(context: AiContext, providers = configuredProviders(), validateOutput = guardOutput) {
  return generateValidatedReply(context,providers,text=>{
    const result=validateOutput(text);
    if (!result) throw new ProviderFailure(false);
    return result;
  });
}

/**
 * Failures that would repeat identically with every provider (our own context or validator) or that must not be
 * routed around (a safety refusal) stop the chain. A provider-specific failure (its key, model, request format,
 * SDK or quota) moves on to the next configured provider; the others have independent keys and APIs.
 */
const CHAIN_STOP = ['invalid_context', 'safety_or_unsupported_output', 'internal_error'];
export const continuesChain = (failure: ProviderFailure) => failure.retryable || !CHAIN_STOP.includes(failure.reason);

/** Success includes strict response validation, not just a successful HTTP response. */
export async function generateValidatedReply<T>(context:AiContext,providers:AiProvider[],validate:(text:string)=>T):Promise<T> {
  console.info('[carwise.ai.chain]',{providers:providers.map(provider=>provider.name),configuredCount:providers.length});
  let lastFailure:ProviderFailure|undefined;
  for (const [index,provider] of providers.entries()) {
    const started=Date.now();
    let phase:'generation'|'validation'='generation';
    try {
      const raw=await provider.generate(context);
      phase='validation';
      const result=validate(raw);
      console.info('[carwise.ai.provider.result]',{provider:provider.name,model:safeModel(provider.model),
        durationMs:Math.max(0,Date.now()-started),attempt:index+1,usedFallback:index>0,outcome:'validated'});
      return result;
    } catch (error) {
      const failure = error instanceof ProviderFailure ? error : new ProviderFailure(false, 'internal_error');
      lastFailure=failure;
      // Only controlled classifications are logged, never upstream bodies/messages/headers.
      const reasons = ['unknown', 'authentication', 'permission_denied', 'model_or_endpoint_not_found', 'rate_limit', 'timeout', 'provider_unavailable', 'invalid_request', 'invalid_context', 'safety_or_unsupported_output', 'empty_response', 'network', 'sdk_or_configuration', 'internal_transport', 'invalid_response', 'internal_error','invalid_json','invalid_plan','invalid_plan_reference','invalid_plan_evidence','truncated_output','output_too_large'];
      console.warn('[carwise.ai.provider]', { provider: provider.name, model: safeModel(provider.model),
        status: failure.status, reason: reasons.includes(failure.reason) ? failure.reason : 'unknown', fallbackAllowed: continuesChain(failure),
        durationMs:Math.max(0,Date.now()-started),attempt:index+1,phase,fallbackUsed:continuesChain(failure)&&index+1<providers.length,
        ...(failure instanceof InvalidProviderOutput?{fields:failure.fields,issueCodes:failure.issueCodes}:{}),
        ...(failure.diagnostic ? { googleStatus: failure.diagnostic.googleStatus, detail: failure.diagnostic.detail,
          envelopeShape: failure.diagnostic.envelopeShape, ...(failure.diagnostic.fields ? { fields: failure.diagnostic.fields, fieldCodes: failure.diagnostic.fieldCodes } : {}) } : {}) });
      if (!continuesChain(failure)) throw failure;
    }
  }
  throw lastFailure??new ProviderFailure(true,'provider_unavailable');
}
