import { startHostedServer, type HostedServerRuntime } from "./server-runtime.ts";

export { startHostedServer, type HostedServerRuntime } from "./server-runtime.ts";

if (import.meta.main) {
  const runtime = await startHostedServer();
  installSignalHandlers(runtime);
}

function installSignalHandlers(runtime: HostedServerRuntime): void {
  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await runtime.close();
    } catch {
      process.stderr.write("captatum: shutdown_failed\n");
    }
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}
