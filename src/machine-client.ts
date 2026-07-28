import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  OAuthError,
  disableMachineClient,
  provisionMachineClient,
  rotateMachineClientSecret,
  type ClockPort,
} from "mcp-sso";
import { OAUTH_SCOPES } from "./application/scopes.ts";
import {
  createHostedAuthStore,
  resolveHostedStoreConfig,
  type HostedAuthStore,
} from "./infrastructure/auth-store.ts";
import {
  safeWrite,
  stderrAudit,
  writeAndFlush,
  type CliWritable,
} from "./machine-client-stream.ts";
import { disableExactCredentialVersion } from "./machine-client-compensation.ts";

const MACHINE_CLIENT_ID = /^mcc_[A-Za-z0-9_-]{1,200}$/;
const SCOPE_TOKEN = /^[\x21\x23-\x5B\x5D-\x7E]+$/;
const MAX_NAME_LENGTH = 255;
const DEFAULT_ROTATION_GRACE_SECONDS = 300;
const MAX_ROTATION_GRACE_SECONDS = 600;

export type MachineClientCommand =
  | { action: "provision"; name: string; scopes: string[] }
  | { action: "rotate"; clientId: string; graceSeconds: number }
  | { action: "disable"; clientId: string }
  | { action: "list" };

export interface MachineClientCliOptions {
  env?: NodeJS.ProcessEnv;
  stdout?: CliWritable;
  stderr?: CliWritable;
  clock?: ClockPort;
  openStores?: typeof createHostedAuthStore;
}

export function parseMachineClientArgs(args: string[]): MachineClientCommand {
  const argv = args[0] === "--" ? args.slice(1) : args;
  const action = argv[0];
  if (action === "provision") {
    if (argv.length < 3) throw new Error("usage: provision <name> <scope...>");
    const name = argv[1];
    if (!name || name.trim() !== name || name.length > MAX_NAME_LENGTH) {
      throw new Error("provision name must be a non-empty argument of at most 255 characters");
    }
    const scopes = argv.slice(2);
    for (const scope of scopes) {
      if (
        !SCOPE_TOKEN.test(scope)
        || !OAUTH_SCOPES.includes(scope as (typeof OAUTH_SCOPES)[number])
      ) throw new Error("provision scopes must be a subset of the Captatum scope catalog");
    }
    if (new Set(scopes).size !== scopes.length) {
      throw new Error("provision scopes must not contain duplicates");
    }
    return { action, name, scopes };
  }
  if (action === "rotate") {
    if (argv.length !== 2 && argv.length !== 3) {
      throw new Error("usage: rotate <clientId> [graceSeconds]");
    }
    const clientId = machineClientId(argv[1], "rotate");
    const graceSeconds = argv[2] === undefined
      ? DEFAULT_ROTATION_GRACE_SECONDS
      : parseGraceSeconds(argv[2]);
    return {
      action,
      clientId,
      graceSeconds,
    };
  }
  if (action === "disable") {
    if (argv.length !== 2) throw new Error("usage: disable <clientId>");
    return { action, clientId: machineClientId(argv[1], "disable") };
  }
  if (action === "list" && argv.length === 1) return { action };
  throw new Error(
    "usage: provision <name> <scope...> | rotate <clientId> [graceSeconds] | disable <clientId> | list",
  );
}

