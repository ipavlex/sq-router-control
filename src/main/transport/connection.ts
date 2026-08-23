/**
 * A&H SQ TCP connection — proprietary binary protocol on port 51326.
 *
 * Handshake sequence (empirically determined from SQ MixPad traffic):
 *
 *   1. App    → [sub=0x00, len=2, payload=udpPort_LE16]    "meter me on this UDP port"
 *   2. Mixer  → [sub=0x00, len=2, payload=mixerPort_LE16]   mixer's meter source port
 *   3. App    → [sub=0x01, len=0]                           ack
 *   4. Mixer  → [sub=0x02, len>=4, payload=version_info]    firmware/model
 *   5. App    → [sub=0x14, len=0]                           state-ack
 *   6. Mixer  → [sub=0x15, len=720, payload=...]            initial state block
 *   7. App    → [sub=0x0B, len=2, payload=[02,00]]          type negotiation
 *   8. Mixer  → [sub=0x0C, len=2, payload=[01,00]]          type response
 *   9. App    → [sub=0x0A, len=8192, payload=all_FF]        subscribe to all parameters
 *  10. App    → [sub=0x0D/0x11/0x0F, len=0]                 extra subscriptions
 *  11. Mixer  → floods parameter data (sub=0x04, 0x08, 0x0E, 0x10 ...)
 *  12. App    → [sub=0x03] keepalive every ~1000ms
 */
import * as net from "node:net";
import * as dgram from "node:dgram";
import { EventEmitter } from "node:events";
import {
  Framer,
  Frame,
  Sub,
  DSP_MARKER,
  encodeMeterSub,
  encodeAck,
  encodeKeepalive,
  encodeStateAck,
  encodeTypeReq,
  encodeSubscribeAll,
  encodeSubExtra1,
  encodeSubExtra2,
  encodeSubExtra3,
} from "./frame";
import { BufferReader } from "./buffer";
import { modelName } from "../models";
import { decodeMeterMessage, resetMeters, MetersPayload } from "../meters";

export const SQ_TCP_PORT = 51326;
export const KEEPALIVE_INTERVAL_MS = 1000;

export interface ConnectOptions {
  host: string;
  port?: number;
  /** Bind TCP to this local IP to force a particular network interface. */
  localInterface?: string;
  connectTimeoutMs?: number;
}

export interface VersionInfo {
  /** Raw model byte from the version frame. */
  model: number;
  /** Human-readable model name if it can be inferred. */
  modelName: string;
  fwA: number;
  fwB: number;
  build?: number;
}

export interface DspFrame {
  /** byte[3] of payload — channel/address id ("b3"). */
  ch: number;
  /** byte[1] of payload — category. */
  category: number;
  /** byte[2] of payload — register. */
  register: number;
  /** byte[4] of payload — modifier / field. */
  modifier: number;
  /** u16LE at payload offset 5. */
  value: number;
  /** raw 7 payload bytes, for specialised decoders. */
  raw: Buffer;
}



export class Connection extends EventEmitter {
  private tcp: net.Socket | null = null;
  private udp: dgram.Socket | null = null;
  private framer = new Framer();
  private kaTimer: NodeJS.Timeout | null = null;
  private _connected = false;
  private _initialStateParsed = false;
  private opts: Required<ConnectOptions>;

  version: VersionInfo | null = null;
  mixerMeterPort = 0;

  /** Diagnostic counters for frame types received (reset on connect). */
  _frameCounters = {
    total: 0,
    dsp: 0,
    paramData: 0,
    routingBlock: 0,
    fullState: 0,
    channelInfo: 0,
  };

  /** Distinct meter-packet shapes seen (id:bodyLen) — protocol discovery. */
  private _meterCombos = new Set<string>();

  constructor(opts: ConnectOptions) {
    super();
    this.opts = {
      host: opts.host,
      port: opts.port ?? SQ_TCP_PORT,
      localInterface: opts.localInterface ?? "",
      connectTimeoutMs: opts.connectTimeoutMs ?? 10000,
    };
  }

  get connected(): boolean {
    return this._connected;
  }

  get localUdpPort(): number {
    const a = this.udp?.address() as { port?: number } | null;
    return a?.port ?? 0;
  }

  connect(): Promise<VersionInfo> {
    return new Promise((resolve, reject) => {
      const udp = dgram.createSocket("udp4");
      this.udp = udp;
      udp.on("error", (e) => this.emit("error", e));
      udp.on("message", (msg, rinfo) => {
        this.emit("meterData", msg, rinfo.address);
        const meters = decodeMeterMessage(msg);
        if (meters) this.emit("meters", meters);
        this._noteMeterPacket(msg, !!meters);
      });

      udp.bind(0, () => {
        this._openTcp(resolve, reject);
      });
    });
  }

