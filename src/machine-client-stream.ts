import type { AuthAuditEvent, AuditPort } from "mcp-sso";

export interface CliWritable {
  write(chunk: string, callback?: (error?: Error | null) => void): boolean;
  once?(event: "error", listener: (error: Error) => void): unknown;
  removeListener?(event: "error", listener: (error: Error) => void): unknown;
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
    return stream.write(chunk)
      ? Promise.resolve()
      : Promise.reject(new Error("short write"));
  }
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const onError = (error: Error): void => finish(error);
    const finish = (error?: Error | null): void => {
      if (settled) return;
      settled = true;
      stream.removeListener!("error", onError);
      if (error) rejectPromise(error);
      else resolvePromise();
    };
    stream.once!("error", onError);
    try {
      stream.write(chunk, finish);
    } catch (error) {
      finish(error instanceof Error ? error : new Error("stream write failed"));
    }
  });
}
