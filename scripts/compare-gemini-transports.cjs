// PREPARED ONLY. --approved-two-requests requires separate explicit owner approval.
// No flag: no network, no environment reads. No business code or Supabase writes.
const fs = require('node:fs');
const path = require('node:path');
const { parseEnv } = require('node:util');
const { runStage, sendOnce, loadHelper } = require('./diagnose-gemini-stages.cjs');
const endpoint = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent';
const timeoutMs = 7000;

function nextRouteFetch(originFetch) {
  // Use this project's installed Next.js patch, not bare Node fetch mislabeled
  // as Next.js. Context is synthetic/dynamic, not a running authenticated route.
  const { createPatchedFetcher } = require('next/dist/server/lib/patch-fetch');
  const workStore = { route: '/diagnostic', forceDynamic: true, isStaticGeneration: false, isDraftMode: false, shouldTrackFetchMetrics: false };
  const requestStore = { type: 'request', phase: 'action' };
  return createPatchedFetcher(originFetch, {
    workAsyncStorage: { getStore: () => workStore },
    workUnitAsyncStorage: { getStore: () => requestStore }
  });
}

async function prepareRequest(key, settings, diagnostic, GoogleGenAI) {
  let prepared;
  let captures = 0;
  const result = await runStage('sdk-chat-timeout', settings, diagnostic, {
    key, GoogleGenAI,
    send: async (url, options) => {
      if (++captures !== 1 || String(url) !== endpoint || options.method !== 'POST') throw new Error('Preparation guard');
      const headers = new Headers(options.headers);
      headers.set('content-length', String(Buffer.byteLength(options.body)));
      prepared = { url: endpoint, method: 'POST', headers: [...headers.entries()], body: options.body };
      return new Response(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'OK' }] }, finishReason: 'STOP' }] }), { headers: { 'content-type': 'application/json' } });
    }
  });
  if (!prepared || captures !== 1 || result.diagnostic !== 'accepted') throw new Error('Preparation failed');
  return prepared;
}

async function readBounded(response) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 262144) { await reader.cancel(); throw new Error('Response limit'); }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function compare(prepared, { originFetch, httpsSend = sendOnce, diagnostic }) {
  if (prepared.url !== endpoint || prepared.method !== 'POST') throw new Error('Endpoint guard');
  const results = [];
  let totalAttempts = 0;
  // Boundaries are guarded beneath the Next patch as well, so it cannot turn
  // one logical call into multiple physical requests to the origin.
  for (const mode of ['next-fetch', 'https-adapter']) {
    let attempts = 0;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let status = null;
    let inOrigin = false;
    let redirect = false;
    const guarded = async (url, options) => {
      if (attempts || totalAttempts >= 2 || String(url) !== endpoint || options.method !== 'POST') throw new Error('Transport guard');
      attempts++; totalAttempts++; inOrigin = true;
      const response = await (mode === 'next-fetch' ? originFetch : httpsSend)(url, options);
      status = response.status;
      return response;
    };
    try {
      const transport = mode === 'next-fetch' ? nextRouteFetch(guarded) : guarded;
      const response = await transport(prepared.url, {
        method: prepared.method, headers: new Headers(prepared.headers), body: prepared.body,
        signal: controller.signal, redirect: 'manual'
      });
      status = response.status;
      redirect = status >= 300 && status < 400;
      if (redirect) { await response.body?.cancel(); results.push({ transport: mode, httpStatus: status, diagnostic: 'redirect_refused' }); continue; }
      const raw = await readBounded(response);
      let data;
      try { data = JSON.parse(raw); } catch { results.push({ transport: mode, httpStatus: status, diagnostic: 'non_json_response' }); continue; }
      if (response.ok) results.push({ transport: mode, httpStatus: status, diagnostic: 'accepted' });
      else {
        const safe = diagnostic({ message: JSON.stringify(data) });
        results.push({ transport: mode, httpStatus: status, googleStatus: safe.googleStatus, diagnostic: safe.detail,
          ...(safe.fieldCodes ? { fieldCodes: safe.fieldCodes } : {}) });
      }
    } catch (error) {
      if (status === null && Number.isInteger(error?.httpStatus) && error.httpStatus >= 100 && error.httpStatus <= 599) status = error.httpStatus;
      results.push({ transport: mode, httpStatus: status,
        diagnostic: controller.signal.aborted ? 'timeout' : !inOrigin ? 'local_preparation_failure' : status !== null ? 'response_processing_failure' : 'network_error' });
    } finally { clearTimeout(timer); }
  }
  return results;
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.length) {
    console.log(JSON.stringify({ httpStatus: null, diagnostic: 'not_run_requires_separate_approval_for_up_to_two_requests' }));
    return;
  }
  if (args.length !== 1 || args[0] !== '--approved-two-requests') throw new Error('Approval flag required');
  const key = parseEnv(fs.readFileSync(path.resolve(__dirname, '../.env.local'), 'utf8')).GEMINI_API_KEY?.trim();
  if (!key) throw new Error('Missing key');
  const settings = loadHelper('config');
  const { geminiDiagnostic } = loadHelper('gemini-diagnostics');
  const { GoogleGenAI } = require('@google/genai');
  // Exactly one in-memory SDK serialization, using a fake HTTP response.
  // Both live transports receive copies of that single captured request.
  const prepared = await prepareRequest(key, settings, geminiDiagnostic, GoogleGenAI);
  const results = await compare(prepared, { originFetch: globalThis.fetch.bind(globalThis), diagnostic: geminiDiagnostic });
  console.log(JSON.stringify(results, null, 2));
  if (results.some(result => result.diagnostic !== 'accepted')) process.exitCode = 1;
}

module.exports = { nextRouteFetch, prepareRequest, compare };
if (require.main === module) main().catch(() => {
  console.log(JSON.stringify({ httpStatus: null, diagnostic: 'local_failure_no_raw_error' }));
  process.exitCode = 1;
});