  private _openTcp(
    resolve: (v: VersionInfo) => void,
    reject: (e: Error) => void
  ): void {
    const tcpOpts: net.TcpNetConnectOpts = {
      host: this.opts.host,
      port: this.opts.port,
    };
    if (this.opts.localInterface) tcpOpts.localAddress = this.opts.localInterface;

    const tcp = new net.Socket();
    tcp.setNoDelay(true);
    this.tcp = tcp;
    this.framer.reset();
    this._initialStateParsed = false;
    this._frameCounters = { total: 0, dsp: 0, paramData: 0, routingBlock: 0, fullState: 0, channelInfo: 0 };
    this._meterCombos.clear();

    const timeout = setTimeout(() => {
      tcp.destroy();
      reject(new Error(`Handshake timed out after ${this.opts.connectTimeoutMs}ms`));
    }, this.opts.connectTimeoutMs);

    let step = 0;

    const onFrame = (frame: Frame) => {
      this.emit("frame", frame);

      if (frame.subType === DSP_MARKER) {
        this._emitDsp(frame.payload);
        return;
      }

      switch (step) {
        case 0: // waiting for mixer's sub=0x00 (meter port)
          if (frame.subType === Sub.MeterSub && frame.payload.length >= 2) {
            this.mixerMeterPort = frame.payload.readUInt16LE(0);
            step = 1;
            tcp.write(encodeAck());
          }
          break;

        case 1: // waiting for sub=0x02 (version)
          if (frame.subType === Sub.Version && frame.payload.length >= 4) {
            const model = frame.payload[0];
            const fwA = frame.payload[1];
            const fwB = frame.payload[2];
            this.version = {
              model,
              modelName: modelName(model),
              fwA,
              fwB,
              build:
                frame.payload.length >= 6
                  ? frame.payload.readUInt16LE(4)
                  : undefined,
            };
            step = 2;
            tcp.write(encodeStateAck()); // after version, before init state
          }
          break;

        case 2: // waiting for sub=0x15 (initial state)
          if (frame.subType === Sub.InitState) {
            step = 3;
            tcp.write(encodeTypeReq());
          }
          break;

        case 3: // waiting for sub=0x0C (type response) → fully subscribed
          if (frame.subType === Sub.TypeResp) {
            step = 4;
            tcp.write(encodeSubscribeAll());
            setTimeout(() => tcp.write(encodeSubExtra1()), 40);
            setTimeout(() => tcp.write(encodeSubExtra2()), 80);
            setTimeout(() => tcp.write(encodeSubExtra3()), 120);
            // Trigger the scene-list ChannelInfo dump (matches MixPad behaviour).
            setTimeout(
              () =>
                tcp.write(
                  Buffer.from([0xf7, 0x02, 0x02, 0x20, 0xff, 0xff, 0xff, 0xff])
                ),
              160
            );
            clearTimeout(timeout);
            this._connected = true;
            this._startKeepalive();
            tcp.off("data", handleData);
            tcp.on("data", (c: Buffer) => {
              for (const f of this.framer.push(c)) this._dispatch(f);
            });
            resolve(this.version!);
            this.emit("connect", this.version);
          }
          break;
      }
    };

    const handleData = (chunk: Buffer) => {
      const frames = this.framer.push(chunk);
      for (let i = 0; i < frames.length; i++) {
        if (step >= 4) {
          // Handshake complete — route remaining frames in this chunk through
          // _dispatch instead of dropping them (onFrame ignores non-handshake
          // frames at step 4). This prevents losing initial-flood data that
          // TCP may coalesce into the same segment as the TypeResp.
          for (let j = i; j < frames.length; j++) this._dispatch(frames[j]);
          return;
        }
        onFrame(frames[i]);
      }
    };

    tcp.connect(tcpOpts, () => {
      tcp.write(encodeMeterSub(this.localUdpPort));
      tcp.on("data", handleData);
    });

    tcp.on("close", (hadError) => {
      this._connected = false;
      this._stopKeepalive();
      this.emit("disconnect", hadError);
    });

    tcp.on("error", (err) => {
      clearTimeout(timeout);
      this._connected = false;
      this._stopKeepalive();
      if (!this._connected) reject(err);
      else this.emit("error", err);
    });
  }

  private _emitDsp(payload: Buffer): void {
    if (payload.length < 6) return;
    const d: DspFrame = {
      ch: payload[3],
      category: payload[1],
      register: payload[2],
      modifier: payload[4],
      value: payload.readUInt16LE(5),
      raw: payload,
    };
    this.emit("dsp", d);
  }

