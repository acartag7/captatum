import {
  accessSync,
  chmodSync,
  constants,
  lstatSync,
  mkdirSync,
  statSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

export interface SqliteStorePaths {
  stateDirectory: string;
  authFilename: string;
  clientFilename: string;
}

export function resolveSqliteStorePaths(configuredPath: string): SqliteStorePaths {
  if (configuredPath === ":memory:") {
    return { stateDirectory: ":memory:", authFilename: ":memory:", clientFilename: ":memory:" };
  }
  if (configuredPath.startsWith("file:")) {
    throw new Error("CAPTATUM_SQLITE_PATH must be a filesystem path, not a SQLite URI name");
  }
  const authFilename = resolve(configuredPath);
  const paths = {
    stateDirectory: dirname(authFilename),
    authFilename,
    clientFilename: `${authFilename}.clients`,
  };
  validateSqliteStorePaths(paths);
  return paths;
}

/** Read-only trust checks. Call before any mkdir/database side effect. */
export function validateSqliteStorePaths(paths: SqliteStorePaths): void {
  if (isMemory(paths)) return;
  if ([paths.stateDirectory, paths.authFilename, paths.clientFilename].some((value) => value.startsWith("file:"))) {
    throw new Error("SQLite state paths must be filesystem paths, not SQLite URI names");
  }
  const stateDirectory = resolve(paths.stateDirectory);
  const authFilename = resolve(paths.authFilename);
  const clientFilename = resolve(paths.clientFilename);
  if (dirname(authFilename) !== stateDirectory || dirname(clientFilename) !== stateDirectory) {
    throw new Error("Both SQLite stores must be direct children of the Captatum state directory");
  }
  if (authFilename === clientFilename) throw new Error("OAuth and client SQLite paths must be different files");
  assertExistingDirectoryComponents(stateDirectory);
  assertExistingStoreFile(authFilename, "OAuth SQLite file");
  assertExistingStoreFile(clientFilename, "client SQLite file");
  assertDifferentInodesWhenPresent(authFilename, clientFilename);
}

export function prepareSqliteStateDirectory(paths: SqliteStorePaths): void {
  if (isMemory(paths)) return;
  validateSqliteStorePaths(paths);
  const missing = missingDirectories(paths.stateDirectory);
  for (const directory of missing.reverse()) {
    try {
      mkdirSync(directory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    assertDirectory(directory);
    chmodSync(directory, 0o700);
  }
  assertExistingDirectoryComponents(paths.stateDirectory);
  assertPrivateStateDirectory(paths.stateDirectory);
  accessSync(paths.stateDirectory, constants.R_OK | constants.W_OK | constants.X_OK);
}

/** Defense-in-depth re-check after node:sqlite has opened both files. */
export function verifyOpenedSqliteFiles(paths: SqliteStorePaths): void {
  if (isMemory(paths)) return;
  assertPrivateStateDirectory(paths.stateDirectory);
  assertOpenedStoreFile(paths.authFilename, "OAuth SQLite file");
  assertOpenedStoreFile(paths.clientFilename, "client SQLite file");
  assertDifferentInodesWhenPresent(paths.authFilename, paths.clientFilename);
}

function isMemory(paths: SqliteStorePaths): boolean {
  const values = [paths.stateDirectory, paths.authFilename, paths.clientFilename];
  const memoryCount = values.filter((value) => value === ":memory:").length;
  if (memoryCount !== 0 && memoryCount !== values.length) {
    throw new Error("SQLite test mode requires both stores and the state directory to use :memory:");
  }
  return memoryCount === values.length;
}

function assertExistingDirectoryComponents(directory: string): void {
  const components = pathComponents(resolve(directory));
  for (const component of components) {
    let stat;
    try {
      stat = lstatSync(component);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error(`SQLite state path component must not be a symlink: ${component}`);
    if (!stat.isDirectory()) throw new Error(`SQLite state path component must be a directory: ${component}`);
  }
  assertPrivateStateDirectory(directory);
}

function assertPrivateStateDirectory(directory: string): void {
  let stat;
  try {
    stat = lstatSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("Captatum SQLite state directory must be a real directory");
  }
  assertOwnedByProcess(stat, "Captatum SQLite state directory");
  if ((stat.mode & 0o777) !== 0o700) {
    throw new Error("Captatum SQLite state directory must have mode 0700");
  }
}

function assertExistingStoreFile(filename: string, label: string): void {
  let stat;
  try {
    stat = lstatSync(filename);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (stat.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`);
  if (!stat.isFile()) throw new Error(`${label} must be a regular file`);
  assertOwnedByProcess(stat, label);
  if ((stat.mode & 0o777) !== 0o600) throw new Error(`${label} must have mode 0600`);
}

function assertOpenedStoreFile(filename: string, label: string): void {
  const stat = lstatSync(filename);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} must be a regular non-symlink file`);
  assertOwnedByProcess(stat, label);
  if ((stat.mode & 0o777) !== 0o600) throw new Error(`${label} must have mode 0600`);
}

function assertDifferentInodesWhenPresent(authFilename: string, clientFilename: string): void {
  try {
    const auth = statSync(authFilename);
    const client = statSync(clientFilename);
    if (auth.dev === client.dev && auth.ino === client.ino) {
      throw new Error("OAuth and client SQLite files must not resolve to the same inode");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function missingDirectories(directory: string): string[] {
  const missing: string[] = [];
  let current = resolve(directory);
  while (true) {
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) throw new Error(`SQLite state path component must not be a symlink: ${current}`);
      if (!stat.isDirectory()) throw new Error(`SQLite state path component must be a directory: ${current}`);
      return missing;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      missing.push(current);
      const parent = dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

function pathComponents(path: string): string[] {
  const out: string[] = [];
  let current = path;
  while (true) {
    out.push(current);
    const parent = dirname(current);
    if (parent === current) return out.reverse();
    current = parent;
  }
}

function assertDirectory(directory: string): void {
  const stat = lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Created SQLite state path component is not a real directory: ${directory}`);
  }
}

function assertOwnedByProcess(
  stat: NonNullable<ReturnType<typeof lstatSync>>,
  label: string,
): void {
  if (process.platform === "win32") return;
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined) {
    throw new Error(`${label} ownership cannot be verified`);
  }
  if (stat.uid !== uid || stat.gid !== gid) {
    throw new Error(`${label} must be owned by the gateway UID/GID`);
  }
}
