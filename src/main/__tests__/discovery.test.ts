/**
 * Unit tests for SQ console discovery (CN-C1).
 *
 * Everything runs against a fake SQ TCP server on loopback — no console and no
 * external network are involved. The fake server replays the handshake prefix
 * (meter-sub → ack → version) exactly like transport/connection.ts expects.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as net from "node:net";
import type { NetworkInterfaceInfo } from "node:os";
import {
  expandSubnet,
  probeHost,
  scanNetwork,
  subnetsFromInterfaces,
} from "../discovery";
import { Framer, Sub, encodeFrame } from "../transport/frame";

/**
 * Wrap a server so close() also destroys any still-open connections. A paused
 * server-side socket does not process the client's FIN, so `server.close()`
 * alone would wait forever in tests.
 */
function withTrackedSockets(
  server: net.Server
): Promise<{ port: number; close: () => Promise<void> }> {
  const sockets = new Set<net.Socket>();
  server.on("connection", (sock) => {
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
    sock.on("error", () => {
      /* probe may hang up first */
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as net.AddressInfo;
      resolve({
        port: addr.port,
        close: () =>
          new Promise<void>((done) => {
            for (const s of sockets) s.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}

/** Minimal fake SQ: emits its meter-sub, then version on the app's ack. */
function startFakeSQ(
  versionPayload: Buffer = Buffer.from([0x02, 0x01, 0x09, 0x00, 100, 0])
): Promise<{ port: number; close: () => Promise<void> }> {
  const server = net.createServer((sock) => {
    const framer = new Framer();
    sock.write(encodeFrame(Sub.MeterSub, Buffer.from([0x10, 0x20])));
    sock.on("data", (chunk: Buffer) => {
      for (const frame of framer.push(chunk)) {
        if (frame.subType === Sub.Ack) {
          sock.write(encodeFrame(Sub.Version, versionPayload));
        }
      }
    });
  });
  return withTrackedSockets(server);
}

/** TCP server that accepts and stays silent (never answers the handshake). */
function startSilentServer(): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  return withTrackedSockets(net.createServer(() => undefined));
}

/** A free port with nothing listening on it. */
function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address() as net.AddressInfo;
      const port = addr.port;
      srv.close(() => resolve(port));
    });
  });
}

describe("subnetsFromInterfaces", () => {
  it("keeps external IPv4 /24 prefixes and drops the rest", () => {
    const ifaces: NodeJS.Dict<NetworkInterfaceInfo[]> = {
      lo0: [
        {
          address: "127.0.0.1",
          netmask: "255.0.0.0",
          family: "IPv4",
          mac: "00:00:00:00:00:00",
          internal: true,
          cidr: "127.0.0.1/8",
        },
      ],
      en0: [
        {
          address: "192.168.1.42",
          netmask: "255.255.255.0",
          family: "IPv4",
          mac: "aa:bb:cc:dd:ee:ff",
          internal: false,
          cidr: "192.168.1.42/24",
        },
        {
          address: "fe80::1",
          netmask: "ffff:ffff:ffff:ffff::",
          family: "IPv6",
          mac: "aa:bb:cc:dd:ee:ff",
          internal: false,
          cidr: "fe80::1/64",
          scopeid: 4,
        },
      ],
      en1: [
        {
          address: "192.168.1.7",
          netmask: "255.255.255.0",
          family: "IPv4",
          mac: "aa:bb:cc:dd:ee:00",
          internal: false,
          cidr: "192.168.1.7/24",
        },
        {
          address: "169.254.3.4",
          netmask: "255.255.0.0",
          family: "IPv4",
          mac: "aa:bb:cc:dd:ee:00",
          internal: false,
          cidr: "169.254.3.4/16",
        },
      ],
    };
    assert.deepEqual(subnetsFromInterfaces(ifaces), ["192.168.1"]);
  });

  it("returns an empty list for an empty interface map", () => {
    assert.deepEqual(subnetsFromInterfaces({}), []);
  });
});

describe("expandSubnet", () => {
  it("expands a /24 prefix into .1–.254", () => {
    const hosts = expandSubnet("192.168.1");
    assert.equal(hosts.length, 254);
    assert.equal(hosts[0], "192.168.1.1");
    assert.equal(hosts[253], "192.168.1.254");
  });

  it("accepts an explicit /24 CIDR", () => {
    const hosts = expandSubnet("10.0.0.0/24");
    assert.equal(hosts.length, 254);
    assert.equal(hosts[0], "10.0.0.1");
  });

  it("returns a single host for a full IPv4 address", () => {
    assert.deepEqual(expandSubnet("10.0.0.5"), ["10.0.0.5"]);
  });

  it("rejects malformed input and non-/24 CIDRs", () => {
    assert.deepEqual(expandSubnet(""), []);
    assert.deepEqual(expandSubnet("nope"), []);
    assert.deepEqual(expandSubnet("192.168.1.0/16"), []);
    assert.deepEqual(expandSubnet("999.1.2"), []);
  });
});

describe("probeHost", () => {
  it("identifies a console from the version frame", async () => {
    const sq = await startFakeSQ();
    try {
      const res = await probeHost("127.0.0.1", sq.port, 1000, 0);
      assert.ok(res);
      assert.equal(res?.host, "127.0.0.1");
      assert.equal(res?.model, 0x02);
      assert.equal(res?.modelName, "SQ-6");
      assert.equal(res?.fw, "1.9.100");
    } finally {
      await sq.close();
    }
  });

  it("returns null when the peer never sends a version frame", async () => {
    const silent = await startSilentServer();
    try {
      const res = await probeHost("127.0.0.1", silent.port, 200, 0);
      assert.equal(res, null);
    } finally {
      await silent.close();
    }
  });

  it("returns null for a closed port", async () => {
    const port = await freePort();
    const res = await probeHost("127.0.0.1", port, 300, 0);
    assert.equal(res, null);
  });

  it("returns null immediately when the signal is already aborted", async () => {
    const sq = await startFakeSQ();
    try {
      const ctrl = new AbortController();
      ctrl.abort();
      const res = await probeHost("127.0.0.1", sq.port, 1000, 0, ctrl.signal);
      assert.equal(res, null);
    } finally {
      await sq.close();
    }
  });
});

describe("scanNetwork", () => {
  it("finds a console from an explicit host list and streams it", async () => {
    const sq = await startFakeSQ(Buffer.from([0x03, 0x02, 0x00]));
    const streamed: string[] = [];
    try {
      const outcome = await scanNetwork(
        { hosts: ["127.0.0.1"], port: sq.port, connectTimeoutMs: 800 },
        (c) => streamed.push(c.host)
      );
      assert.equal(outcome.scanned, 1);
      assert.deepEqual(streamed, ["127.0.0.1"]);
      assert.equal(outcome.found.length, 1);
      assert.equal(outcome.found[0].modelName, "SQ-7");
      assert.equal(outcome.found[0].fw, "2.0");
    } finally {
      await sq.close();
    }
  });

  it("reports nothing when an explicit host list is empty/invalid", async () => {
    const outcome = await scanNetwork({ hosts: ["not-an-ip"] });
    assert.equal(outcome.found.length, 0);
    assert.equal(outcome.scanned, 0);
  });

  it("stops early when the signal aborts", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const outcome = await scanNetwork({
      hosts: ["127.0.0.1"],
      connectTimeoutMs: 500,
      signal: ctrl.signal,
    });
    assert.equal(outcome.found.length, 0);
  });
});
