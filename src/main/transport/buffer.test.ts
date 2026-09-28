/**
 * Unit tests for the little-endian SQ byte buffer.
 * Pure serialisation logic — no console, no I/O.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BufferReader } from "./buffer";

describe("BufferReader", () => {
  it("writes a u8 and reads it back", () => {
    const b = new BufferReader(1);
    b.writeU8(0xab);
    assert.deepEqual([...b.toBuffer()], [0xab]);
    assert.equal(b.readU8(), 0xab);
  });

  it("serialises u16 as little-endian", () => {
    const b = new BufferReader(2);
    b.writeU16LE(0x1234);
    assert.deepEqual([...b.toBuffer()], [0x34, 0x12]);
    assert.equal(b.readU16LE(), 0x1234);
  });

  it("serialises u32 as little-endian", () => {
    const b = new BufferReader(4);
    b.writeU32LE(0x12345678);
    assert.deepEqual([...b.toBuffer()], [0x78, 0x56, 0x34, 0x12]);
    assert.equal(b.readU32LE(), 0x12345678);
  });

  it("round-trips the full u32 range (unsigned)", () => {
    const b = new BufferReader(4);
    b.writeU32LE(0xffffffff);
    assert.deepEqual([...b.toBuffer()], [0xff, 0xff, 0xff, 0xff]);
    assert.equal(b.readU32LE(), 0xffffffff);
  });

  it("writeBytes accepts buffers and number[]", () => {
    const b = new BufferReader(8);
    b.writeBytes([1, 2]);
    b.writeBytes(Buffer.from([3, 4]));
    assert.deepEqual([...b.toBuffer()], [1, 2, 3, 4]);
  });

  it("wraps a source buffer (read position 0, write position at end)", () => {
    const b = new BufferReader(Buffer.from([0xde, 0xad, 0xbe, 0xef]));
    assert.equal(b.readU16LE(), 0xadde);
    assert.equal(b.readU16LE(), 0xefbe);
    // toBuffer returns the full wrapped region.
    assert.deepEqual([...b.toBuffer()], [0xde, 0xad, 0xbe, 0xef]);
  });

  it("wraps a Uint8Array", () => {
    const b = new BufferReader(new Uint8Array([0x01, 0x02]));
    assert.equal(b.readU8(), 1);
    assert.equal(b.readU8(), 2);
  });

  it("readBytes returns a copy and advances the cursor", () => {
    const b = new BufferReader(Buffer.from([1, 2, 3, 4]));
    const first = b.readBytes(2);
    assert.deepEqual([...first], [1, 2]);
    first[0] = 99; // mutating the copy must not touch the source
    assert.equal(b.readU8(), 3);
  });

  it("readNullTermString stops at NUL and skips it", () => {
    const b = new BufferReader(Buffer.from("Kick\0Snare\0tail", "latin1"));
    assert.equal(b.readNullTermString(), "Kick");
    assert.equal(b.readNullTermString(), "Snare");
  });

  it("readNullTermString honours the max length", () => {
    const b = new BufferReader(Buffer.from("ABCDEF", "latin1"));
    assert.equal(b.readNullTermString(3), "ABC");
  });

  it("readNullTermString without a terminator reads to the end", () => {
    const b = new BufferReader(Buffer.from("Vox", "latin1"));
    assert.equal(b.readNullTermString(16), "Vox");
  });

  it("skip and seek move the read cursor", () => {
    const b = new BufferReader(Buffer.from([10, 20, 30, 40]));
    b.skip(1);
    assert.equal(b.readU8(), 20);
    b.seek(3);
    assert.equal(b.readU8(), 40);
  });

  it("toBuffer trims to the written region", () => {
    const b = new BufferReader(16);
    b.writeU8(1);
    b.writeU16LE(0x0203);
    assert.deepEqual([...b.toBuffer()], [1, 0x03, 0x02]);
  });
});
