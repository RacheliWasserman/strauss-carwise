// Run checks without loading project .env files or contacting external services.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'carwise-validation-'));
for (const entry of [
  'src', 'lib', 'data', 'tests', 'supabase', 'scripts', 'package.json',
  'package-lock.json', 'tsconfig.json', 'next-env.d.ts', 'postcss.config.mjs'
]) {
  fs.cpSync(path.join(root, entry), path.join(staging, entry), { recursive: true });
}
fs.symlinkSync(path.join(root, 'node_modules'), path.join(staging, 'node_modules'), 'junction');

const guard = path.join(staging, 'offline-checks.cjs');
fs.writeFileSync(guard, `
const deny = () => { throw new Error('External network disabled during local validation'); };
for (const name of ['node:http', 'node:https']) {
  const client = require(name);
  client.request = deny;
  client.get = deny;
}
globalThis.fetch = deny;
`);

// Do not inherit Supabase credentials, NODE_OPTIONS, or arbitrary environment values.
const env = {};
for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'ComSpec', 'TEMP', 'TMP', 'PATHEXT', 'NUMBER_OF_PROCESSORS']) {
  if (process.env[key] !== undefined) env[key] = process.env[key];
}
Object.assign(env, {
  NEXT_TELEMETRY_DISABLED: '1',
  NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:1',
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'local-validation-placeholder',
  SUPABASE_SECRET_KEY: 'local-validation-placeholder',
  NODE_OPTIONS: `--require ${JSON.stringify(guard)}`
});

console.log(`Isolated validation directory: ${staging}`);
for (const [label, cli, args] of [
  ['TypeScript', 'typescript/bin/tsc', ['--noEmit', '--incremental', 'false']],
  ['Vitest', 'vitest/vitest.mjs', ['run']],
  ['Production build', 'next/dist/bin/next', ['build']]
]) {
  console.log(`\n${label}`);
  const result = spawnSync(process.execPath, [path.join(root, 'node_modules', cli), ...args], {
    cwd: staging, env, stdio: 'inherit'
  });
  if (result.error) console.error(result.error.message);
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log('\nAll checks passed. Temporary artifacts retained for review.');
