// Manual diagnostic only. Without --live-one there is NO network or .env access.
// --live-one authorizes at most ONE POST for the explicitly selected stage.
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const Module = require('node:module');
const { parseEnv } = require('node:util');
const endpoint = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent';
const names = ['sdk-minimal', 'output-limit', 'sdk-simple-system', 'sdk-carwise-system', 'sdk-history', 'sdk-consecutive-users', 'rest-system-no-role', 'sdk-leading-model', 'sdk-chat-timeout'];
const normalizeStage = name => name === 'sdk-limit' ? 'output-limit' : name;
class LocalFailure extends Error {
  constructor(phase, detail) { super('Local diagnostic failure'); this.phase = phase; this.detail = detail; }
}
function parseArgs(args) {
  if (args[0] !== '--stage' || !names.includes(normalizeStage(args[1])) || args.length < 2 || args.length > 3 || (args[2] && args[2] !== '--live-one')) {
    throw new LocalFailure('arguments', 'invalid_stage_or_arguments');
  }
  return { name: normalizeStage(args[1]), live: args[2] === '--live-one' };
}

// Read only these standalone helpers; no chat, auth, repositories or Supabase.
function loadHelper(name) {
  const ts = require('typescript');
  const filename = path.resolve(__dirname, '../src/lib/ai', name + '.ts');
  const source = fs.readFileSync(filename, 'utf8').replace(/^import 'server-only';\s*/m, '');
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const local = new Module(filename, module);
  local.filename = filename; local.paths = module.paths;
  local._compile(output, filename);
  return local.exports;
}

function stageRequest(name, settings) {
  name = normalizeStage(name);
  if (!names.includes(name)) throw new Error('Unknown stage');
  const user = text => ({ role: 'user', parts: [{ text }] });
  const model = text => ({ role: 'model', parts: [{ text }] });
  const config = { maxOutputTokens: name === 'sdk-minimal' ? 32 : name === 'output-limit' ? 700 : settings.AI_LIMITS.maxOutputTokens };
  if (name === 'sdk-simple-system') config.systemInstruction = 'You are a helpful assistant. Reply briefly.';
  if (['sdk-carwise-system', 'sdk-history', 'sdk-consecutive-users', 'rest-system-no-role', 'sdk-leading-model', 'sdk-chat-timeout'].includes(name)) config.systemInstruction = settings.CARWISE_SYSTEM;
  let contents = [user('Reply only OK.')];
  if (name === 'sdk-history') contents = [user('Hello.'), model('Hello. How can I help?'), user('Reply only OK.')];
  if (name === 'sdk-consecutive-users') contents = [user('Hello.'), model('Hello. How can I help?'), user('Fictional service note: no personal data.'), user('Reply only OK.')];
  if (name === 'sdk-leading-model') contents = [model('Hello. How can I help?'), user('Reply only OK.')];
  return { model: 'gemini-3.5-flash-lite', contents, config };
}

// Native https performs no automatic redirects or request retries.
function sendOnce(url, options) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let httpStatus = null;
    let timer;
    const onAbort = () => { const error = new Error('Diagnostic aborted'); error.code = 'DIAGNOSTIC_TIMEOUT'; finish(error); request.destroy(); };
    const finish = (error, response) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      if (error) { error.httpStatus = httpStatus; reject(error); } else resolve(response);
    };
    const headers = Object.fromEntries(new Headers(options.headers).entries());
    headers['content-length'] = String(Buffer.byteLength(options.body));
    const request = https.request(url, { method: 'POST', headers }, response => {
      httpStatus = response.statusCode ?? null;
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        if (settled) return;
        if (body.length + chunk.length > 262144) {
          finish(new Error('Response limit')); response.destroy();
        } else body += chunk;
      });
      response.on('end', () => {
        try { finish(null, new Response([204, 205, 304].includes(response.statusCode) ? null : body, {
          status: response.statusCode,
          headers: { 'content-type': response.headers['content-type'] || 'application/json' }
        })); } catch { finish(new Error('Invalid response')); }
      });
      response.on('error', error => finish(error));
    });
    request.on('error', error => finish(error));
    if (options.signal?.aborted) { onAbort(); return; }
    options.signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => { const error = new Error('Diagnostic timeout'); error.code = 'DIAGNOSTIC_TIMEOUT'; finish(error); request.destroy(); }, 10000);
    request.end(options.body);
  });
}

