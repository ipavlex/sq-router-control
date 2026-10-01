/**
 * SQ console auto-discovery — local-network scan (CN-C1).
 *
 * A&H SQ consoles expose the binary protocol on TCP :51326. Discovery is a
 * bounded sweep of the local /24 subnet(s): for each candidate host we open a
 * TCP connection and run the *minimal* handshake prefix far enough to read the
 * version frame, which yields the real model (SQ-5/6/7) and firmware.
 *
 * The probe deliberately discards a real console in favour of a strict
 * fingerprint: a host only counts as "found" when it answers the handshake and
 * emits sub=0x02 (version). Nothing but an SQ (or a faithful emulator) does
 * that, so open-but-unrelated ports on :51326 are not reported.
 *
 * No mDNS/Bonjour is used: it would pull in an external dependency and the SQ
 * service type cannot be verified without a live console on the network. The
 * subnet scan needs no console to test — see discovery.test.ts, which drives a
 * fake SQ TCP server.
 *
 * Wire frames are the same ones Connection uses (see transport/frame.ts):
 *   1. App   → [sub=0x00, udpPort]   meter-sub
 *   2. Mixer → [sub=0x00, mixerPort] ack'd with [sub=0x01] from the app
 *   3. Mixer → [sub=0x02, version]   → model/firmware, then we hang up
 */
import * as net from "node:net";
import * as dgram from "node:dgram";
import * as os from "node:os";
import type { NetworkInterfaceInfo } from "node:os";
import { modelName } from "./models";
import { Framer, Sub, encodeAck, encodeMeterSub } from "./transport/frame";

/** TCP port of the SQ binary protocol (same as Connection / MixPad). */
export const SQ_DISCOVERY_PORT = 51326;
/** Parallel in-flight probes. Keeps a /24 sweep at a few seconds. */
export const SQ_DISCOVERY_CONCURRENCY = 32;

export interface DiscoveredConsole {
  host: string;
  port: number;
  /** Raw model byte from the version frame (null if the frame was cut short). */
  model: number | null;
  /** Marketing name (SQ-5 / SQ-6 / SQ-7), or null. */
  modelName: string | null;
  /** "fwA.fwB[.build]", or null. */
  fw: string | null;
}

export interface ScanOptions {
  port?: number;
  /** Explicit /24 prefixes ("192.168.1") to scan instead of the detected ones. */
  subnets?: string[];
  /** Explicit host list (used by tests / advanced callers); overrides subnets. */
  hosts?: string[];
  connectTimeoutMs?: number;
  concurrency?: number;
  signal?: AbortSignal;
}

export interface ScanOutcome {
  found: DiscoveredConsole[];
  /** Number of hosts actually probed. */
  scanned: number;
  /** The subnets that were swept (empty when an explicit host list was used). */
  subnets: string[];
}

/**
 * Derive /24 prefixes (e.g. "192.168.1") from a networkInterfaces() map.
 * Skips loopback, link-local (169.254/16) and non-IPv4 addresses, deduping.
 * Pure — exported for tests.
 */
export function subnetsFromInterfaces(
  ifaces: NodeJS.Dict<NetworkInterfaceInfo[]>
): string[] {
  const out = new Set<string>();
  for (const list of Object.values(ifaces)) {
    if (!list) continue;
    for (const ni of list) {
      if (String(ni.family) !== "IPv4" || ni.internal) continue;
      const ip = ni.address;
      if (ip.startsWith("127.") || ip.startsWith("169.254.")) continue;
      const parts = ip.split(".");
      if (parts.length !== 4) continue;
      out.add(parts.slice(0, 3).join("."));
    }
  }
  return [...out];
}

/** The machine's local /24 prefixes (may be empty on a disconnected host). */
export function localSubnets(): string[] {
  return subnetsFromInterfaces(os.networkInterfaces());
}

/**
 * Expand one subnet spec into candidate hosts. Accepts a /24 prefix
 * ("192.168.1"), an explicit CIDR ("192.168.1.0/24") — only /24 is supported —
 * or a single dotted IPv4 address ("192.168.1.60"). Returns .1–.254 for a
 * prefix; malformed input returns []. Pure — exported for tests.
 */
export function expandSubnet(spec: string): string[] {
  const s = (spec || "").trim();
  if (!s) return [];
  const cidr = s.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\/(\d{1,2})$/);
  if (cidr) {
    if (Number(cidr[2]) !== 24) return [];
    return expandPrefix(cidr[1]);
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) {
    const octets = s.split(".").map(Number);
    if (octets.some((o) => o < 0 || o > 255)) return [];
    return [s];
  }
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(s)) return expandPrefix(s + ".0");
  return [];
}

