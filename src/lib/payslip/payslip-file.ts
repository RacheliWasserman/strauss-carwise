import { inflateRawSync } from 'node:zlib';

/**
 * Server-side file checks. The type is decided by the file's own signature (magic bytes) and structure,
 * never by its name or the browser's MIME type.
 */
export type PayslipFileType = 'pdf' | 'jpeg' | 'png' | 'webp' | 'docx' | 'doc_legacy' | 'heic' | 'unsupported';
const startsWith = (bytes: Uint8Array, signature: number[], offset = 0) =>
  bytes.length >= offset + signature.length && signature.every((byte, index) => bytes[offset + index] === byte);
const ascii = (bytes: Uint8Array, start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));

export function detectFileType(bytes: Uint8Array): PayslipFileType {
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'pdf'; // %PDF-
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && bytes.length >= 12 && ascii(bytes, 8, 12) === 'WEBP') return 'webp';
  // Legacy Word (and password-protected Office files) use the OLE compound file format.
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return 'doc_legacy';
  if (bytes.length >= 12 && ascii(bytes, 4, 8) === 'ftyp' && /^(?:heic|heix|hevc|hevx|mif1|msf1)$/.test(ascii(bytes, 8, 12))) return 'heic';
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return 'docx'; // A ZIP container; its structure is checked when read.
  return 'unsupported';
}

export class PayslipFileError extends Error {
  constructor(public code: 'invalid_docx' | 'docx_macro' | 'docx_encrypted' | 'too_large' | 'invalid_pdf' | 'pdf_encrypted' | 'too_many_pages' | 'invalid_image' | 'image_too_large') {
    super('Payslip file rejected');
  }
}

/* ---------- DOCX (Office Open XML) ---------- */

const MAX_ZIP_ENTRIES = 2000;
const MAX_XML_BYTES = 8 * 1024 * 1024;

/** Reads one entry of a ZIP archive, with hard limits on entry count and decompressed size (zip bombs). */
function readZipEntries(bytes: Uint8Array, wanted: string[]) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let index = bytes.length - 22; index >= Math.max(0, bytes.length - 22 - 65535); index--) {
    if (view.getUint32(index, true) === 0x06054b50) { eocd = index; break; }
  }
  if (eocd < 0) throw new PayslipFileError('invalid_docx');
  const count = view.getUint16(eocd + 10, true);
  const directorySize = view.getUint32(eocd + 12, true);
  const directoryOffset = view.getUint32(eocd + 16, true);
  if (count === 0xffff || directoryOffset === 0xffffffff || count > MAX_ZIP_ENTRIES || directoryOffset + directorySize > bytes.length) {
    throw new PayslipFileError('invalid_docx');
  }
  const names: string[] = [];
  const found = new Map<string, Uint8Array>();
  let offset = directoryOffset;
  for (let entry = 0; entry < count; entry++) {
    if (offset + 46 > bytes.length || view.getUint32(offset, true) !== 0x02014b50) throw new PayslipFileError('invalid_docx');
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const compressed = view.getUint32(offset + 20, true);
    const uncompressed = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const local = view.getUint32(offset + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    names.push(name);
    if (flags & 0x1) throw new PayslipFileError('docx_encrypted');
    if (wanted.includes(name)) {
      if (uncompressed > MAX_XML_BYTES || compressed > bytes.length || local + 30 > bytes.length || view.getUint32(local, true) !== 0x04034b50) {
        throw new PayslipFileError(uncompressed > MAX_XML_BYTES ? 'too_large' : 'invalid_docx');
      }
      const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
      const data = bytes.subarray(start, start + compressed);
      if (data.length !== compressed) throw new PayslipFileError('invalid_docx');
      let content: Uint8Array;
      try {
        // maxOutputLength stops inflation even when the declared size lies.
        content = method === 0 ? data : method === 8 ? inflateRawSync(data, { maxOutputLength: MAX_XML_BYTES }) : (() => { throw new PayslipFileError('invalid_docx'); })();
      } catch (error) { throw error instanceof PayslipFileError ? error : new PayslipFileError('too_large'); }
      found.set(name, content);
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return { names, found };
}

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
function decodeXmlText(text: string) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, entity: string) => {
    if (entity[0] === '#') {
      const code = entity[1] === 'x' || entity[1] === 'X' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
    }
    return ENTITIES[entity.toLowerCase()] ?? whole;
  });
}

export type DocumentLine = { cells: Array<{ text: string; x?: number }>; page: number };

/**
 * Text of a DOCX body in reading order. Paragraphs become lines; each table row becomes one line whose cells keep
 * their column order, so a payslip table's columns stay apart. No DTD or external entity is ever processed.
 */
export function extractDocxLines(bytes: Uint8Array): DocumentLine[] {
  const { names, found } = readZipEntries(bytes, ['[Content_Types].xml', 'word/document.xml']);
  const types = found.get('[Content_Types].xml');
  const documentXml = found.get('word/document.xml');
  if (!types || !documentXml) throw new PayslipFileError('invalid_docx');
  const typesText = new TextDecoder().decode(types);
  if (/macroEnabled/i.test(typesText) || names.some(name => /vbaProject\.bin$/i.test(name))) throw new PayslipFileError('docx_macro');
  if (!/wordprocessingml\.document\.main\+xml/.test(typesText)) throw new PayslipFileError('invalid_docx');
  const xml = new TextDecoder().decode(documentXml);
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new PayslipFileError('invalid_docx');

  const lines: DocumentLine[] = [];
  const rows: Array<string[]> = []; // Stack for nested tables.
  const cells: string[] = [];        // Text of the open cell at each nesting level.
  let paragraph = '';
  let inText = false;
  for (const match of xml.matchAll(/<(\/?)([A-Za-z][\w.-]*:)?([A-Za-z][\w.-]*)\b[^>]*?(\/?)>|([^<]+)/g)) {
    const [, closing, prefix, name, selfClosing, text] = match;
    if (text !== undefined) { if (inText) paragraph += decodeXmlText(text); continue; }
    if (prefix !== 'w:') continue;
    if (name === 't') { inText = !closing && !selfClosing; continue; }
    if ((name === 'tab' || name === 'br') && !closing) { paragraph += ' '; continue; }
    if (name === 'p' && closing) {
      const value = paragraph.replace(/\s+/g, ' ').trim();
      paragraph = '';
      if (cells.length) { if (value) cells[cells.length - 1] = `${cells[cells.length - 1]} ${value}`.trim(); }
      else if (value) lines.push({ cells: [{ text: value }], page: 1 });
    } else if (name === 'tr') {
      if (!closing) rows.push([]);
      else {
        const row = rows.pop() ?? [];
        if (row.some(cell => cell)) lines.push({ cells: row.map(text => ({ text })), page: 1 });
      }
    } else if (name === 'tc') {
      if (!closing) cells.push('');
      else { const value = cells.pop() ?? ''; rows[rows.length - 1]?.push(value); }
    }
    if (lines.length > 4000) break;
  }
  return lines;
}
