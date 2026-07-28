#!/usr/bin/env node

import { createServer, connect } from "node:net";
import { pathToFileURL } from "node:url";

export const productionRelayOptions = Object.freeze({
  listenHost: "0.0.0.0",
  listenPort: 9223,
  targetHost: "127.0.0.1",
  targetPort: 9222,
  maxConnections: 32,
});

export function createCdpRelay(options = productionRelayOptions) {
  let activeConnections = 0;
  const server = createServer({ allowHalfOpen: true }, (client) => {
    if (activeConnections >= options.maxConnections) {
      client.destroy();
      return;
    }
    activeConnections += 1;
    const upstream = connect({
      host: options.targetHost,
      port: options.targetPort,
    });
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      activeConnections -= 1;
      upstream.destroy();
    };
    client.once("close", release);
    client.once("error", () => upstream.destroy());
    upstream.once("error", () => client.destroy());
    client.pipe(upstream);
    upstream.pipe(client);
  });
  return server;
}

function main() {
  const server = createCdpRelay();
  server.once("error", () => {
    process.stderr.write("browser-cdp-relay: listener failure\n");
    process.exitCode = 1;
  });
  server.listen({
    host: productionRelayOptions.listenHost,
    port: productionRelayOptions.listenPort,
  });
  const close = () => server.close();
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  main();
}
