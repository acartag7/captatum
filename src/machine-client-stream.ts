import type { AuthAuditEvent, AuditPort } from "mcp-sso";

export interface CliWritable {
  write(chunk: string, callback?: (error?: Error | null) => void): boolean;
  once?(event: "error" | "close", listener: (error?: Error) => void): unknown;
  removeListener?(event: "error" | "close", listener: (error?: Error) => void): unknown;
}

export function stderrAudit(stderr: CliWritable): AuditPort {
  return {
    async writeAuthEvent(event: AuthAuditEvent): Promise<void> {
      await safeWrite(
        stderr,
        `${JSON.stringify({ type: "audit.auth", ...event })}\n`,
      );
    },
  };
}

export async function safeWrite(
  stream: CliWritable,
  chunk: string,
): Promise<boolean> {
  try {
    await writeAndFlush(stream, chunk);
    return true;
  } catch {
    return false;
  }
}

export function writeAndFlush(
  stream: CliWritable,
  chunk: string,
): Promise<void> {
  if (!stream.once || !stream.removeListener) {
    if (stream.write.length >= 2) {
      return new Promise((resolvePromise, rejectPromise) => {
        try {
          const accepted = stream.write(chunk, (error) => {
            if (error) rejectPromise(error);
            else resolvePromise();
          });
          if (!accepted) rejectPromise(new Error("short write"));
        } catch (error) {
          rejectPromise(
            error instanceof Error ? error : new Error("stream write failed"),
          );
        }
      });
    }
    return stream.write(chunk)
      ? Promise.resolve()
      : Promise.reject(new Error("short write"));
  }
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let cleanupScheduled = false;
    const cleanup = (): void => {
      stream.removeListener!("error", onError);
      stream.removeListener!("close", onClose);
    };
    const deferCleanup = (): void => {
      if (cleanupScheduled) return;
      cleanupScheduled = true;
      setImmediate(cleanup);
    };
    const onError = (error?: Error): void => {
      if (settled) {
        cleanup();
        return;
      }
      finish(error ?? new Error("stream write failed"), false);
    };
    const onClose = (): void => {
      if (settled) {
        cleanup();
        return;
      }
      finish(new Error("stream closed before write completed"), false);
    };
    const finish = (
      error?: Error | null,
      callbackSettled = true,
    ): void => {
      if (settled) return;
      settled = true;
      // Node Writable can invoke the write callback with an error and emit the
      // matching `error` event immediately afterward. Keep the listener through
      // this turn so that normal ordering cannot become an uncaught exception.
      if (callbackSettled) deferCleanup();
      else cleanup();
      if (error) rejectPromise(error);
      else resolvePromise();
    };
    stream.once!("error", onError);
    stream.once!("close", onClose);
    try {
      stream.write(chunk, finish);
    } catch (error) {
      finish(error instanceof Error ? error : new Error("stream write failed"));
    }
  });
}
