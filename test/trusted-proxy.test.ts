import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import Fastify from "fastify";
import {
  parseProxyAuthSecret,
  parseTrustedProxyCidrs,
} from "../src/domain/trusted-proxy.ts";
import {
  authenticateProxyHeaders,
  PROXY_AUTH_HEADER,
} from "../src/interfaces/http/proxy-auth.ts";

test("trusted proxy parser accepts only a bounded unique IP/CIDR allowlist", () => {
  assert.deepEqual(
    parseTrustedProxyCidrs("127.0.0.1/32, ::1/128, 192.0.2.10"),
    ["127.0.0.1/32", "::1/128", "192.0.2.10"],
  );
  for (const raw of [
    "", " ", "loopback", "*", "127.0.0.1,", "127.0.0.1/33",
    "::1/129", "127.0.0.1/-1", "127.0.0.1/1e1",
    "0.0.0.0/0", "10.0.0.0/8", "::/0", "2001:db8::/63",
    "127.0.0.1/32/1", "127.0.0.1,127.0.0.1",
  ]) {
    assert.throws(
      () => parseTrustedProxyCidrs(raw),
      /CAPTATUM_TRUSTED_PROXY_CIDRS/,
      raw,
    );
  }
});

test("trusted proxy parser caps configured peers", () => {
  const entries = Array.from(
    { length: 33 },
    (_, index) => `192.0.2.${index + 1}`,
  );
  assert.throws(
    () => parseTrustedProxyCidrs(entries.join(",")),
    /CAPTATUM_TRUSTED_PROXY_CIDRS/,
  );
});

test("proxy authenticator is a strict 32-byte base64url value", () => {
  const secret = randomBytes(32).toString("base64url");
  assert.equal(parseProxyAuthSecret(secret), secret);
  for (const raw of [
    "", " ", randomBytes(31).toString("base64url"),
    randomBytes(33).toString("base64url"), `${secret}=`, `${secret}\n`,
  ]) {
    assert.throws(
      () => parseProxyAuthSecret(raw),
      /CAPTATUM_PROXY_AUTH_SECRET/,
    );
  }
});

test("forwarding headers require the edge secret and are stripped on rejection", () => {
  const secret = randomBytes(32).toString("base64url");
  const direct = {};
  assert.equal(authenticateProxyHeaders(direct, {}, [], secret), "direct");

  const accepted = {
    [PROXY_AUTH_HEADER]: secret,
    "x-forwarded-for": "198.51.100.1",
  };
  const acceptedRaw = [
    "X-Captatum-Proxy-Auth", secret,
    "X-Forwarded-For", "198.51.100.1",
  ];
  assert.equal(
    authenticateProxyHeaders(
      accepted,
      {
        [PROXY_AUTH_HEADER]: [secret],
        "x-forwarded-for": ["198.51.100.1"],
      },
      acceptedRaw,
      secret,
    ),
    "authenticated",
  );
  assert.equal(accepted[PROXY_AUTH_HEADER], undefined);
  assert.equal(accepted["x-forwarded-for"], "198.51.100.1");
  assert.deepEqual(acceptedRaw, ["X-Forwarded-For", "198.51.100.1"]);

  for (const supplied of [
    undefined,
    randomBytes(32).toString("base64url"),
    [secret, secret],
  ]) {
    const rejected: Record<string, string | string[] | undefined> = {
      [PROXY_AUTH_HEADER]: supplied,
      "x-forwarded-for": "203.0.113.1",
      "cf-connecting-ip": "203.0.113.1",
    };
    const raw = [
      "X-Captatum-Proxy-Auth", String(supplied),
      "X-Forwarded-For", "203.0.113.1",
      "CF-Connecting-IP", "203.0.113.1",
    ];
    const distinct = {
      [PROXY_AUTH_HEADER]: [String(supplied)],
      "x-forwarded-for": ["203.0.113.1"],
      "cf-connecting-ip": ["203.0.113.1"],
    };
    assert.equal(
      authenticateProxyHeaders(rejected, distinct, raw, secret),
      "reject",
    );
    assert.equal(rejected[PROXY_AUTH_HEADER], undefined);
    assert.equal(rejected["x-forwarded-for"], undefined);
    assert.equal(rejected["cf-connecting-ip"], undefined);
    assert.deepEqual(distinct, {});
    assert.deepEqual(raw, []);
  }
});

test("every framework forwarding authority requires proxy authentication", () => {
  const secret = randomBytes(32).toString("base64url");
  for (const [name, value] of [
    ["forwarded", "for=198.51.100.1"],
    ["x-forwarded-for", "198.51.100.1"],
    ["x-forwarded-host", "attacker.example"],
    ["x-forwarded-proto", "javascript"],
    ["x-forwarded-port", "31337"],
    ["x-real-ip", "198.51.100.1"],
    ["cf-connecting-ip", "198.51.100.1"],
  ]) {
    const headers = { [name]: value };
    const distinct = { [name]: [value] };
    const raw = [name, value];
    assert.equal(
      authenticateProxyHeaders(headers, distinct, raw, secret),
      "reject",
    );
    assert.deepEqual(headers, {});
    assert.deepEqual(distinct, {});
    assert.deepEqual(raw, []);
  }
});

test("proxy secret is erased from parsed and raw Node header views", async (t) => {
  const secret = randomBytes(32).toString("base64url");
  const app = Fastify();
  t.after(() => app.close());
  app.addHook("onRequest", async (request) => {
    authenticateProxyHeaders(
      request.headers,
      request.raw.headersDistinct,
      request.raw.rawHeaders,
      secret,
    );
  });
  app.get("/", async (request) => ({
    parsed: Object.hasOwn(request.headers, PROXY_AUTH_HEADER),
    distinct: Object.hasOwn(
      request.raw.headersDistinct ?? {},
      PROXY_AUTH_HEADER,
    ),
    raw: request.raw.rawHeaders.some(
      (value, index) =>
        index % 2 === 0 && value.toLowerCase() === PROXY_AUTH_HEADER,
    ),
  }));
  await app.listen({ host: "127.0.0.1", port: 0 });
  const response = await fetch(`${app.listeningOrigin}/`, {
    headers: {
      [PROXY_AUTH_HEADER]: secret,
      "x-forwarded-for": "198.51.100.1",
    },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    parsed: false,
    distinct: false,
    raw: false,
  });
});
