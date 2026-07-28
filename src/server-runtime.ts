import { Bridge, RequestAuthorizer, type IdentityPort } from "mcp-sso";
import { createCloudflareAccessIdentity } from "mcp-sso/identity/cloudflare-access";
import type {
  AuditLoggerPort,
  AuthAuditEvent,
  ToolAuditEvent,
} from "./application/ports/audit.ts";
import type { ClockPort } from "./application/ports/clock.ts";
import type { FetcherPort } from "./application/ports/fetcher.ts";
import type { RenderPort } from "./application/ports/renderer.ts";
import type { TransformPort } from "./application/ports/transformer.ts";
import { createAdapterRegistry } from "./application/adapters.ts";
import { createMcpSsoConfig, loadCaptatumAuth } from "./application/mcp-sso-config.ts";
import { InMemoryBulkQuotaPort } from "./application/use-cases/in-memory-bulk-quota.ts";
import { createCaptatumUseCase } from "./application/use-cases/captatum.ts";
import { createCaptatumBulkUseCase } from "./application/use-cases/captatum-bulk.ts";
import { config } from "./config.ts";
import {
  createHostedAuthStore,
  resolveHostedStoreConfig,
  type HostedAuthStore,
} from "./infrastructure/auth-store.ts";
import { extractHtml } from "./infrastructure/extract/index.ts";
import { LimitingFetcher } from "./infrastructure/http/limiting-fetcher.ts";
import { InMemoryAuthRateLimit } from "./infrastructure/in-memory-auth-rate-limit.ts";
import { createDefaultLlmTransformer } from "./infrastructure/llm/model-router.ts";
import { createRenderer } from "./infrastructure/render/index.ts";
import { createWreqGuardedFetcher } from "./infrastructure/wreq/requester.ts";
import { assertHostedFlavor, createHttpApp } from "./interfaces/http/app.ts";

export interface StartHostedServerOptions {
  host?: string;
  port?: number;
  clock?: ClockPort;
  audit?: AuditLoggerPort;
  fetcher?: FetcherPort;
  transformer?: TransformPort | null;
  renderer?: RenderPort | null;
  identity?: IdentityPort;
  log?: (message: string) => void;
}

export interface HostedServerRuntime {
  app: Awaited<ReturnType<typeof createHttpApp>>;
  stores: HostedAuthStore;
  close(): Promise<void>;
}

const productionClock: ClockPort = { nowMs: () => Date.now() };
const productionAudit: AuditLoggerPort = {
  async writeAuthEvent(event: AuthAuditEvent): Promise<void> {
    console.log(JSON.stringify({ type: "audit.auth", ...event }));
  },
  async writeToolEvent(event: ToolAuditEvent): Promise<void> {
    console.log(JSON.stringify({ type: "audit.tool", ...event }));
  },
};

export async function startHostedServer(
  options: StartHostedServerOptions = {},
): Promise<HostedServerRuntime> {
  const boot = await resolveBoot(options);
  const stores = await createHostedAuthStore(boot.selectedStore, {
    redirectAllowlist: boot.material.redirectAllowlist,
    scopeCatalog: boot.material.scopeCatalog,
  });
  let app: Awaited<ReturnType<typeof createHttpApp>> | undefined;
  try {
    const oauthConfig = createMcpSsoConfig(boot.material, stores.clientStore);
    const bridge = new Bridge({
      config: oauthConfig,
      store: stores.store,
      clock: boot.clock,
      audit: boot.audit,
      rateLimit: new InMemoryAuthRateLimit(boot.clock),
    });
    app = await createHttpApp({
      captatum: boot.captatum,
      ...(boot.bulk !== undefined ? { bulk: boot.bulk } : {}),
      flavor: boot.auth.flavor,
      bridge,
      authorizer: new RequestAuthorizer({
        config: oauthConfig,
        clock: boot.clock,
        audit: boot.audit,
      }),
      identity: boot.identity,
      clock: boot.clock,
      audit: boot.audit,
      ...boot.security,
    });
    await app.listen({ host: boot.host, port: boot.port });
    boot.log(`captatum OAuth/client store: ${stores.backend}`);
    boot.log(`captatum server listening on ${app.listeningOrigin}`);
    return ownedRuntime(app, stores);
  } catch (error) {
    try { await closeResources(app, stores); } catch { /* preserve boot failure */ }
    throw error;
  }
}