  /**
   * Protocol-discovery helper: report the shape of every distinct meter
   * packet once (id + body length + whether it was decoded). Mix / Main-LR
   * levels are expected to live in packets we don't decode yet — this
   * inventory makes them visible in the app log on a real console, so the
   * format can be reverse-engineered from the logged id/length pairs.
   */
  private _noteMeterPacket(msg: Buffer, decoded: boolean): void {
    let key: string;
    let id: number;
    let len: number;
    if (msg.length >= 6 && msg[0] === 0x7f) {
      id = msg[1];
      len = msg.readUInt16LE(2);
      key = `${id}:${len}`;
    } else {
      // Malformed / non-meter packet on the meter port.
      id = -1;
      len = msg.length;
      key = `raw:${len}`;
    }
    if (this._meterCombos.has(key)) return;
    this._meterCombos.add(key);
    this.emit("meterPacketInfo", { id, len, decoded });
  }

  /** Send a raw frame to the mixer. */
  send(frame: Buffer): void {
    if (!this.tcp || !this._connected) throw new Error("Not connected");
    this.tcp.write(frame);
  }

  /**
   * Force the mixer to re-flood its full state (ParamData, ChannelInfo,
   * routing/config block, etc.) by re-sending the "subscribe-all" sequence.
   * This is the proven mechanism to re-request the routing dump on demand.
   * Mirrors the handshake subscription steps 9–10.
   */
  requestFullDump(): void {
    if (!this.tcp || !this._connected) throw new Error("Not connected");
    this.tcp.write(encodeSubscribeAll());
    setTimeout(() => this.tcp && this.tcp.write(encodeSubExtra1()), 40);
    setTimeout(() => this.tcp && this.tcp.write(encodeSubExtra2()), 80);
    setTimeout(() => this.tcp && this.tcp.write(encodeSubExtra3()), 120);
  }

  disconnect(): void {
    this._stopKeepalive();
    this._connected = false;
    resetMeters();
    this.tcp?.destroy();
    this.tcp = null;
    try {
      this.udp?.close();
    } catch {
      /* ignore */
    }
    this.udp = null;
  }

  private _dispatch(frame: Frame): void {
    this.emit("frame", frame);
    this._frameCounters.total++;

    if (frame.subType === DSP_MARKER) {
      this._frameCounters.dsp++;
      this._emitDsp(frame.payload);
      return;
    }

    // Large initial parameter dump — contains channel names, levels, mutes, etc.
    if (frame.subType === Sub.ParamData) {
      this._frameCounters.paramData++;
      this.emit("paramData", frame.payload);
      // Accept any reasonably large ParamData blob (size varies across firmware
      // versions — the original hard-coded 97376 check rejected other builds).
      if (!this._initialStateParsed && frame.payload.length >= 80000) {
        this._initialStateParsed = true;
        this.emit("paramDataSize", frame.payload.length);
        this._parseInitialState(frame.payload);
      }
    }

    // Routing/config block (928 bytes) — capture for the routing view.
    if (frame.subType === Sub.Block16) {
      this._frameCounters.routingBlock++;
      this.emit("routingBlock", frame.payload);
    }

    // FullState (sub=0x0E) — 8200-byte channel/parameter table.
    if (frame.subType === Sub.FullState) {
      this._frameCounters.fullState++;
      this.emit("fullState", frame.payload);
    }

    // ChannelInfo frames (names / scene data).
    if (frame.subType === Sub.ChannelInfo) {
      this._frameCounters.channelInfo++;
      this._parseChannelInfo(frame.payload);
    }

    // End of the initial subscription burst.
    if (frame.subType === Sub.Sync) {
      this.emit("initialState");
    }
  }

  private _parseChannelInfo(payload: Buffer): void {
    // Scene-list format: header [02 02 xx 00 00 00 00], then 18-byte records.
    if (payload.length > 7 && payload[0] === 0x02 && payload[1] === 0x02) {
      const STRIDE = 18;
      const numRecords = Math.floor((payload.length - 7) / STRIDE);
      for (let i = 0; i < numRecords; i++) {
        const off = 7 + i * STRIDE;
        const flag = payload[off];
        const nameEnd = payload.indexOf(0x00, off + 1);
        const end = nameEnd >= 0 && nameEnd < off + 17 ? nameEnd : off + 17;
        const name = payload.slice(off + 1, end).toString("ascii").trimEnd();
        this.emit("sceneName", i, flag !== 0 ? name : null);
      }
      return;
    }
    // Full-state records sent after recall/rename/store:
    //   00 02 18 [sceneId] 40 00 00 [name 16 bytes]
    for (let i = 0; i + 23 < payload.length; i++) {
      if (
        payload[i] === 0x00 &&
        payload[i + 1] === 0x02 &&
        payload[i + 2] === 0x18 &&
        payload[i + 4] === 0x40 &&
        payload[i + 5] === 0x00 &&
        payload[i + 6] === 0x00
      ) {
        const sceneId = payload[i + 3];
        const nameEnd = payload.indexOf(0x00, i + 7);
        const name = payload
          .slice(i + 7, nameEnd < 0 || nameEnd > i + 23 ? i + 23 : nameEnd)
          .toString("ascii")
          .trimEnd();
        if (name) {
          // Full-state record arrives after a recall / rename / store of this
          // scene. Surface it as a distinct "sceneRecall" so higher layers can
          // treat the most recent one as the active scene (heuristic).
          this.emit("sceneName", sceneId, name);
          this.emit("sceneRecall", sceneId, name);
        }
        i += 23;
      }
    }
  }

