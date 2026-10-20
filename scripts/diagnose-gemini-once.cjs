// MANUAL LIVE TEST: running this file makes at most ONE potentially paid request.
// No SDK retries, redirects, fallback, Supabase access or business-code imports.
// Requires Node.js 22+; loads only GEMINI_API_KEY from the project's .env.local.
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { parseEnv } = require('node:util');

const googleStatuses = new Set([
  'INVALID_ARGUMENT', 'FAILED_PRECONDITION', 'NOT_FOUND', 'PERMISSION_DENIED',
  'UNAUTHENTICATED', 'RESOURCE_EXHAUSTED', 'UNAVAILABLE', 'DEADLINE_EXCEEDED', 'INTERNAL'
]);

function filteredDiagnostic(body) {
  const error = body?.error;
  const message = typeof error?.message === 'string' ? error.message.slice(0, 65536) : '';
  const details = Array.isArray(error?.details) ? error.details.slice(0, 20) : [];
  const reasons = details.map(item => item?.reason);
  let reason = 'unclassified';
  if (reasons.includes('API_KEY_INVALID') || /API key not valid|API_KEY_INVALID/i.test(message)) reason = 'api_key_invalid';
  else if (/API key.*(?:expired|blocked|leaked)|API_KEY_(?:EXPIRED|BLOCKED)/i.test(message)) reason = 'api_key_restricted';
  else if (/model.*(?:not found|not supported|unsupported|not available)|(?:unsupported|unknown|invalid) model|not supported for generateContent/i.test(message)) reason = 'model_unavailable';
  else if (/billing|free tier|location.*not supported|country.*not supported/i.test(message)) reason = 'billing_or_region';
  else if (/Unknown name|Invalid JSON payload/i.test(message)) reason = 'invalid_payload_field';
  else if (/quota|rate limit|resource exhausted/i.test(message)) reason = 'quota_or_rate_limit';

  const knownFields = new Map([
    ['model', 'model'], ['contents', 'contents'], ['generationconfig', 'generationConfig'],
    ['systeminstruction', 'systemInstruction'], ['safetysettings', 'safetySettings']
  ]);
  const fields = new Set();
  for (const detail of details) {
    if (!Array.isArray(detail?.fieldViolations)) continue;
    for (const violation of detail.fieldViolations.slice(0, 20)) {
      const group = typeof violation?.field === 'string'
        ? violation.field.split(/[.\[]/, 1)[0].replace(/_/g, '').toLowerCase() : '';
      fields.add(knownFields.get(group) ?? 'other');
    }
  }
  if (reason === 'unclassified' && fields.size) reason = 'invalid_field';
  return {
    googleCode: Number.isInteger(error?.code) && error.code >= 100 && error.code <= 599 ? error.code : null,
    googleStatus: googleStatuses.has(error?.status) ? error.status : 'unknown',
    diagnostic: reason,
    ...(fields.size ? { fields: [...fields].sort() } : {})
  };
}

async function main() {
  if (typeof parseEnv !== 'function') throw new Error('Unsupported Node.js');
  // Never print environment contents or inherit a different key from the shell.
  const env = parseEnv(fs.readFileSync(path.resolve(__dirname, '../.env.local'), 'utf8'));
  const key = env.GEMINI_API_KEY?.trim();
  if (!key) {
    console.log(JSON.stringify({ httpStatus: null, googleCode: null, diagnostic: 'missing_key_no_request' }));
    process.exitCode = 1;
    return;
  }
  const payload = JSON.stringify({
    contents: [{ role: 'user', parts: [{ text: 'Reply only OK.' }] }],
    generationConfig: { maxOutputTokens: 32 }
  });
  await new Promise(resolve => {
    let done = false;
    let httpStatus = null;
    let timer;
    const finish = (result, success = false) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      process.exitCode = success ? 0 : 1;
      console.log(JSON.stringify(result, null, 2));
      resolve();
    };
    // Native https does not follow redirects. This is the only request call.
    const request = https.request(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent',
      { method: 'POST', headers: {
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload),
        'x-goog-api-key': key
      } },
      response => {
        httpStatus = response.statusCode ?? null;
        let buffer = '';
        response.setEncoding('utf8');
        response.on('data', chunk => {
          if (done) return;
          if (buffer.length + chunk.length > 262144) {
            finish({ httpStatus, googleCode: null, diagnostic: 'response_too_large' });
            response.destroy();
          } else buffer += chunk;
        });
        response.on('end', () => {
          if (done) return;
          if (httpStatus >= 300 && httpStatus < 400) {
            finish({ httpStatus, googleCode: null, diagnostic: 'redirect_refused' });
            return;
          }
          let body;
          try { body = JSON.parse(buffer); } catch {
            finish({ httpStatus, googleCode: null, diagnostic: 'non_json_response' });
            return;
          }
          if (httpStatus >= 200 && httpStatus < 300) {
            const hasReplyContent = Array.isArray(body?.candidates) && body.candidates.some(candidate =>
              Array.isArray(candidate?.content?.parts) && candidate.content.parts.some(part => typeof part?.text === 'string' && part.text.trim()));
            finish({ httpStatus, googleCode: null, diagnostic: 'accepted', hasReplyContent }, true);
          } else finish({ httpStatus, ...filteredDiagnostic(body) });
        });
        response.on('error', () => finish({ httpStatus, googleCode: null, diagnostic: 'response_transport_error' }));
      }
    );
    request.on('error', error => {
      const categories = new Map([
        ['ENOTFOUND', 'dns_failure'], ['EAI_AGAIN', 'dns_failure'],
        ['ECONNREFUSED', 'connection_refused'], ['ECONNRESET', 'connection_reset'],
        ['CERT_HAS_EXPIRED', 'tls_certificate_error'], ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'tls_certificate_error']
      ]);
      finish({ httpStatus, googleCode: null, diagnostic: categories.get(error.code) ?? 'network_error_no_retry' });
    });
    // Total deadline includes connection, response headers and reading the body.
    timer = setTimeout(() => {
      finish({ httpStatus, googleCode: null, diagnostic: 'timeout' });
      request.destroy();
    }, 10000);
    request.end(payload);
  });
}

main().catch(() => {
  // Raw exceptions can include secrets. Never print them, even on local failure.
  console.log(JSON.stringify({ httpStatus: null, googleCode: null, diagnostic: 'local_failure_no_retry' }));
  process.exitCode = 1;
});