async function runStage(name, settings, diagnostic, { key = 'offline-placeholder', send, GoogleGenAI }) {
  name = normalizeStage(name);
  let attempts = 0;
  let httpStatus = null;
  let shape;
  let transportProblem;
  let phase = 'build_request';
  const transport = async (url, options) => {
    // A second SDK attempt or a different endpoint is rejected BEFORE transport.
    if (attempts !== 0 || String(url) !== endpoint || options.method !== 'POST') throw new Error('Request guard');
    attempts++;
    const body = JSON.parse(options.body);
    shape = { fields: Object.keys(body).sort(), roles: body.contents.map(item => item.role),
      generationFields: Object.keys(body.generationConfig || {}).sort(),
      maxOutputTokens: body.generationConfig?.maxOutputTokens,
      systemRole: body.systemInstruction?.role || null };
    // In dry-run mode the SDK response is mocked; credentials are never loaded.
    phase = 'network';
    let response;
    try {
      response = send ? await send(url, options) : new Response(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'OK' }] }, finishReason: 'STOP' }] }), { headers: { 'content-type': 'application/json' } });
    } catch (error) {
      if (Number.isInteger(error?.httpStatus) && error.httpStatus >= 100 && error.httpStatus <= 599) httpStatus = error.httpStatus;
      if (httpStatus !== null) phase = 'response';
      transportProblem = ({ DIAGNOSTIC_TIMEOUT: 'timeout', ETIMEDOUT: 'timeout', ENOTFOUND: 'dns_failure', EAI_AGAIN: 'dns_failure', ECONNRESET: 'connection_reset', ECONNREFUSED: 'connection_refused' })[error?.code];
      if (typeof transportProblem !== 'string') transportProblem = httpStatus === null ? 'network_error' : 'response_transport_failure';
      throw error;
    }
    httpStatus = response.status;
    phase = 'response';
    return response;
  };
  let result;
  try {
    const input = stageRequest(name, settings);
    if (name === 'rest-system-no-role') {
      const body = { contents: input.contents, generationConfig: { maxOutputTokens: input.config.maxOutputTokens },
        systemInstruction: { parts: [{ text: input.config.systemInstruction }] } };
      const response = await transport(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body) });
      const data = await response.json();
      if (!response.ok) throw { status: response.status, message: JSON.stringify(data) };
      result = data;
    } else {
      const timeout = name === 'sdk-chat-timeout' ? 7000 : 10000;
      const client = new GoogleGenAI({ apiKey: key, vertexai: false, httpOptions: { timeout, retryOptions: { attempts: 1 }, fetch: transport } });
      result = await client.models.generateContent({ ...input, config: { ...input.config, abortSignal: AbortSignal.timeout(timeout) } });
    }
    const hasReplyContent = Array.isArray(result?.candidates) && result.candidates.some(item => item.content?.parts?.some(part => typeof part.text === 'string' && part.text.trim()));
    return { stage: name, phase: 'complete', liveRequests: send ? attempts : 0, httpStatus, googleCode: null, diagnostic: send ? 'accepted' : 'offline_serialization_only', hasReplyContent, shape };
  } catch (error) {
    return { stage: name, phase: httpStatus >= 400 && !transportProblem ? 'google_http' : phase, liveRequests: send ? attempts : 0, httpStatus, googleCode: Number.isInteger(error?.status) && error.status >= 100 && error.status <= 599 ? error.status : null,
      ...diagnostic(error), diagnostic: transportProblem || (httpStatus >= 400 ? 'provider_rejected' : httpStatus >= 300 ? 'redirect_refused' : httpStatus !== null ? 'response_processing_failure' : 'local_script_error'), shape };
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.length || (args.length === 1 && args[0] === '--list')) {
    console.log(JSON.stringify({ liveRequests: 0, stages: names, usage: 'node scripts/diagnose-gemini-stages.cjs --stage <stage> [--live-one]' }, null, 2));
    return;
  }
  const { name, live } = parseArgs(args);
  let key;
  if (live) {
    try { key = parseEnv(fs.readFileSync(path.resolve(__dirname, '../.env.local'), 'utf8')).GEMINI_API_KEY?.trim(); }
    catch { throw new LocalFailure('environment', 'environment_load_failed'); }
    if (!key) throw new LocalFailure('environment', 'missing_key');
  }
  const settings = loadHelper('config');
  const { geminiDiagnostic } = loadHelper('gemini-diagnostics');
  const { GoogleGenAI } = require('@google/genai');
  const credential = live ? loadHelper('request-diagnostics').credentialSnapshot(key) : undefined;
  const result = await runStage(name, settings, geminiDiagnostic, { key, send: live ? sendOnce : undefined, GoogleGenAI });
  if (live) result.credential = credential;
  console.log(JSON.stringify(result, null, 2));
  if (!['accepted', 'offline_serialization_only'].includes(result.diagnostic)) process.exitCode = 1;
}

module.exports = { names, stageRequest, runStage, parseArgs, sendOnce, loadHelper };
if (require.main === module) main().catch(error => {
  console.log(JSON.stringify({ diagnostic: 'local_script_error', phase: error instanceof LocalFailure ? error.phase : 'initialization',
    detail: error instanceof LocalFailure ? error.detail : 'helper_or_sdk_load_failed', httpStatus: null, liveRequests: 0 }));
  process.exitCode = 1;
});
