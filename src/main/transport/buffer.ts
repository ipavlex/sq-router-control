/**
 * SQ byte buffer — all multi-byte integers are little-endian.
 *
 * The A&H SQ binary protocol (port 51326) serialises integers as:
 *   - 16-bit values: little-endian u16
 *   - 32-bit values: two little-endian u16 words (also little-endian overall)
 */
export class BufferReader {
  private data: Buffer;
  private wp = 0; // write position
  private rp = 0; // read position

  constructor(sizeOrData: number | Buffer | Uint8Array = 256) {
    if (Buffer.isBuffer(sizeOrData)) {
      this.data = sizeOrData;
      this.wp = sizeOrData.length;
    } else if (sizeOrData instanceof Uint8Array) {
      this.data = Buffer.from(sizeOrData);
      this.wp = sizeOrData.length;
    } else {
      this.data = Buffer.alloc(sizeOrData);
    }
  }

  // ── write ─────────────────────────────────────────────────────────────────

  writeU8(v: number): this {
    this.data[this.wp++] = v & 0xff;
    return this;
  }

  writeU16LE(v: number): this {
    this.data[this.wp++] = v & 0xff;
    this.data[this.wp++] = (v >> 8) & 0xff;
    return this;
  }

  writeU32LE(v: number): this {
    this.writeU16LE(v & 0xffff);
    this.writeU16LE((v >>> 16) & 0xffff);
    return this;
  }

  writeBytes(src: Buffer | Uint8Array | number[]): this {
    const b = Array.isArray(src) ? Buffer.from(src) : Buffer.from(src);
    b.copy(this.data, this.wp);
    this.wp += b.length;
    return this;
  }

  // ── read ──────────────────────────────────────────────────────────────────

  readU8(): number {
    return this.data[this.rp++];
  }

  readU16LE(): number {
    const lo = this.data[this.rp++];
    const hi = this.data[this.rp++];
    return (hi << 8) | lo;
  }

  readU32LE(): number {
    const lo = this.readU16LE();
    const hi = this.readU16LE();
    return ((hi << 16) | lo) >>> 0;
  }

  readBytes(n: number): Buffer {
    const slice = this.data.slice(this.rp, this.rp + n);
    this.rp += n;
    return Buffer.from(slice);
  }

  readNullTermString(max?: number): string {
    const start = this.rp;
    const limit = max ? Math.min(this.data.length, start + max) : this.data.length;
    while (this.rp < limit && this.data[this.rp] !== 0) this.rp++;
    const s = this.data.slice(start, this.rp).toString("latin1");
    if (this.rp < this.data.length) this.rp++; // skip null
    return s;
  }

  skip(n: number): this {
    this.rp += n;
    return this;
  }

  seek(pos: number): this {
    this.rp = pos;
    return this;
  }

  get raw(): Buffer {
    return this.data;
  }

  toBuffer(): Buffer {
    return this.data.slice(0, this.wp);
  }
}
