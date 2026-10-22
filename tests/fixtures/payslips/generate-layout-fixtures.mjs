// Regenerates the diverse-layout payslip fixtures (layout-*). All names and amounts are invented.
// The older fixtures (payslip-a/b/c, complex-*) are not touched by this script.
// Usage (from the project root): node tests/fixtures/payslips/generate-layout-fixtures.mjs [path-to-chrome-or-edge]
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import sharp from 'sharp';

const here = dirname(fileURLToPath(import.meta.url));
const browser = process.argv[2] ?? ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync);
if (!browser) throw new Error('Pass the path of Chrome or Edge');
const profile = mkdtempSync(join(tmpdir(), 'carwise-layouts-'));
const headless = (...args) => execFileSync(browser, ['--headless=new', '--disable-gpu', `--user-data-dir=${profile}`, '--no-first-run', ...args], { stdio: 'ignore' });
const source = name => pathToFileURL(join(here, 'source', `${name}.html`)).href;

// Digital PDFs: the text layer is what the local reader sees.
for (const name of ['layout-cards', 'layout-ytd', 'layout-multipage', 'layout-conflicts']) {
  headless('--no-pdf-header-footer', `--print-to-pdf=${join(here, `${name}.pdf`)}`, source(name));
}
// Images for visual reading: a portal screenshot, a sideways phone photo, and a scan without a text layer.
headless('--hide-scrollbars', '--window-size=680,1100', `--screenshot=${join(here, 'layout-cards.png')}`, source('layout-cards'));
headless('--hide-scrollbars', '--window-size=980,820', `--screenshot=${join(here, 'layout-ytd-screen.png')}`, source('layout-ytd'));
headless('--hide-scrollbars', '--window-size=840,700', `--screenshot=${join(here, 'layout-conflicts-screen.png')}`, source('layout-conflicts'));
rmSync(profile, { recursive: true, force: true });

const ytd = readFileSync(join(here, 'layout-ytd-screen.png'));
writeFileSync(join(here, 'layout-ytd-photo.jpg'), await sharp(ytd).rotate(-90).jpeg({ quality: 78 }).withMetadata({ orientation: 6 }).toBuffer());
rmSync(join(here, 'layout-ytd-screen.png'));

/** A one-page PDF that is only a JPEG image (no text layer), like a scanner produces. */
async function scannedPdf(png) {
  const scan = await sharp(png).grayscale().jpeg({ quality: 70 }).toBuffer();
  const { width, height } = await sharp(scan).metadata();
  const parts = [];
  const offsets = [];
  let length = 0;
  const add = chunk => { const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'latin1'); parts.push(buffer); length += buffer.length; };
  const object = (id, body) => { offsets[id] = length; add(`${id} 0 obj\n`); for (const piece of body) add(piece); add('\nendobj\n'); };
  add('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n');
  const pageWidth = 595, pageHeight = Math.round(595 * height / width);
  const content = `q ${pageWidth} 0 0 ${pageHeight} 0 0 cm /Im0 Do Q`;
  object(1, ['<< /Type /Catalog /Pages 2 0 R >>']);
  object(2, ['<< /Type /Pages /Kids [3 0 R] /Count 1 >>']);
  object(3, [`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`]);
  object(4, [`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /DCTDecode /Length ${scan.length} >>\nstream\n`, scan, '\nendstream']);
  object(5, [`<< /Length ${content.length} >>\nstream\n${content}\nendstream`]);
  const xref = length;
  add(`xref\n0 6\n0000000000 65535 f \n${[1, 2, 3, 4, 5].map(id => `${String(offsets[id]).padStart(10, '0')} 00000 n \n`).join('')}`);
  add(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.concat(parts);
}
writeFileSync(join(here, 'layout-conflicts-scanned.pdf'), await scannedPdf(readFileSync(join(here, 'layout-conflicts-screen.png'))));
rmSync(join(here, 'layout-conflicts-screen.png'));
console.log('Layout fixtures written to', here);
