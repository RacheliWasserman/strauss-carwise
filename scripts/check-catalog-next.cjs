// Local HTTP integration: real Next.js compilation and route, fixture auth/catalog only.
// No project environment files, credentials, or external requests are used.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carwise-catalog-next-'));
const put = (file, text) => { const target = path.join(dir, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, text); };
fs.symlinkSync(path.join(root, 'node_modules'), path.join(dir, 'node_modules'), 'junction');
put('package.json', JSON.stringify({ private: true }));
fs.copyFileSync(path.join(root, 'tsconfig.json'), path.join(dir, 'tsconfig.json'));
put('src/lib/advisor-data-validation.ts', fs.readFileSync(path.join(root, 'src/lib/advisor-data-validation.ts'), 'utf8'));
put('src/middleware.ts', fs.readFileSync(path.join(root, 'src/middleware.ts'), 'utf8'));
put('src/lib/auth-types.ts', fs.readFileSync(path.join(root, 'src/lib/auth-types.ts'), 'utf8'));
put('src/app/api/advisor/vehicles/route.ts', fs.readFileSync(path.join(root, 'src/app/api/advisor/vehicles/route.ts'), 'utf8'));
put('src/lib/persistence-api-auth.ts', 'export async function requireApiRole() { return {}; }');
put('src/lib/advisor-catalog-service.ts', 'export class AdvisorCatalogDataError extends Error {} export async function searchAdvisorVehicles(filters: unknown) { return { filters }; }');
put('src/app/layout.tsx', 'export default function Layout({children}: any) { return <html><body>{children}</body></html>; }');
const env = { NEXT_TELEMETRY_DISABLED: '1' };
for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'ComSpec', 'TEMP', 'TMP']) if (process.env[key]) env[key] = process.env[key];
const child = spawn(process.execPath, [path.join(root, 'node_modules/next/dist/bin/next'), 'dev', '--hostname', '127.0.0.1', '--port', '0'], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
let port;
child.stdout.on('data', chunk => { output += chunk; const match = output.match(/127\.0\.0\.1:(\d+)/); if (match) port = match[1]; });
child.stderr.on('data', chunk => { output += chunk; });
(async () => {
  try {
    const deadline = Date.now() + 60000;
    while (!port && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(port, 'Local Next.js startup failed');
    for (const [query, status, filters] of [['', 200, {limit:20}], ['?manufacturer=Toyota', 200, {manufacturer:'Toyota',limit:20}], ['?q=Toyota',400], ['?limit=',400]]) {
      const url = new URL(`http://127.0.0.1:${port}/api/advisor/vehicles${query}`);
      const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
      const body = await response.json();
      console.log(JSON.stringify({ parameterNames: [...url.searchParams.keys()], status: response.status, issues: body.issues }));
      assert.equal(response.status, status);
      if (filters) assert.deepEqual(body.filters, filters);
    }
    console.log('Next.js catalog integration passed (fixture authentication and catalog).');
  } finally { child.kill(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
