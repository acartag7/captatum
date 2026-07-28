import { randomBytes } from "node:crypto";
import { PROXY_AUTH_HEADER } from "../../src/interfaces/http/proxy-auth.ts";

export const TEST_PROXY_AUTH_SECRET = randomBytes(32).toString("base64url");

export function authenticatedForwardingHeaders(
  forwardedFor: string,
): Record<string, string> {
  return {
    [PROXY_AUTH_HEADER]: TEST_PROXY_AUTH_SECRET,
    "x-forwarded-for": forwardedFor,
  };
}
