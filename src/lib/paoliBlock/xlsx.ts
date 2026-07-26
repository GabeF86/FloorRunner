/**
 * Dependency-light .xlsx reader (stdlib only: node:zlib for DEFLATE).
 *
 * An .xlsx file is a zip archive of XML parts. This module parses the zip
 * central directory by hand, inflates entries with `zlib.inflateRawSync`,
 * and extracts cell values from the OOXML worksheet parts with targeted
 * string scanning — enough for the Paoli block workbooks (shared strings,
 * inline strings, numbers, cached formula values) without adding a heavy
 * xlsx dependency to the repo (none exists today, checked 2026-07-26).
 *
 * Reading only. The test-fixture writer lives in `__fixtures__/buildXlsx.ts`.
 */

import { inflateRawSync } from 'zlib';

export interface XlsxCell {
  /** Resolved value: string (shared/inline/str), number, or boolean. */
  value: string | number | boolean;
}

export interface XlsxSheet {
  name: string;
  /** Keyed by A1-style ref. Cells without a value are absent. */
  cells: Map<string, XlsxCell>;
  maxRow: number;
  maxCol: number;
}

export interface XlsxWorkbook {
  sheets: XlsxSheet[];
}

// ---------------------------------------------------------------------------
// Column helpers
// ---------------------------------------------------------------------------

/** 'A' → 1, 'M' → 13, 'AA' → 27 */
export function colToIndex(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

/** 1 → 'A', 13 → 'M', 27 → 'AA' */
export function indexToCol(index: number): string {
  let s = '';
  let i = index;
  while (i > 0) {
    const m = (i - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    i = Math.floor((i - 1) / 26);
  }
  return s;
}

// ---------------------------------------------------------------------------
// Zip container
// ---------------------------------------------------------------------------

function readZipEntries(buf: Buffer): Map<string, Buffer> {
  // End-of-central-directory record: scan backwards (comment may follow).
  const EOCD_SIG = 0x06054b50;
  let eocd = -1;
  const minPos = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= minPos; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip/xlsx file: end-of-central-directory not found');
  const entryCount = buf.readUInt16LE(eocd + 10);
  let pos = buf.readUInt32LE(eocd + 16); // central directory offset

  const entries = new Map<string, Buffer>();
  for (let n = 0; n < entryCount; n++) {
    if (buf.readUInt32LE(pos) !== 0x02014b50) {
      throw new Error('corrupt zip: bad central directory entry signature');
    }
    const method = buf.readUInt16LE(pos + 10);
    const compressedSize = buf.readUInt32LE(pos + 20);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localOffset = buf.readUInt32LE(pos + 42);
    const name = buf.subarray(pos + 46, pos + 46 + nameLen).toString('utf8');

    // The local header repeats name/extra with possibly different extra len.
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compressedSize);

    let data: Buffer;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = inflateRawSync(raw);
    else throw new Error(`unsupported zip compression method ${method} for ${name}`);
    entries.set(name, data);

    pos += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

// ---------------------------------------------------------------------------
// XML helpers (targeted, not a general XML parser)
// ---------------------------------------------------------------------------

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (m, body: string) => {
    if (body[0] === '#') {
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    switch (body) {
      case 'amp':
        return '&';
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
      default:
        return m;
    }
  });
}

/** Concatenate the text of every <t> run inside a fragment (rich-text safe). */
function textRuns(fragment: string): string {
  let out = '';
  const re = /<t(?:\s[^>]*)?(?:\/>|>([\s\S]*?)<\/t>)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(fragment))) out += decodeEntities(m[1] ?? '');
  return out;
}

function parseSharedStrings(xml: string | undefined): string[] {
  if (!xml) return [];
  const out: string[] = [];
  const re = /<si>([\s\S]*?)<\/si>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out.push(textRuns(m[1]));
  return out;
}

function parseAttrs(attrText: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([\w:]+)="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(attrText))) attrs[m[1]] = decodeEntities(m[2]);
  return attrs;
}

function parseSheet(name: string, xml: string, sharedStrings: string[]): XlsxSheet {
  const cells = new Map<string, XlsxCell>();
  let maxRow = 0;
  let maxCol = 0;

  const cellRe = /<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
  let m: RegExpExecArray | null;
  while ((m = cellRe.exec(xml))) {
    const attrs = parseAttrs(m[1]);
    const inner = m[2] ?? '';
    const ref = attrs.r;
    if (!ref) continue;

    let value: string | number | boolean | null = null;
    const type = attrs.t ?? 'n';
    if (type === 'inlineStr') {
      const is = /<is>([\s\S]*?)<\/is>/.exec(inner);
      value = is ? textRuns(is[1]) : null;
    } else {
      const v = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(inner);
      if (v) {
        const raw = decodeEntities(v[1]);
        if (type === 's') value = sharedStrings[parseInt(raw, 10)] ?? '';
        else if (type === 'str') value = raw;
        else if (type === 'b') value = raw === '1';
        else if (type === 'e') value = null; // error cells carry no usable value
        else {
          const n = Number(raw);
          value = Number.isFinite(n) ? n : raw;
        }
      }
    }
    if (value === null) continue;

    cells.set(ref, { value });
    const refMatch = /^([A-Z]+)(\d+)$/.exec(ref);
    if (refMatch) {
      maxCol = Math.max(maxCol, colToIndex(refMatch[1]));
      maxRow = Math.max(maxRow, parseInt(refMatch[2], 10));
    }
  }
  return { name, cells, maxRow, maxCol };
}

// ---------------------------------------------------------------------------
// Workbook assembly
// ---------------------------------------------------------------------------

export function readXlsx(bytes: Buffer | Uint8Array): XlsxWorkbook {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const entries = readZipEntries(buf);

  const workbookXml = entries.get('xl/workbook.xml')?.toString('utf8');
  if (!workbookXml) throw new Error('invalid xlsx: xl/workbook.xml missing');
  const relsXml = entries.get('xl/_rels/workbook.xml.rels')?.toString('utf8') ?? '';
  const sharedStrings = parseSharedStrings(entries.get('xl/sharedStrings.xml')?.toString('utf8'));

  // rId → target part path (normalized to the xl/ root)
  const relTargets = new Map<string, string>();
  const relRe = /<Relationship\s([^>]*?)\/>/g;
  let m: RegExpExecArray | null;
  while ((m = relRe.exec(relsXml))) {
    const attrs = parseAttrs(m[1]);
    if (!attrs.Id || !attrs.Target) continue;
    let target = attrs.Target;
    if (target.startsWith('/')) target = target.slice(1);
    else target = `xl/${target}`;
    relTargets.set(attrs.Id, target);
  }

  const sheets: XlsxSheet[] = [];
  const sheetRe = /<sheet\s([^>]*?)\/>/g;
  while ((m = sheetRe.exec(workbookXml))) {
    const attrs = parseAttrs(m[1]);
    const name = attrs.name ?? `sheet${sheets.length + 1}`;
    const target = relTargets.get(attrs['r:id'] ?? '');
    const xml = target ? entries.get(target)?.toString('utf8') : undefined;
    if (!xml) continue; // non-worksheet or missing part
    sheets.push(parseSheet(name, xml, sharedStrings));
  }
  if (!sheets.length) throw new Error('invalid xlsx: no readable worksheets');
  return { sheets };
}

/** Convenience: value at (col 1-based, row 1-based) or null. */
export function cellValue(
  sheet: XlsxSheet,
  col: number,
  row: number,
): string | number | boolean | null {
  return sheet.cells.get(`${indexToCol(col)}${row}`)?.value ?? null;
}
