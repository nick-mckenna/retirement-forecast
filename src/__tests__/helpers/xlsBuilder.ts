/**
 * Builds small synthetic BIFF8 `.xls` files (OLE2 compound documents) for testing the reader —
 * so no real downloaded spreadsheet is committed. Strings go to the shared string table (with an
 * optional split across a CONTINUE record); numbers are written as RK, MULRK or NUMBER records.
 */

export type BuildValue = string | number;

export interface BuildSheet {
  name: string;
  rows: (BuildValue | null)[][];
}

export interface BuildOptions {
  /** Split the shared string table so one string's characters continue in a CONTINUE record. */
  splitSst?: boolean;
  /** Pad the stream to at least this many bytes (the reader needs ≥ 4096). */
  minStreamBytes?: number;
  /** Override the DATEMODE record (1 = the unsupported 1904 system). */
  dateMode?: number;
}

class Bytes {
  private parts: number[] = [];
  u8(v: number) {
    this.parts.push(v & 0xff);
    return this;
  }
  u16(v: number) {
    return this.u8(v).u8(v >> 8);
  }
  u32(v: number) {
    return this.u16(v & 0xffff).u16((v >>> 16) & 0xffff);
  }
  f64(v: number) {
    const dv = new DataView(new ArrayBuffer(8));
    dv.setFloat64(0, v, true);
    for (let i = 0; i < 8; i++) this.u8(dv.getUint8(i));
    return this;
  }
  bytes(b: ArrayLike<number>) {
    for (let i = 0; i < b.length; i++) this.u8(b[i]);
    return this;
  }
  get length() {
    return this.parts.length;
  }
  toArray(): number[] {
    return this.parts;
  }
}

function record(out: Bytes, type: number, data: number[]) {
  out.u16(type).u16(data.length).bytes(data);
}

function isHigh(s: string): boolean {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 0xff) return true;
  return false;
}

function chars(s: string, high: boolean): number[] {
  const b = new Bytes();
  for (let i = 0; i < s.length; i++) (high ? b.u16(s.charCodeAt(i)) : b.u8(s.charCodeAt(i)));
  return b.toArray();
}

/** RK encoding where exact, else null (written as NUMBER instead). */
function toRk(v: number): number | null {
  if (Number.isInteger(v) && Math.abs(v) < 2 ** 29) return ((v << 2) | 2) >>> 0;
  const h = Math.round(v * 100);
  if (Math.abs(v * 100 - h) < 1e-9 && Math.abs(h) < 2 ** 29) return ((h << 2) | 3) >>> 0;
  const dv = new DataView(new ArrayBuffer(8));
  dv.setFloat64(0, v, true);
  if (dv.getUint32(0, true) === 0 && (dv.getUint32(4, true) & 3) === 0) return dv.getUint32(4, true);
  return null;
}