export async function runMachineClientCli(
  args: string[],
  options: MachineClientCliOptions = {},
): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  let stores: HostedAuthStore | undefined;
  try {
    const command = parseMachineClientArgs(args);
    const selected = resolveHostedStoreConfig(options.env ?? process.env);
    stores = await (options.openStores ?? createHostedAuthStore)(selected);
    await safeWrite(stderr, "captatum machine-client store: sqlite\n");
    const clock = options.clock ?? { nowMs: () => Date.now() };
    const deps = {
      store: stores.clientStore,
      catalog: OAUTH_SCOPES,
      clock,
      audit: stderrAudit(stderr),
    };
    const output = await executeCommand(command, deps, stores);
    try {
      await writeAndFlush(stdout, `${JSON.stringify(output.value)}\n`);
    } catch {
      if (output.kind === "credential") {
        const disabled = await disableAfterOutputFailure(
          deps,
          output.clientId,
          output.version,
          stderr,
        );
        await closeAfterFailure(stores, stderr);
        stores = undefined;
        return disabled ? 1 : 2;
      }
      await safeWrite(stderr, "captatum machine-client: output_failed\n");
      return 1;
    }
    try {
      await stores.close();
    } catch {
      stores = undefined;
      await safeWrite(
        stderr,
        "captatum machine-client: credential_or_result_emitted; close_failed\n",
      );
      return 1;
    }
    stores = undefined;
    return 0;
  } catch (error) {
    await safeWrite(stderr, `captatum machine-client: ${cliErrorCode(error)}\n`);
    return 1;
  } finally {
    if (stores) await closeAfterFailure(stores, stderr);
  }
}

async function executeCommand(
  command: MachineClientCommand,
  deps: Parameters<typeof provisionMachineClient>[0],
  stores: HostedAuthStore,
): Promise<
  { kind: "credential"; value: unknown; clientId: string; version: number }
  | { kind: "result"; value: unknown }
> {
  if (command.action === "provision") {
    const value = await provisionMachineClient(deps, {
      name: command.name,
      allowedScopes: command.scopes,
    });
    return {
      kind: "credential",
      value,
      clientId: value.clientId,
      version: 1,
    };
  }
  if (command.action === "rotate") {
    const value = await rotateMachineClientSecret(
      deps,
      command.clientId,
      { graceSeconds: command.graceSeconds },
    );
    return {
      kind: "credential",
      value,
      clientId: command.clientId,
      version: value.version,
    };
  }
  if (command.action === "disable") {
    return { kind: "result", value: await disableMachineClient(deps, command.clientId) };
  }
  return { kind: "result", value: await stores.clientStore.listMachineClients() };
}

async function disableAfterOutputFailure(
  deps: Parameters<typeof disableMachineClient>[0],
  clientId: string,
  credentialVersion: number,
  stderr: CliWritable,
): Promise<boolean> {
  try {
    if (!await disableExactCredentialVersion(
      deps,
      clientId,
      credentialVersion,
    )) throw new Error("credential version changed");
    await safeWrite(
      stderr,
      "captatum machine-client: credential_output_failed; client_disabled\n",
    );
    return true;
  } catch {
    await safeWrite(
      stderr,
      "captatum machine-client: credential_output_failed; disable_failed; run_list_then_disable\n",
    );
    return false;
  }
}

async function closeAfterFailure(
  stores: HostedAuthStore,
  stderr: CliWritable,
): Promise<void> {
  try {
    await stores.close();
  } catch {
    await safeWrite(stderr, "captatum machine-client: close_failed\n");
  }
}

function machineClientId(value: string | undefined, action: string): string {
  if (!value || !MACHINE_CLIENT_ID.test(value)) {
    throw new Error(`${action} clientId must be a machine client id`);
  }
  return value;
}
function parseGraceSeconds(value: string): number {
  if (!/^[0-9]+$/.test(value)) {
    throw new Error("graceSeconds must be a positive decimal integer");
  }
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed)
    || parsed < 1
    || parsed > MAX_ROTATION_GRACE_SECONDS
  ) throw new Error(`graceSeconds must be in [1, ${MAX_ROTATION_GRACE_SECONDS}]`);
  return parsed;
}

function cliErrorCode(error: unknown): string {
  if (error instanceof OAuthError) return `oauth_${error.code}`;
  if (error instanceof Error && error.message.startsWith("usage:")) return "invalid_usage";
  return "operation_failed";
}
const invokedPath = process.argv[1];
if (
  invokedPath
  && import.meta.url === pathToFileURL(resolve(invokedPath)).href
) process.exitCode = await runMachineClientCli(process.argv.slice(2));
