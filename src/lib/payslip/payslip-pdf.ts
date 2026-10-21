import { PAYSLIP_LIMITS } from './payslip-contract';
import { PayslipFileError, type DocumentLine } from './payslip-file';

type TextItem = { str: string; x: number; y: number; width: number; height: number; fontSize: number };

/**
 * Groups positioned PDF text items into visual rows (same baseline), ordered top to bottom. Within a row items are
 * ordered right to left, the reading order of a Hebrew payslip; items separated by a wide gap become separate
 * cells, so table columns stay apart and keep their horizontal position.
 */
export function linesFromItems(pages: TextItem[][]): DocumentLine[] {
  const lines: DocumentLine[] = [];
  pages.forEach((items, pageIndex) => {
    const rows: Array<{ y: number; size: number; items: TextItem[] }> = [];
    for (const item of items) {
      if (!item.str.trim()) continue;
      const size = Math.max(item.fontSize || item.height || 8, 4);
      const row = rows.find(candidate => Math.abs(candidate.y - item.y) <= Math.max(2, Math.min(candidate.size, size) * 0.45));
      if (row) row.items.push(item); else rows.push({ y: item.y, size, items: [item] });
    }
    rows.sort((a, b) => b.y - a.y);
    for (const row of rows) {
      const ordered = [...row.items].sort((a, b) => (b.x + b.width) - (a.x + a.width));
      const cells: Array<{ text: string; x: number; left: number }> = [];
      for (const item of ordered) {
        const previous = cells.at(-1);
        // Right-to-left: the gap is between this item's right edge and the previous cell's left edge.
        const gap = previous ? previous.left - (item.x + item.width) : Infinity;
        if (previous && gap < row.size * 1.2) {
          // Reading order is right to left, so the item further left comes after the text read so far.
          previous.text = `${previous.text}${gap > row.size * 0.15 ? ' ' : ''}${item.str.trim()}`.trim();
          previous.left = item.x;
          previous.x = (previous.x + item.x + item.width / 2) / 2;
        } else cells.push({ text: item.str.trim(), x: item.x + item.width / 2, left: item.x });
      }
      lines.push({ page: pageIndex + 1, cells: cells.map(({ text, x }) => ({ text, x })) });
    }
  });
  return lines;
}

export type PdfText = { pages: number; lines: DocumentLine[]; characters: number };

/** Local text extraction from a digital PDF. Nothing leaves the server; scripts in the PDF are never run. */
export async function extractPdfText(bytes: Uint8Array): Promise<PdfText> {
  const { getDocumentProxy, extractTextItems } = await import('unpdf');
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>>;
  try {
    // A copy: pdf.js may transfer (detach) the buffer it is given. This pdf.js build never compiles code (no eval).
    pdf = await getDocumentProxy(new Uint8Array(bytes), { useSystemFonts: false, stopAtErrors: false, enableXfa: false });
  } catch (error) {
    throw new PayslipFileError(error instanceof Error && error.name === 'PasswordException' ? 'pdf_encrypted' : 'invalid_pdf');
  }
  try {
    if (pdf.numPages < 1) throw new PayslipFileError('invalid_pdf');
    if (pdf.numPages > PAYSLIP_LIMITS.maxPdfPages) throw new PayslipFileError('too_many_pages');
    let items: TextItem[][];
    try { items = (await extractTextItems(pdf)).items as TextItem[][]; }
    catch { throw new PayslipFileError('invalid_pdf'); }
    const lines = linesFromItems(items);
    return { pages: pdf.numPages, lines, characters: lines.reduce((sum, line) => sum + line.cells.reduce((count, cell) => count + cell.text.replace(/\s/g, '').length, 0), 0) };
  } finally {
    await pdf.loadingTask.destroy().catch(() => undefined);
  }
}

/** Page count only (a scanned PDF is sent for visual reading only within the page limit). */
export async function countPdfPages(bytes: Uint8Array) {
  const { getDocumentProxy } = await import('unpdf');
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>>;
  try { pdf = await getDocumentProxy(new Uint8Array(bytes), { useSystemFonts: false, enableXfa: false }); }
  catch (error) { throw new PayslipFileError(error instanceof Error && error.name === 'PasswordException' ? 'pdf_encrypted' : 'invalid_pdf'); }
  try { return pdf.numPages; } finally { await pdf.loadingTask.destroy().catch(() => undefined); }
}

/** Too little text to be a digital payslip: probably a scan or a photo saved as PDF. */
export const looksScanned = (text: PdfText) => text.characters < 40 * text.pages || !text.lines.some(line => line.cells.some(cell => /\p{Script=Hebrew}/u.test(cell.text)));
