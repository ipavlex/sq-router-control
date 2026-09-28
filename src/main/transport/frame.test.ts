/**
 * Unit tests for SQ framing: encoders and the stateful TCP `Framer`.
 * Uses synthesised buffers only (no socket, no console).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  Framer,
  HEADER_LEN,
  MARKER,
  DSP_MARKER,
  Sub,
  encodeFrame,
  encodeEmpty,
  encodeMeterSub,
  encodeTypeReq,
  encodeSubscribeAll,
} from "./frame";

/** DSP frame on the wire: 0xF7 + 7 payload bytes (8 total). */
function dspFrame(payload: number[]): Buffer {
  assert.equal(payload.length, 7);
  return Buffer.from([DSP_MARKER, ...payload]);
}

describe("frame encoders", () => {
  it("encodeFrame writes marker, subtype and u32LE length", () => {
    const f = encodeFrame(Sub.Version, Buffer.from([1, 2, 3]));
    assert.equal(f[0], MARKER);
    assert.equal(f[1], Sub.Version);
    assert.equal(f.readUInt32LE(2), 3);
    assert.deepEqual([...f.slice(HEADER_LEN)], [1, 2, 3]);
    assert.equal(f.length, HEADER_LEN + 3);
  });

  it("encodeEmpty produces a header-only frame", () => {
    const f = encodeEmpty(Sub.Keepalive);
    assert.equal(f.length, HEADER_LEN);
    assert.equal(f[1], Sub.Keepalive);
    assert.equal(f.readUInt32LE(2), 0);
  });

  it("encodeMeterSub carries the UDP port little-endian", () => {
    const f = encodeMeterSub(0x1234);
    assert.equal(f[1], Sub.MeterSub);
    assert.deepEqual([...f.slice(HEADER_LEN)], [0x34, 0x12]);
  });

  it("encodeTypeReq is [02 00]", () => {
    const f = encodeTypeReq();
    assert.equal(f[1], Sub.TypeReq);
    assert.deepEqual([...f.slice(HEADER_LEN)], [0x02, 0x00]);
  });

  it("encodeSubscribeAll is an 8192-byte all-0xFF payload", () => {
    const f = encodeSubscribeAll();
    assert.equal(f[1], Sub.Subscribe);
    assert.equal(f.readUInt32LE(2), 8192);
    const payload = f.slice(HEADER_LEN);
    assert.equal(payload.length, 8192);
    assert.ok(payload.every((b) => b === 0xff));
  });
});

describe("Framer", () => {
  it("parses one complete frame", () => {
    const fr = new Framer();
    const out = fr.push(encodeFrame(Sub.Version, Buffer.from([9, 8])));
    assert.equal(out.length, 1);
    assert.equal(out[0].subType, Sub.Version);
    assert.deepEqual([...out[0].payload], [9, 8]);
  });

  it("buffers a frame split across chunks", () => {
    const fr = new Framer();
    const wire = encodeFrame(Sub.Version, Buffer.from([1, 2, 3, 4]));
    assert.deepEqual(fr.push(wire.slice(0, 5)), []);
    const out = fr.push(wire.slice(5));
    assert.equal(out.length, 1);
    assert.deepEqual([...out[0].payload], [1, 2, 3, 4]);
  });

  it("parses several frames delivered in one chunk", () => {
    const fr = new Framer();
    const wire = Buffer.concat([
      encodeEmpty(Sub.Ack),
      encodeFrame(Sub.Version, Buffer.from([7])),
      encodeEmpty(Sub.Sync),
    ]);
    const out = fr.push(wire);
    assert.deepEqual(
      out.map((f) => f.subType),
      [Sub.Ack, Sub.Version, Sub.Sync]
    );
  });

  it("parses a fixed 8-byte DSP frame", () => {
    const fr = new Framer();
    const out = fr.push(dspFrame([0, 0x0b, 0x0d, 5, 0x0f, 1, 0x1a]));
    assert.equal(out.length, 1);
    assert.equal(out[0].subType, DSP_MARKER);
    assert.equal(out[0].payload.length, 7);
    assert.deepEqual([...out[0].payload], [0, 0x0b, 0x0d, 5, 0x0f, 1, 0x1a]);
  });

  it("waits for the full 8 bytes of a split DSP frame", () => {
    const fr = new Framer();
    const wire = dspFrame([1, 2, 3, 4, 5, 6, 7]);
    assert.deepEqual(fr.push(wire.slice(0, 7)), []);
    const out = fr.push(wire.slice(7));
    assert.equal(out.length, 1);
    assert.deepEqual([...out[0].payload], [1, 2, 3, 4, 5, 6, 7]);
  });

  it("interleaves 0x7F and 0xF7 frames", () => {
    const fr = new Framer();
    const wire = Buffer.concat([
      encodeFrame(Sub.Version, Buffer.from([1, 2])),
      dspFrame([0, 0x0b, 0x0d, 9, 1, 2, 3]),
      encodeEmpty(Sub.Sync),
    ]);
    const out = fr.push(wire);
    assert.deepEqual(
      out.map((f) => f.subType),
      [Sub.Version, DSP_MARKER, Sub.Sync]
    );
  });

  it("resynchronises after leading garbage", () => {
    const fr = new Framer();
    const wire = Buffer.concat([
      Buffer.from([0x00, 0x01, 0x02, 0x03]), // no marker inside
      encodeFrame(Sub.Version, Buffer.from([42])),
    ]);
    const out = fr.push(wire);
    assert.equal(out.length, 1);
    assert.deepEqual([...out[0].payload], [42]);
  });

  it("retains a partial large-length frame until complete", () => {
    const fr = new Framer();
    const wire = encodeFrame(Sub.ChannelInfo, Buffer.alloc(100, 0xaa));
    assert.deepEqual(fr.push(wire.slice(0, 20)), []);
    const out = fr.push(wire.slice(20));
    assert.equal(out.length, 1);
    assert.equal(out[0].payload.length, 100);
  });

  it("does not surface frame bytes when only the header is incomplete", () => {
    const fr = new Framer();
    assert.deepEqual(fr.push(Buffer.from([MARKER, Sub.Version])), []);
  });

  it("reset drops buffered bytes", () => {
    const fr = new Framer();
    const wire = encodeFrame(Sub.Version, Buffer.from([1, 2, 3]));
    fr.push(wire.slice(0, 5));
    fr.reset();
    // Remaining bytes of the old frame must not complete it.
    assert.deepEqual(fr.push(wire.slice(5)), []);
  });
});