  /**
   * Parse the 97376-byte ParamData blob. Only the offsets that are confirmed
   * against firmware are decoded (channel names + channel-state events).
   * Everything else is left to higher-level consumers via the 'dsp' events
   * emitted here, which mirror the live-change frame format.
   */
  private _parseInitialState(payload: Buffer): void {
    const dsp = (
      b3: number,
      cat: number,
      reg: number,
      mod: number,
      val: number
    ) =>
      this.emit("dsp", {
        ch: b3,
        category: cat,
        register: reg,
        modifier: mod,
        value: val,
        raw: Buffer.alloc(0),
      } as DspFrame);

    for (let b3 = 0; b3 <= 0x7f; b3++) {
      const blk = 884 + b3 * 336; // 336-byte channel block
      const sec = 43520 + b3 * 300; // 300-byte fader/send section

      if (blk + 336 <= payload.length) {
        // name
        const nameEnd = payload.indexOf(0x00, blk);
        const name = payload
          .slice(
            blk,
            nameEnd < 0 || nameEnd > blk + 16 ? blk + 16 : nameEnd
          )
          .toString("ascii");
        if (name.length > 0) this.emit("channelName", b3, name);

        // Input patch (b3 0x00–0x2f): sourceChannel at offset +24, source type at +26.
        if (b3 <= 0x2f && blk + 27 < payload.length) {
          const srcChannel = payload[blk + 24];
          const source = payload[blk + 26];
          if (source >= 0x01 && source <= 0x04) {
            // Emit a synthetic DSP frame with a proper 7-byte raw payload so
            // handleDsp can decode it into an InputPatch record.
            this.emit("dsp", {
              ch: srcChannel,
              category: 0x0b,
              register: 0x0d,
              modifier: source,
              value: b3 | (0x20 << 8),
              raw: Buffer.from([0x0b, 0x0b, 0x0d, srcChannel, source, b3, 0x20]),
            } as DspFrame);
          }
        }

        if (blk + 333 <= payload.length) {
          const flags = payload[blk + 332]; // bit0=polarity, bit1=mute
          dsp(b3, 0x07, 0x0c, 0x00, (flags >> 1) & 0x01); // mute
        }
      }

      if (sec + 134 <= payload.length) {
        dsp(b3, 0x07, 0x0e, 0x20, payload.readUInt16LE(sec + 96)); // fader
      }
    }

    // ── Stereo-link table ──────────────────────────────────────────────
    // Located at offset 81548 in the ParamData blob: 48 × 4-byte entries.
    //   [u16LE target] [flags] [0xfe]
    // flags 0x0f = mono / left side; flags 0x10 = right side of a stereo pair.
    // When linked, the right channel's `target` points to the left partner's b3.
    const STEREO_TABLE = 81548;
    const STEREO_STRIDE = 4;
    const pairs: number[][] = [];
    for (let b3 = 0; b3 <= 0x2f; b3++) {
      const off = STEREO_TABLE + b3 * STEREO_STRIDE;
      if (off + 4 > payload.length) break;
      const target = payload.readUInt16LE(off);
      const flags = payload[off + 2];
      if (flags === 0x10 && target < b3) {
        pairs.push([target, b3]);
      }
    }
    if (pairs.length > 0) {
      this.emit("stereoPairs", pairs);
    }
  }

  private _startKeepalive(): void {
    this.kaTimer = setInterval(() => {
      if (this._connected && this.tcp) this.tcp.write(encodeKeepalive());
    }, KEEPALIVE_INTERVAL_MS);
    this.kaTimer.unref();
  }

  private _stopKeepalive(): void {
    if (this.kaTimer) {
      clearInterval(this.kaTimer);
      this.kaTimer = null;
    }
  }
}
