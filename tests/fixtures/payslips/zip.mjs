// Minimal ZIP writer for fictional DOCX test fixtures (and malformed variants). Test tooling only.
import { deflateRawSync } from 'node:zlib';

const table = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = (bytes) => { let c = -1; for (const byte of bytes) c = table[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };

/** @param {Array<{ name: string, data: string | Uint8Array, flags?: number, declaredSize?: number }>} entries */
export function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const raw = typeof entry.data === 'string' ? Buffer.from(entry.data, 'utf8') : Buffer.from(entry.data);
    const data = deflateRawSync(raw);
    const name = Buffer.from(entry.name, 'utf8');
    const size = entry.declaredSize ?? raw.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(entry.flags ?? 0, 6); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(raw), 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(size, 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(entry.flags ?? 0, 8);
    central.writeUInt16LE(8, 10); central.writeUInt32LE(crc32(raw), 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const escape = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const run = (text) => `<w:r><w:rPr><w:rtl/></w:rPr><w:t xml:space="preserve">${escape(text)}</w:t></w:r>`;
const paragraph = (text) => `<w:p><w:pPr><w:bidi/></w:pPr>${run(text)}</w:p>`;
const tableXml = (rows) => `<w:tbl><w:tblPr><w:bidiVisual/></w:tblPr>${rows.map(row => `<w:tr>${row.map(cell => `<w:tc>${paragraph(cell)}</w:tc>`).join('')}</w:tr>`).join('')}</w:tbl>`;
export const CONTENT_TYPES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';
const RELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';

/**
 * Blocks are strings (paragraphs) or arrays of rows (tables).
 * @param {Array<string | string[][]>} blocks
 * @param {{ contentTypes?: string, extra?: Array<{ name: string, data: string | Uint8Array }>, prolog?: string }} [options]
 */
export function docx(blocks, { contentTypes = CONTENT_TYPES, extra = [], prolog = '' } = {}) {
  const body = blocks.map(block => typeof block === 'string' ? paragraph(block) : tableXml(block)).join('');
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${prolog}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr/></w:body></w:document>`;
  return zip([{ name: '[Content_Types].xml', data: contentTypes }, { name: '_rels/.rels', data: RELS }, { name: 'word/document.xml', data: document }, ...extra]);
}

/** The fictional payslip A as a Word document (same values as source/payslip-a.html). */
export const PAYSLIP_A_DOCX_BLOCKS = [
  'תלוש שכר לחודש 09/2026 — חברת דוגמה בע"מ',
  'מסמך פיקטיבי לבדיקות בלבד. כל השמות והמספרים בדויים.',
  [['שם העובד', 'דנה ישראלי', 'ת.ז.', '000000018', 'נקודות זיכוי', '2.25'], ['בנק', '99', 'סניף', '999', 'חשבון', '1234567']],
  [['סמל', 'תיאור התשלום', 'כמות', 'סכום'], ['0001', 'שכר יסוד', '1.00', '18,500.00'], ['0120', 'עמלות מכירה', '', '2,300.00'],
    ['0150', 'בונוס חודשי', '', '1,000.00'], ['0300', 'שווי רכב', '', '3,240.00'], ['', 'סה"כ תשלומים', '', '25,040.00']],
  [['ניכוי', 'סכום'], ['מס הכנסה', '3,100.00'], ['פנסיה עובד', '1,110.00'], ['קרן השתלמות עובד', '462.50'], ['השתתפות עובד ברכב', '1,200.00']],
  [['קופה', 'שכר לקופה', '% עובד', 'ניכוי עובד', '% מעביד', 'הפרשת מעביד', '% פיצויים'],
    ['מגדל מקפת קרן פנסיה', '18,500.00', '6.00%', '1,110.00', '6.50%', '1,202.50', '8.33%'],
    ['קרן השתלמות אלטשולר', '18,500.00', '2.50%', '462.50', '7.50%', '1,387.50', '0.00%']]
];