async function resolveBoot(options: StartHostedServerOptions) {
  const auth = loadCaptatumAuth();
  assertHostedFlavor(auth.flavor);
  const material = auth.material;
  if (!material) throw new Error("hosted flavor requires validated OAuth material");
  const host = options.host ?? config.http.host();
  const port = options.port ?? config.http.port();
  const security = mcpSecurity(host, port);
  const cdpEndpoint = config.render.cdpEndpoint();
  const selectedStore = resolveHostedStoreConfig();
  const clock = options.clock ?? productionClock;
  const audit = options.audit ?? productionAudit;
  const identity = options.identity ?? createCloudflareAccessIdentity({
    audience: config.cloudflareAccess.audience(),
    certsUrl: config.cloudflareAccess.certsUrl(),
    issuer: config.cloudflareAccess.issuer(),
    emailAllowlist: config.cloudflareAccess.emailAllowlist(),
  });
  const fetcher = options.fetcher
    ?? new LimitingFetcher(
      createWreqGuardedFetcher(),
      config.bulk.globalFetchConcurrency(),
    );
  const transformer = options.transformer === undefined
    ? await createDefaultLlmTransformer()
    : options.transformer ?? undefined;
  const renderer = options.renderer === undefined
    ? createRenderer(cdpEndpoint)
    : options.renderer ?? undefined;
  const captatum = createCaptatumUseCase({
    fetcher,
    extractHtml,
    ...(transformer ? { transformer } : {}),
    ...(renderer ? { renderer } : {}),
    clock,
  });
  const bulk = createHostedBulk(captatum, clock);
  return {
    auth,
    material,
    host,
    port,
    security,
    selectedStore,
    clock,
    audit,
    identity,
    captatum,
    bulk,
    log: options.log ?? console.log,
  };
}

function createHostedBulk(
  captatum: ReturnType<typeof createCaptatumUseCase>,
  clock: ClockPort,
) {
  if (!config.bulk.enabled()) return undefined;
  const maxGlobalWallMs = config.bulk.maxGlobalWallMs();
  return createCaptatumBulkUseCase({
    executor: captatum,
    adapters: createAdapterRegistry(),
    clock,
    operator: {
      maxPerHostInflight: config.bulk.maxPerHostInflight(),
      crawlDelayMs: config.bulk.crawlDelayMs(),
      maxConcurrency: config.bulk.maxConcurrency(),
      ...(maxGlobalWallMs !== undefined ? { maxGlobalWallMs } : {}),
    },
    quota: new InMemoryBulkQuotaPort({
      clock,
      windowSeconds: config.bulk.quotaWindowSeconds(),
      limit: config.bulk.quotaSeedLimit(),
    }),
  });
}

function ownedRuntime(
  app: Awaited<ReturnType<typeof createHttpApp>>,
  stores: HostedAuthStore,
): HostedServerRuntime {
  const timer = startSweep(stores);
  let closed = false;
  return {
    app,
    stores,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      await closeResources(app, stores);
    },
  };
}

async function closeResources(
  app: Awaited<ReturnType<typeof createHttpApp>> | undefined,
  stores: HostedAuthStore,
): Promise<void> {
  let firstError: unknown;
  try { await app?.close(); } catch (error) { firstError = error; }
  try { await stores.close(); } catch (error) { firstError ??= error; }
  if (firstError !== undefined) throw firstError;
}

function startSweep(stores: HostedAuthStore): NodeJS.Timeout {
  const timer = setInterval(() => {
    stores.store.sweepExpired(new Date().toISOString()).catch(reportSweepError);
    stores.clientStore.sweepStaleClients().catch(reportSweepError);
  }, 5 * 60 * 1000);
  timer.unref();
  return timer;
}

function reportSweepError(_error: unknown): void {
  process.stderr.write("captatum: store_sweep_failed\n");
}

function mcpSecurity(host: string, port: number) {
  const allowedHosts = config.mcp.allowedHosts();
  const allowedOrigins = config.mcp.allowedOrigins();
  if (!allowedHosts.length || !allowedOrigins.length) {
    throw new Error("Hosted MCP requires MCP_ALLOWED_HOSTS and MCP_ALLOWED_ORIGINS");
  }
  return {
    allowedHosts: allowedHosts.length ? allowedHosts : localHosts(host, port),
    allowedOrigins,
    trustedProxyCidrs: config.mcp.trustedProxyCidrs(),
    proxyAuthSecret: config.mcp.proxyAuthSecret(),
  };
}

function localHosts(host: string, port: number): string[] {
  return [...new Set([
    host,
    `${host}:${port}`,
    `localhost:${port}`,
    `127.0.0.1:${port}`,
  ])];
}
