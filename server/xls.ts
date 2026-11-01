/**
 * A minimal reader for legacy Excel `.xls` files (BIFF8 inside an OLE2 compound document) — just
 * enough for the DMO's report exports, which are only offered in this format. Pure (bytes in,
 * cell grids out) and free of Node APIs, so the app's tests can import it.
 *
 * Supported: the OLE2 container's FAT/DIFAT chains and directory (the "Workbook" stream, which
 * must be at least the 4096-byte mini-stream cutoff); BIFF8 records BOF/EOF, BOUNDSHEET,
 * DATEMODE (1900 system only), SST + CONTINUE, LABELSST, LABEL, NUMBER, RK, MULRK and FORMULA
 * numeric results. Everything else is skipped.
 */

export type XlsCell = string | number | null;

export interface XlsSheet {
  name: string;
  /** rows[r][c]; missing cells are null (rows may be ragged or sparse). */
  rows: XlsCell[][];
}

export interface XlsWorkbook {
  sheets: XlsSheet[];
}

const MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const MAX_REGULAR_SECTOR = 0xfffffffa;

export function isOle2(bytes: Uint8Array): boolean {
  return bytes.length >= 8 && MAGIC.every((b, i) => bytes[i] === b);
}

/** The bytes of a named stream in an OLE2 compound document. */
export function readCompoundStream(bytes: Uint8Array, name: string): Uint8Array {
  if (!isOle2(bytes)) throw new Error("not an OLE2 (.xls) file");
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ssz = 1 << dv.getUint16(0x1e, true);
  const numFat = dv.getUint32(0x2c, true);
  const dirStart = dv.getUint32(0x30, true);
  const miniCutoff = dv.getUint32(0x38, true);
  const sectorCount = Math.floor((bytes.length - ssz) / ssz) + 1;
  const sector = (i: number): Uint8Array => {
    const off = (i + 1) * ssz;
    if (i >= MAX_REGULAR_SECTOR || off >= bytes.length) throw new Error(`bad sector ${i}`);
    return bytes.subarray(off, Math.min(off + ssz, bytes.length));
  };
  const u32s = (s: Uint8Array): number[] => {
    const v = new DataView(s.buffer, s.byteOffset, s.byteLength);
    const out: number[] = [];
    for (let o = 0; o + 4 <= s.byteLength; o += 4) out.push(v.getUint32(o, true));
    return out;
  };

  // The FAT's own sectors: 109 in the header, the rest in a chain of DIFAT sectors.
  const fatSectors: number[] = [];
  for (let i = 0; i < 109 && fatSectors.length < numFat; i++) fatSectors.push(dv.getUint32(0x4c + i * 4, true));
  let difat = dv.getUint32(0x44, true);
  let guard = 0;
  while (fatSectors.length < numFat && difat < MAX_REGULAR_SECTOR) {
    if (++guard > sectorCount) throw new Error("DIFAT chain loops");
    const entries = u32s(sector(difat));
    for (let i = 0; i < entries.length - 1 && fatSectors.length < numFat; i++) fatSectors.push(entries[i]);
    difat = entries[entries.length - 1];
  }
  const fat: number[] = [];
  for (const s of fatSectors) for (const e of u32s(sector(s))) fat.push(e);

  const chain = (start: number): Uint8Array => {
    const parts: Uint8Array[] = [];
    let s = start;
    let n = 0;
    while (s < MAX_REGULAR_SECTOR) {
      if (++n > sectorCount) throw new Error("sector chain loops");
      parts.push(sector(s));
      s = fat[s];
      if (s === undefined) throw new Error("sector chain runs off the FAT");
    }
    const out = new Uint8Array(parts.reduce((t, p) => t + p.length, 0));
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  };

  const dir = chain(dirStart);
  const ddv = new DataView(dir.buffer, dir.byteOffset, dir.byteLength);
  const names: string[] = [];
  for (let off = 0; off + 128 <= dir.length; off += 128) {
    const nameLen = ddv.getUint16(off + 0x40, true);
    let entryName = "";
    for (let i = 0; i + 2 < nameLen; i += 2) entryName += String.fromCharCode(ddv.getUint16(off + i, true));
    const type = dir[off + 0x42];
    names.push(entryName);
    if (type !== 2 || entryName.toLowerCase() !== name.toLowerCase()) continue;
    const start = ddv.getUint32(off + 0x74, true);
    const size = ddv.getUint32(off + 0x78, true);
    if (size < miniCutoff) throw new Error(`stream "${name}" is in the mini-stream, which is not supported`);
    const data = chain(start);
    if (data.length < size) throw new Error(`stream "${name}" is truncated`);
    return data.subarray(0, size);
  }
  if (name === "Workbook" && names.includes("Book")) throw new Error("BIFF5 workbooks are not supported");
  throw new Error(`no "${name}" stream in the file`);
}

/** Reads a BIFF8 `.xls` file into cell grids, one per worksheet. */
export function readXls(bytes: Uint8Array): XlsWorkbook {
  return parseBiff(readCompoundStream(bytes, "Workbook"));
}

// ---------------------------------------------------------------------------------------------

interface Rec {
  type: number;
  data: Uint8Array;
}

function records(stream: Uint8Array): Rec[] {
  const dv = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
  const out: Rec[] = [];
  let p = 0;
  while (p + 4 <= stream.length) {
    const type = dv.getUint16(p, true);
    const len = dv.getUint16(p + 2, true);
    out.push({ type, data: stream.subarray(p + 4, p + 4 + len) });
    p += 4 + len;
  }
  return out;
}