function expandPrefix(full: string): string[] {
  const octets = full.split(".").map(Number);
  if (octets.length !== 4 || octets.some((o) => o < 0 || o > 255)) return [];
  const prefix = octets.slice(0, 3).join(".");
  const hosts: string[] = [];
  for (let n = 1; n <= 254; n++) hosts.push(`${prefix}.${n}`);
  return hosts;
}

/** True for a syntactically valid dotted IPv4 in 0–255. */
function isIPv4(s: string): boolean {
  return (
    /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(s) &&
    s.split(".").every((p) => Number(p) >= 0 && Number(p) <= 255)
  );
}

/**
 * Probe one host: TCP-connect, send the meter-sub, and wait for the version
 * frame. Resolves null on refusal/timeout/abort or if the peer never emits a
 * version frame (i.e. it is not an SQ). The shared UDP port is only used so the
 * meter-sub payload carries a plausible port; meter datagrams are discarded.
 */
export function probeHost(
  host: string,
  port: number,
  timeoutMs: number,
  udpPort = 0,
  signal?: AbortSignal
): Promise<DiscoveredConsole | null> {
  return new Promise((resolve) => {
    let settled = false;
    const socket = new net.Socket();
    const framer = new Framer();

    const finish = (res: DiscoveredConsole | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      socket.destroy();
      resolve(res);
    };
    const onAbort = (): void => finish(null);
    const timer = setTimeout(() => finish(null), timeoutMs);

    if (signal?.aborted) {
      finish(null);
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });

    socket.setNoDelay(true);
    socket.setTimeout(timeoutMs);
    socket.on("connect", () => socket.write(encodeMeterSub(udpPort)));
    socket.on("data", (chunk: Buffer) => {
      for (const frame of framer.push(chunk)) {
        if (frame.subType === Sub.MeterSub) {
          socket.write(encodeAck());
        } else if (frame.subType === Sub.Version && frame.payload.length >= 3) {
          const model = frame.payload[0];
          const fwA = frame.payload[1];
          const fwB = frame.payload[2];
          const build =
            frame.payload.length >= 6 ? frame.payload.readUInt16LE(4) : undefined;
          finish({
            host,
            port,
            model,
            modelName: modelName(model),
            fw:
              build !== undefined ? `${fwA}.${fwB}.${build}` : `${fwA}.${fwB}`,
          });
          return;
        }
      }
    });
    socket.on("error", () => finish(null));
    socket.on("timeout", () => finish(null));
    socket.connect({ host, port });
  });
}

/**
 * Sweep the local subnet(s) for SQ consoles. Streams each hit through
 * `onFound` as it is discovered and resolves with the full outcome once every
 * candidate has been probed (or the signal aborts).
 */
export async function scanNetwork(
  opts: ScanOptions = {},
  onFound?: (c: DiscoveredConsole) => void
): Promise<ScanOutcome> {
  const port = opts.port ?? SQ_DISCOVERY_PORT;
  const timeoutMs = opts.connectTimeoutMs ?? 600;
  const concurrency = Math.max(1, opts.concurrency ?? SQ_DISCOVERY_CONCURRENCY);
  const signal = opts.signal;

  let hosts: string[];
  let subnets: string[];
  if (opts.hosts && opts.hosts.length) {
    subnets = [];
    hosts = [...new Set(opts.hosts.filter(isIPv4))];
  } else {
    subnets = (opts.subnets && opts.subnets.length
      ? opts.subnets
      : localSubnets()
    ).filter((s) => s);
    hosts = [...new Set(subnets.flatMap(expandSubnet))];
  }

  if (!hosts.length || signal?.aborted) {
    return { found: [], scanned: 0, subnets };
  }

  // One UDP socket for the whole sweep: the mixer echoes the port in its
  // meter-sub and would stream meters here; we ignore the payloads.
  const udp = dgram.createSocket("udp4");
  const udpPort = await new Promise<number>((resolve) => {
    udp.on("error", () => resolve(0));
    udp.on("message", () => {
      /* meter datagrams during the sweep — intentionally discarded */
    });
    udp.bind(0, () => {
      const a = udp.address() as { port?: number } | null;
      resolve(a?.port ?? 0);
    });
  });

  const found: DiscoveredConsole[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (signal?.aborted) return;
      const index = next++;
      if (index >= hosts.length) return;
      const res = await probeHost(hosts[index], port, timeoutMs, udpPort, signal);
      if (res) {
        found.push(res);
        onFound?.(res);
      }
    }
  };

  try {
    await Promise.all(
      Array.from({ length: Math.min(concurrency, hosts.length) }, () => worker())
    );
  } finally {
    try {
      udp.close();
    } catch {
      /* already closed */
    }
  }

  return { found, scanned: hosts.length, subnets };
}
