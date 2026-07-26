/**
 * Minimal xlsx WRITER — test-fixture use only.
 *
 * Emits a valid .xlsx (OOXML spreadsheet) as a Buffer using STORED (method 0)
 * zip entries and inline strings (`t="inlineStr"`), so tests can build
 * synthetic workbooks byte-for-byte deterministically without adding any
 * dependency. The production reader (`../xlsx.ts`) must be able to read both
 * these bytes and real Excel/Google-Sheets exports (DEFLATE + sharedStrings).
 */

export type FixtureCell = string | number | null | undefined;

export interface FixtureSheet {
  name: string;
  /** rows[0] is spreadsheet row 1; empty string / null / undefined cells are omitted. */
  rows: FixtureCell[][];
}

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 1-based column index → letters (1 → A, 27 → AA). */
export function colLetters(index: number): string {
  let s = '';
  let i = index;
  while (i > 0) {
    const m = (i - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    i = Math.floor((i - 1) / 26);
  }
  return s;
}

function sheetXml(rows: FixtureCell[][]): string {
  const rowParts: string[] = [];
  rows.forEach((cells, ri) => {
    const r = ri + 1;
    const cellParts: string[] = [];
    cells.forEach((v, ci) => {
      if (v === null || v === undefined || v === '') return;
      const ref = `${colLetters(ci + 1)}${r}`;
      if (typeof v === 'number') {
        cellParts.push(`<c r="${ref}"><v>${v}</v></c>`);
      } else {
        cellParts.push(
          `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`,
        );
      }
    });
    if (cellParts.length) rowParts.push(`<row r="${r}">${cellParts.join('')}</row>`);
  });
  return (
    `${XML_DECL}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<sheetData>${rowParts.join('')}</sheetData></worksheet>`
  );
}

// ---------------------------------------------------------------------------
// STORE-only zip writer
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function zipStore(files: Array<[name: string, data: Buffer]>): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of files) {
    const nameB = Buffer.from(name, 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method: STORE
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0x21, 12); // mod date (1980-01-01)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); // compressed size
    local.writeUInt32LE(data.length, 22); // uncompressed size
    local.writeUInt16LE(nameB.length, 26);
    local.writeUInt16LE(0, 28); // extra len
    chunks.push(local, nameB, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); // central directory signature
    cd.writeUInt16LE(20, 4); // version made by
    cd.writeUInt16LE(20, 6); // version needed
    cd.writeUInt16LE(0, 8); // flags
    cd.writeUInt16LE(0, 10); // method
    cd.writeUInt16LE(0, 12); // mod time
    cd.writeUInt16LE(0x21, 14); // mod date
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameB.length, 28);
    // extra(30)=0 comment(32)=0 disk(34)=0 intAttr(36)=0 extAttr(38)=0
    cd.writeUInt32LE(offset, 42); // local header offset
    central.push(Buffer.concat([cd, nameB]));

    offset += 30 + nameB.length + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // EOCD signature
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cdBuf, eocd]);
}

// ---------------------------------------------------------------------------
// Workbook assembly
// ---------------------------------------------------------------------------

export function buildXlsxBytes(sheets: FixtureSheet[]): Buffer {
  const contentTypes =
    `${XML_DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    sheets
      .map(
        (_, i) =>
          `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
      )
      .join('') +
    '</Types>';

  const rootRels =
    `${XML_DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '</Relationships>';

  const workbook =
    `${XML_DECL}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
    sheets
      .map(
        (s, i) =>
          `<sheet state="visible" name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`,
      )
      .join('') +
    '</sheets></workbook>';

  const workbookRels =
    `${XML_DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    sheets
      .map(
        (_, i) =>
          `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
      )
      .join('') +
    '</Relationships>';

  const files: Array<[string, Buffer]> = [
    ['[Content_Types].xml', Buffer.from(contentTypes, 'utf8')],
    ['_rels/.rels', Buffer.from(rootRels, 'utf8')],
    ['xl/workbook.xml', Buffer.from(workbook, 'utf8')],
    ['xl/_rels/workbook.xml.rels', Buffer.from(workbookRels, 'utf8')],
  ];
  sheets.forEach((s, i) => {
    files.push([`xl/worksheets/sheet${i + 1}.xml`, Buffer.from(sheetXml(s.rows), 'utf8')]);
  });
  return zipStore(files);
}