function biffStream(sheets: BuildSheet[], opts: BuildOptions): number[] {
  const strings: string[] = [];
  const index = new Map<string, number>();
  for (const s of sheets)
    for (const row of s.rows)
      for (const v of row)
        if (typeof v === "string" && !index.has(v)) {
          index.set(v, strings.length);
          strings.push(v);
        }

  const out = new Bytes();
  const bof = (kind: number) => record(out, 0x0809, new Bytes().u16(0x0600).u16(kind).u32(0).u32(0).u32(0).toArray());
  bof(0x0005);
  record(out, 0x0022, new Bytes().u16(opts.dateMode ?? 0).toArray());
  for (const s of sheets) {
    const name = new Bytes().u32(0).u8(0).u8(0).u8(s.name.length).u8(0).bytes(chars(s.name, false));
    record(out, 0x0085, name.toArray());
  }

  // SST: header + strings, optionally split mid-string into a CONTINUE record.
  const sstBody = new Bytes().u32(strings.length).u32(strings.length);
  let splitAt = -1;
  let splitHigh = false;
  strings.forEach((s, k) => {
    const high = isHigh(s);
    sstBody.u16(s.length).u8(high ? 1 : 0);
    const c = chars(s, high);
    if (opts.splitSst && splitAt < 0 && k === strings.length - 1 && s.length >= 2) {
      // Split after the first character of the last string.
      const firstLen = high ? 2 : 1;
      sstBody.bytes(c.slice(0, firstLen));
      splitAt = sstBody.length;
      splitHigh = high;
      sstBody.bytes(c.slice(firstLen));
    } else sstBody.bytes(c);
  });
  const sst = sstBody.toArray();
  if (splitAt >= 0) {
    record(out, 0x00fc, sst.slice(0, splitAt));
    record(out, 0x003c, [splitHigh ? 1 : 0, ...sst.slice(splitAt)]);
  } else record(out, 0x00fc, sst);
  // Filler records the reader skips, to get past the mini-stream cutoff.
  while (out.length < (opts.minStreamBytes ?? 5000) - 200) record(out, 0x0099, new Array(1000).fill(0));
  record(out, 0x000a, []);

  for (const s of sheets) {
    bof(0x0010);
    s.rows.forEach((row, r) => {
      let c = 0;
      while (c < row.length) {
        const v = row[c];
        if (v === null) {
          c++;
          continue;
        }
        if (typeof v === "string") {
          record(out, 0x00fd, new Bytes().u16(r).u16(c).u16(0).u32(index.get(v)!).toArray());
          c++;
          continue;
        }
        // A run of RK-encodable numbers → MULRK; a lone one → RK; otherwise NUMBER.
        let end = c;
        while (end < row.length && typeof row[end] === "number" && toRk(row[end] as number) !== null) end++;
        if (end - c >= 2) {
          const b = new Bytes().u16(r).u16(c);
          for (let k = c; k < end; k++) b.u16(0).u32(toRk(row[k] as number)!);
          record(out, 0x00bd, b.u16(end - 1).toArray());
          c = end;
        } else if (end - c === 1) {
          record(out, 0x027e, new Bytes().u16(r).u16(c).u16(0).u32(toRk(v)!).toArray());
          c++;
        } else {
          record(out, 0x0203, new Bytes().u16(r).u16(c).u16(0).f64(v).toArray());
          c++;
        }
      }
    });
    record(out, 0x000a, []);
  }
  return out.toArray();
}

const SECT = 512;
const ENDOFCHAIN = 0xfffffffe;
const FREESECT = 0xffffffff;
const FATSECT = 0xfffffffd;

function dirEntry(name: string, type: number, start: number, size: number, child: number): number[] {
  const b = new Bytes();
  const nameChars = chars(name, true);
  b.bytes(nameChars).u16(0);
  while (b.length < 64) b.u8(0);
  b.u16((name.length + 1) * 2).u8(type).u8(1);
  b.u32(FREESECT).u32(FREESECT).u32(child);
  while (b.length < 0x74) b.u8(0);
  b.u32(start).u32(size).u32(0);
  return b.toArray();
}

/** A complete `.xls` file. */
export function buildXls(sheets: BuildSheet[], opts: BuildOptions = {}): Uint8Array {
  const stream = biffStream(sheets, opts);
  const nStream = Math.ceil(stream.length / SECT);
  const dirSector = nStream;
  const fatSector = nStream + 1;
  if (fatSector + 1 > SECT / 4) throw new Error("test workbook too large for one FAT sector");

  const header = new Bytes()
    .bytes([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
    .bytes(new Array(16).fill(0))
    .u16(0x3e)
    .u16(3)
    .u16(0xfffe)
    .u16(9)
    .u16(6)
    .bytes(new Array(6).fill(0))
    .u32(0) // directory sectors (0 for v3)
    .u32(1) // FAT sectors
    .u32(dirSector)
    .u32(0)
    .u32(4096)
    .u32(ENDOFCHAIN) // mini FAT start
    .u32(0)
    .u32(ENDOFCHAIN) // DIFAT start
    .u32(0);
  header.u32(fatSector);
  while (header.length < SECT) header.u32(FREESECT);

  const data = new Bytes().bytes(stream);
  while (data.length < nStream * SECT) data.u8(0);
  const dir = new Bytes()
    .bytes(dirEntry("Root Entry", 5, ENDOFCHAIN, 0, 1))
    .bytes(dirEntry("Workbook", 2, 0, stream.length, FREESECT));
  while (dir.length < SECT) dir.u8(0);
  const fat = new Bytes();
  for (let i = 0; i < nStream; i++) fat.u32(i === nStream - 1 ? ENDOFCHAIN : i + 1);
  fat.u32(ENDOFCHAIN).u32(FATSECT);
  while (fat.length < SECT) fat.u32(FREESECT);

  return new Uint8Array([...header.toArray(), ...data.toArray(), ...dir.toArray(), ...fat.toArray()]);
}