/** Reads across the SST record and its CONTINUE records. */
class SegmentCursor {
  private i = 0;
  private p = 0;
  constructor(private readonly segs: Uint8Array[]) {}
  atSegmentEnd(): boolean {
    return this.p >= this.segs[this.i].length;
  }
  nextSegment(): void {
    this.i++;
    this.p = 0;
    if (this.i >= this.segs.length) throw new Error("SST runs past its records");
  }
  left(): number {
    return this.segs[this.i].length - this.p;
  }
  byte(): number {
    while (this.atSegmentEnd()) this.nextSegment();
    return this.segs[this.i][this.p++];
  }
  u16(): number {
    return this.byte() | (this.byte() << 8);
  }
  u32(): number {
    return (this.u16() | (this.u16() << 16)) >>> 0;
  }
  skip(n: number): void {
    for (let k = 0; k < n; k++) this.byte();
  }
  done(): boolean {
    return this.i >= this.segs.length - 1 && this.atSegmentEnd();
  }
}

function readSstString(c: SegmentCursor): string {
  const cch = c.u16();
  const flags = c.byte();
  let high = (flags & 1) !== 0;
  const runs = flags & 8 ? c.u16() : 0;
  const ext = flags & 4 ? c.u32() : 0;
  let s = "";
  let left = cch;
  while (left > 0) {
    if (c.atSegmentEnd()) {
      // Character data split across a CONTINUE: it restarts with its own flags byte.
      c.nextSegment();
      high = (c.byte() & 1) !== 0;
    }
    const avail = high ? Math.floor(c.left() / 2) : c.left();
    const n = Math.min(left, avail);
    if (n <= 0) throw new Error("malformed SST string");
    for (let k = 0; k < n; k++) s += String.fromCharCode(high ? c.u16() : c.byte());
    left -= n;
  }
  c.skip(runs * 4 + ext);
  return s;
}

/** XLUnicodeString with a 16-bit length (LABEL records) or 8-bit (BOUNDSHEET names). */
function readUnicode(data: Uint8Array, off: number, cch: number): string {
  const high = (data[off] & 1) !== 0;
  let s = "";
  let p = off + 1;
  for (let k = 0; k < cch; k++) {
    if (high) {
      s += String.fromCharCode(data[p] | (data[p + 1] << 8));
      p += 2;
    } else s += String.fromCharCode(data[p++]);
  }
  return s;
}

const rkScratch = new DataView(new ArrayBuffer(8));
export function decodeRk(rk: number): number {
  let n: number;
  if (rk & 2) n = (rk | 0) >> 2;
  else {
    rkScratch.setUint32(0, 0, true);
    rkScratch.setUint32(4, (rk & 0xfffffffc) >>> 0, true);
    n = rkScratch.getFloat64(0, true);
  }
  return rk & 1 ? n / 100 : n;
}

function parseBiff(stream: Uint8Array): XlsWorkbook {
  const recs = records(stream);
  const sst: string[] = [];
  const sheetNames: string[] = [];
  const sheets: XlsSheet[] = [];
  let current: XlsSheet | null = null;

  const put = (r: number, col: number, v: XlsCell) => {
    if (!current) return;
    while (current.rows.length <= r) current.rows.push([]);
    const row = current.rows[r];
    while (row.length < col) row.push(null);
    row[col] = v;
  };

  for (let i = 0; i < recs.length; i++) {
    const { type, data } = recs[i];
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    switch (type) {
      case 0x0809: {
        // BOF: 0x0005 = workbook globals, 0x0010 = worksheet.
        if (dv.getUint16(0, true) !== 0x0600) throw new Error("not a BIFF8 workbook");
        const kind = dv.getUint16(2, true);
        if (kind === 0x0010) {
          current = { name: sheetNames[sheets.length] ?? `Sheet${sheets.length + 1}`, rows: [] };
          sheets.push(current);
        } else current = null;
        break;
      }
      case 0x000a: // EOF
        current = null;
        break;
      case 0x0085: // BOUNDSHEET
        sheetNames.push(readUnicode(data, 7, data[6]));
        break;
      case 0x0022: // DATEMODE
        if (dv.getUint16(0, true) !== 0) throw new Error("1904 date system is not supported");
        break;
      case 0x00fc: {
        // SST, with any CONTINUE records that follow.
        const segs = [data];
        while (i + 1 < recs.length && recs[i + 1].type === 0x003c) segs.push(recs[++i].data);
        const c = new SegmentCursor(segs);
        c.skip(4);
        const unique = c.u32();
        for (let k = 0; k < unique; k++) sst.push(readSstString(c));
        break;
      }
      case 0x00fd: {
        const idx = dv.getUint32(6, true);
        if (idx >= sst.length) throw new Error(`string index ${idx} out of range`);
        put(dv.getUint16(0, true), dv.getUint16(2, true), sst[idx]);
        break;
      }
      case 0x0204:
        put(dv.getUint16(0, true), dv.getUint16(2, true), readUnicode(data, 8, dv.getUint16(6, true)));
        break;
      case 0x0203:
        put(dv.getUint16(0, true), dv.getUint16(2, true), dv.getFloat64(6, true));
        break;
      case 0x027e:
        put(dv.getUint16(0, true), dv.getUint16(2, true), decodeRk(dv.getUint32(6, true)));
        break;
      case 0x00bd: {
        const r = dv.getUint16(0, true);
        const first = dv.getUint16(2, true);
        const n = (data.length - 6) / 6;
        for (let k = 0; k < n; k++) put(r, first + k, decodeRk(dv.getUint32(4 + k * 6 + 2, true)));
        break;
      }
      case 0x0006: {
        // FORMULA: a numeric cached result unless the top two bytes are 0xFFFF.
        if (data[12] === 0xff && data[13] === 0xff) break;
        put(dv.getUint16(0, true), dv.getUint16(2, true), dv.getFloat64(6, true));
        break;
      }
      default:
        break;
    }
  }
  return { sheets };
}
