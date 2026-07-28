import assert from "node:assert/strict";
import { once } from "node:events";
import { connect, createServer, type Server } from "node:net";
import { test } from "node:test";

import {
  createCdpRelay,
  productionRelayOptions,
} from "../scripts/browser-cdp-relay.mjs";

test("production CDP relay has one fixed bounded target", () => {
  assert.deepEqual(productionRelayOptions, {
    listenHost: "0.0.0.0",
    listenPort: 9223,
    targetHost: "127.0.0.1",
    targetPort: 9222,
    maxConnections: 32,
  });
  assert.equal(Object.isFrozen(productionRelayOptions), true);
});

test("CDP relay forwards bytes to loopback and back", async () => {
  const upstream = createServer((socket) => socket.pipe(socket));
  const targetPort = await listen(upstream);
  const relay = createCdpRelay({
    listenHost: "127.0.0.1",
    listenPort: 0,
    targetHost: "127.0.0.1",
    targetPort,
    maxConnections: 2,
  });
  const relayPort = await listen(relay);
  try {
    const response = await roundTrip(relayPort, "cdp-probe");
    assert.equal(response, "cdp-probe");
  } finally {
    await close(relay);
    await close(upstream);
  }
});

test("CDP relay rejects connections beyond its hard cap", async () => {
  let upstreamConnections = 0;
  const upstream = createServer(() => { upstreamConnections += 1; });
  const targetPort = await listen(upstream);
  const relay = createCdpRelay({
    listenHost: "127.0.0.1",
    listenPort: 0,
    targetHost: "127.0.0.1",
    targetPort,
    maxConnections: 1,
  });
  const relayPort = await listen(relay);
  const firstUpstream = once(upstream, "connection");
  const first = connect({ host: "127.0.0.1", port: relayPort });
  try {
    await once(first, "connect");
    await firstUpstream;
    const second = connect({ host: "127.0.0.1", port: relayPort });
    second.on("error", () => {});
    await once(second, "close");
    assert.equal(upstreamConnections, 1);
  } finally {
    first.destroy();
    await close(relay);
    await close(upstream);
  }
});

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("test listener has no TCP address"));
        return;
      }
      resolve(address.port);
    });
  });
}

function roundTrip(port: number, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port }, () => {
      socket.end(input);
    });
    let output = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => { output += chunk; });
    socket.once("end", () => resolve(output));
    socket.once("error", reject);
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
