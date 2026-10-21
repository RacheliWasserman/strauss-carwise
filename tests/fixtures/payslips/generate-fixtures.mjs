// Regenerates the fictional payslip fixtures. All names, IDs and amounts are invented.
// Usage (from the project root): node tests/fixtures/payslips/generate-fixtures.mjs [path-to-chrome-or-edge]
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { docx, PAYSLIP_A_DOCX_BLOCKS } from './zip.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const browser = process.argv[2] ?? ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync);
if (!browser) throw new Error('Pass the path of Chrome or Edge');
const profile = mkdtempSync(join(tmpdir(), 'carwise-fixtures-'));
const headless = (...args) => execFileSync(browser, ['--headless=new', '--disable-gpu', `--user-data-dir=${profile}`, '--no-first-run', ...args], { stdio: 'ignore' });

for (const name of ['payslip-a', 'payslip-b', 'payslip-c']) {
  const url = pathToFileURL(join(here, 'source', `${name}.html`)).href;
  headless('--no-pdf-header-footer', `--print-to-pdf=${join(here, `${name}.pdf`)}`, url);
}
// A screenshot (PNG) of payslip A.
headless('--hide-scrollbars', '--window-size=820,900', `--screenshot=${join(here, 'payslip-a-screenshot.png')}`, pathToFileURL(join(here, 'source', 'payslip-a.html')).href);
rmSync(profile, { recursive: true, force: true });

const png = readFileSync(join(here, 'payslip-a-screenshot.png'));
// A phone-style photo: pixels stored sideways with an EXIF orientation, like a camera does.
writeFileSync(join(here, 'payslip-a-photo.jpg'), await sharp(png).rotate(-90).jpeg({ quality: 80 }).withMetadata({ orientation: 6 }).toBuffer());
writeFileSync(join(here, 'payslip-a.webp'), await sharp(png).webp({ quality: 80 }).toBuffer());

// A scanned PDF: one page that is only a JPEG image, without any text layer.
const scan = await sharp(png).jpeg({ quality: 75 }).toBuffer();
const { width, height } = await sharp(scan).metadata();
const parts = [];
const offsets = [];
let length = 0;
const add = (chunk) => { const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'latin1'); parts.push(buffer); length += buffer.length; };
const object = (id, body) => { offsets[id] = length; add(`${id} 0 obj\n`); for (const piece of body) add(piece); add('\nendobj\n'); };
add('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n');
const pageWidth = 595, pageHeight = Math.round(595 * height / width);
const content = `q ${pageWidth} 0 0 ${pageHeight} 0 0 cm /Im0 Do Q`;
object(1, ['<< /Type /Catalog /Pages 2 0 R >>']);
object(2, ['<< /Type /Pages /Kids [3 0 R] /Count 1 >>']);
object(3, [`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`]);
object(4, [`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${scan.length} >>\nstream\n`, scan, '\nendstream']);
object(5, [`<< /Length ${content.length} >>\nstream\n${content}\nendstream`]);
const xref = length;
add(`xref\n0 6\n0000000000 65535 f \n${[1, 2, 3, 4, 5].map(id => `${String(offsets[id]).padStart(10, '0')} 00000 n \n`).join('')}`);
add(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
writeFileSync(join(here, 'payslip-a-scanned.pdf'), Buffer.concat(parts));

writeFileSync(join(here, 'payslip-a.docx'), docx(PAYSLIP_A_DOCX_BLOCKS));
console.log('Fixtures written to', here);
