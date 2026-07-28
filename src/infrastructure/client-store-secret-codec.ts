import type { ActiveClientSecrets } from "mcp-sso";
import {
  asRecord,
  assertEpoch,
  assertExactKeys,
} from "./client-store-codec-guards.ts";

const SHA256_HEX = /^[0-9a-f]{64}$/;

export function assertSecrets(
  value: unknown,
  status: "active" | "disabled",
): ActiveClientSecrets | [] {
  if (!Array.isArray(value)) {
    throw new Error("Stored machine client secrets are invalid");
  }
  if (status === "disabled") {
    if (value.length !== 0) {
      throw new Error("Stored disabled machine client contains secrets");
    }
    return [];
  }
  if (value.length < 1 || value.length > 2) {
    throw new Error("Stored machine client secrets are invalid");
  }
  const secrets = value.map((entry) => {
    const secret = asRecord(entry, "stored client secret");
    assertExactKeys(secret, ["hash", "createdAtEpoch"], ["expiresAtEpoch"]);
    if (typeof secret.hash !== "string" || !SHA256_HEX.test(secret.hash)) {
      throw new Error("Stored machine client secret hash is invalid");
    }
    assertEpoch(secret.createdAtEpoch, "createdAtEpoch");
    if (secret.expiresAtEpoch !== undefined) {
      assertEpoch(secret.expiresAtEpoch, "expiresAtEpoch");
      if (secret.expiresAtEpoch <= secret.createdAtEpoch) {
        throw new Error("Stored machine client secret expiry is invalid");
      }
    }
    return {
      hash: secret.hash,
      createdAtEpoch: secret.createdAtEpoch,
      ...(secret.expiresAtEpoch === undefined
        ? {}
        : { expiresAtEpoch: secret.expiresAtEpoch }),
    };
  });
  if (new Set(secrets.map((secret) => secret.hash)).size !== secrets.length) {
    throw new Error("Stored machine client secret hashes contain duplicates");
  }
  if (
    secrets.length === 2
    && secrets.filter((secret) => secret.expiresAtEpoch === undefined).length !== 1
  ) {
    throw new Error("Stored machine client must have exactly one live secret");
  }
  return secrets as ActiveClientSecrets;
}
