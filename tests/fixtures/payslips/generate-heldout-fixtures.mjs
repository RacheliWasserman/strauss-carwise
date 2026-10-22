// Regenerates the HELD-OUT payslip fixtures (heldout-*): used only to evaluate extraction, never to design or tune it.
// All names and amounts are invented. Usage (from the project root): node tests/fixtures/payslips/generate-heldout-fixtures.mjs [chrome]
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const browser = process.argv[2] ?? ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync);
if (!browser) throw new Error('Pass the path of Chrome or Edge');
const profile = mkdtempSync(join(tmpdir(), 'carwise-heldout-'));
const headless = (...args) => execFileSync(browser, ['--headless=new', '--disable-gpu', `--user-data-dir=${profile}`, '--no-first-run', ...args], { stdio: 'ignore' });
for (const name of ['heldout-bilingual', 'heldout-colon-list', 'heldout-erp']) {
  const source = pathToFileURL(join(here, 'source', `${name}.html`)).href;
  headless('--no-pdf-header-footer', `--print-to-pdf=${join(here, `${name}.pdf`)}`, source);
  headless('--hide-scrollbars', '--window-size=820,900', `--screenshot=${join(here, `${name}.png`)}`, source);
}
rmSync(profile, { recursive: true, force: true });
console.log('Held-out fixtures written to', here);
