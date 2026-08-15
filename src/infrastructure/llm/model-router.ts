import { performance } from "node:perf_hooks";
import type { ClockPort } from "../../application/ports/clock.ts";
import type { ModelPick, ModelPickOptions, ModelRouterPort, ModelScore, RouterProvider, RouterTask } from "../../application/ports/model-router.ts";
import { TransformError, type TransformInput, type TransformPort, type TransformResult } from "../../application/ports/transformer.ts";
import { config } from "../../config.ts";
import { finalize } from "./finalize.ts";
import { emptyHealth, recordOutcome, type ModelHealth } from "./model-health.ts";
import { OllamaProvider } from "./ollama.ts";
import { OpenRouterProvider } from "./openrouter.ts";
import { buildMessages } from "./prompts.ts";
import { detectSensitiveTransformInput } from "./safety.ts";
import { estimateTokens, MAX_OUTPUT_TOKENS_CAP, resolveOutputCap } from "./tokens.ts";
import type { LlmGenerateResult, LlmModelCandidate, ProviderMap } from "./types.ts";
import { demotionOf, effectiveOrder, staticRank } from "./router-ranking.ts";
import { candidateKey, fits, noneReason, overrideProvider, rawFallback, splitList } from "./router-helpers.ts";

/** Bound on escalation attempts per transform (#125) — caps latency/cost on a page that won't fit even at the largest model's max (then surfaces an honest `transform_truncated`). */
const MAX_TRANSFORM_ATTEMPTS = 5;

export class ModelRouter implements ModelRouterPort {
  private readonly candidatesByKey: Map<string, LlmModelCandidate>;
  // Per-model sticky health (#82). Lives in-memory for the life of this router (one per process,
  // built at boot) — demotion is per-instance, not shared across replicas and not persisted.
  private readonly health = new Map<string, ModelHealth>();

  constructor(candidates: LlmModelCandidate[]) {
    this.candidatesByKey = new Map(candidates.map((candidate) => [candidateKey(candidate), candidate]));
  }

  pick(task: RouterTask, inputTokens: number, options: ModelPickOptions = {}): ModelPick {
    const candidates = [...this.candidatesByKey.values()].filter((candidate) => fits(candidate, task, inputTokens, options));
    if (candidates.length === 0) return { provider: "none", reason: noneReason(options, this.candidatesByKey.size) };
    // Effective order = configured order + sticky demotion, so a sustained-failing primary
    // (demotion 1) sorts after a healthy fallback it would otherwise beat. The demotionOf
    // tiebreak is load-bearing: a demoted order-0 model (eff 1) ties a healthy order-1 model
    // (eff 1), and without this tiebreak localeCompare would put "deepseek" back before "qwen".
    const [best] = candidates.sort((left, right) =>
      effectiveOrder(left, this.health) - effectiveOrder(right, this.health)
      || demotionOf(left, this.health) - demotionOf(right, this.health)
      || staticRank(left) - staticRank(right)
      || left.model.localeCompare(right.model));
    return { provider: best.provider, model: best.model, free: best.free, maxOutputTokens: best.maxOutputTokens, contextTokens: best.contextTokens };
  }

  feedback(score: ModelScore): void {
    const h = this.health.get(score.model) ?? emptyHealth();
    recordOutcome(h, score.outcome);
    this.health.set(score.model, h);
  }
}


export interface LlmTransformerOptions {
  router: ModelRouterPort;
  providers: ProviderMap;
  clock?: ClockPort;
  /** Output-token cap applied when the caller omits `budget` (#3). Defaults to the
   *  TRANSFORM_MAX_OUTPUT_TOKENS config knob. */
  maxOutputTokensDefault?: number;
}

export class LlmTransformer implements TransformPort {
  private readonly router: ModelRouterPort;
  private readonly providers: ProviderMap;
  private readonly clock?: ClockPort;
  private readonly maxOutputTokensDefault: number;

  constructor(options: LlmTransformerOptions) {
    this.router = options.router;
    this.providers = options.providers;
    this.clock = options.clock;
    this.maxOutputTokensDefault = options.maxOutputTokensDefault ?? config.transform.maxOutputTokensDefault();
  }

  /** A provider is configured iff at least one has model candidates. */
  hasProvider(): boolean {
    return Object.values(this.providers).some((provider) => provider.candidates().length > 0);
  }

  async transform(input: TransformInput): Promise<TransformResult> {
    const messages = buildMessages(input);
    const inTokens = estimateTokens(messages.map((message) => message.content).join("\n"));
    const override = overrideProvider(input.transform?.provider);
    if (override === "unsupported") return rawFallback(input.content, "unsupported_provider");

    const sensitive = detectSensitiveTransformInput({
      content: input.scanContent ?? input.content,
      ...(input.sourceUrl ? { sourceUrl: input.sourceUrl } : {}),
    });
    const baseOptions: ModelPickOptions = {
      provider: sensitive.sensitive ? undefined : override,
      model: typeof input.transform?.model === "string" ? input.transform.model : undefined,
      localOnly: sensitive.sensitive,
    };

    // Candidate loop (#125, refined #131 P2-A). Two independent termination rails:
    //  - hard-fail fallback (provider throw / empty completion) and truncation-next-candidate
    //    both push to `tried`, so they self-terminate via candidate exhaustion — pick returns
    //    "none" once every candidate is excluded. Pre-#125 hard-fail traversed the whole list;
    //    #131 restores that by no longer sharing one attempt counter across fallback + escalation.
    //  - truncation-budget escalation retries the SAME model at a higher cap (no `tried` push), so
    //    it is bounded SEPARATELY by `escalations` (< MAX_TRANSFORM_ATTEMPTS) — a latency/cost
    //    guard that surfaces an honest `transform_truncated` instead of looping.
    // An explicit caller budget is a hard ceiling, never exceeded; escalation is also bounded by
    // remaining context. The best truncated result surfaces as info.truncated, never thrown away.
    const tried: string[] = [];
    let lastError: Error | undefined;
    let best: TransformResult | undefined;
    let budgetFloor = input.budget; // grows on truncation
    let escalations = 0; // truncation-budget retries only — hard-fail fallback is candidate-bound
    let accumulatedCostUsd = 0; // sum EVERY billable attempt (escalation/fallback re-bills input); only the last was recorded before, so a paid-fallback truncation silently undercounted spend vs the bulk cost cap
    for (;;) {
      // Reserve what this attempt will request so a long page is not rejected for a model MAX it won't use (codex P2 #125).
      const pick = this.router.pick(input.mode, inTokens, { ...baseOptions, exclude: tried, reserveOutputTokens: budgetFloor ?? this.maxOutputTokensDefault });
      if (pick.provider === "none" || !pick.model) {
        if (best) return best; // all candidates exhausted with ≥1 truncation — return the longest truncated best + advisory (a hard-fail-then-truncate mix lands here too)
        if (tried.length === 0) return rawFallback(input.content, pick.reason ?? "unconfigured");
        throw new TransformError(
          "transform_provider_failed",
          errorMessage(lastError, `All ${tried.length} candidate model(s) failed`),
          accumulatedCostUsd || undefined,
        );
      }
      const provider = this.providers[pick.provider];
      if (!provider) { tried.push(pick.model); continue; }

      const modelMax = pick.maxOutputTokens ?? MAX_OUTPUT_TOKENS_CAP;
      const cap = resolveOutputCap(budgetFloor, this.maxOutputTokensDefault, modelMax);
      const started = this.nowMs();
      let generated: LlmGenerateResult;
      try {
        generated = await provider.generate({
          task: input.mode,
          model: pick.model,
          prompt: input.prompt,
          content: input.content,
          schema: input.schema,
          budget: input.budget,
          messages,
          maxOutputTokens: cap,
        });
        // #48 B: an empty completion (DeepSeek capacity pressure) is a failure —
        // retry the next candidate (qwen) with `fallbackFrom`, instead of failing
        // the whole transform (which previously yielded a raw dump + demotion).
        if (!generated.text.trim()) {
          throw new TransformError("transform_empty", `${pick.model} returned an empty completion`);
        }
      } catch (error) {
        this.router.feedback({ model: pick.model, outcome: "hard_fail" });
        tried.push(pick.model);
        lastError = error instanceof Error ? error : new Error(String(error));
        process.stderr.write(`captatum transform: ${pick.model} failed: ${lastError.message}\n`);
        continue;
      }
      accumulatedCostUsd += generated.costUsd ?? 0; // every successful (non-empty) generate bills
      const latencyMs = elapsed(started, this.nowMs());
      // Truncation is checked BEFORE finalize (#131 P2-B): a length-capped extract is incomplete
      // JSON, and finalize() would parse+throw extract_invalid_json before this branch could run.
      // The model is healthy (it responded, just hit the cap) — record success so it is not
      // demoted — keep the raw text as best, and escalate. finalize (which parses extract JSON)
      // runs only on a complete completion.
      if (generated.truncated) {
        this.router.feedback({ model: pick.model, outcome: "success" });
        const truncatedResult: TransformResult = {
          result: generated.text,
          info: {
            provider: pick.provider,
            model: pick.model,
            free: pick.free,
            inTokens: generated.inTokens ?? inTokens,
            outTokens: generated.outTokens ?? estimateTokens(generated.text),
            latencyMs,
            costUsd: accumulatedCostUsd,
            ...(tried.length > 0 ? { fallbackFrom: tried.join(", ") } : {}),
            truncated: true,
          },
        };
        if (!best || truncatedResult.result.length > best.result.length) best = truncatedResult; // keep longest truncation
        // Sync best's cost even when this truncation was SHORTER (best not replaced) — otherwise a
        // later billed attempt's cost is dropped from the returned TransformResult (codex P2).
        best = { ...best, info: { ...best.info, costUsd: accumulatedCostUsd } };
        if (typeof input.budget === "number" && input.budget > 0) return best; // explicit caller budget is a hard ceiling — do not escalate past it (codex P2 #125)
        // Escalate to the model's full cap, bounded by remaining context so a long page isn't rejected for a model MAX the context can't hold (codex P2 #125).
        const ceiling = Math.min(modelMax, (pick.contextTokens ?? MAX_OUTPUT_TOKENS_CAP) - inTokens);
        if (cap < ceiling) {
          if (escalations >= MAX_TRANSFORM_ATTEMPTS) return best; // escalation cap — surface truncated advisory instead of looping
          escalations += 1;
          budgetFloor = ceiling; // more headroom — retry same model at the ceiling
        } else tried.push(pick.model); // model maxed or context-bound — next candidate (higher cap)
        continue;
      }

      let finalized;
      try {
        finalized = await finalize(input, generated.text, pick.model, this.router, generated.outTokens);
      } catch (error) {
        // finalize threw (e.g. extract_invalid_json) AFTER billing — re-throw with accumulated cost.
        throw new TransformError(
          error instanceof TransformError ? error.code : "extract_finalize_failed",
          errorMessage(error, "Extract finalize failed"),
          accumulatedCostUsd || undefined,
        );
      }
      return {
        result: finalized.result,
        info: {
          provider: pick.provider,
          model: pick.model,
          free: pick.free,
          inTokens: generated.inTokens ?? inTokens,
          outTokens: finalized.outTokens,
          latencyMs,
          costUsd: accumulatedCostUsd,
          ...(finalized.schemaIssue ? { schemaIssue: finalized.schemaIssue } : {}),
          ...(tried.length > 0 ? { fallbackFrom: tried.join(", ") } : {}),
        },
      };
    }
  }

  private nowMs(): number {
    return this.clock?.nowMs() ?? performance.now();
  }
}

export async function createDefaultLlmTransformer(): Promise<LlmTransformer> {
  const openRouter = new OpenRouterProvider({
    apiKey: config.transform.openRouterApiKey(),
    baseUrl: config.transform.openRouterBaseUrl(),
    models: splitList(config.transform.openRouterModels()),
    timeoutMs: config.transform.timeoutMs(),
  });
  const ollama = new OllamaProvider({
    baseUrl: config.transform.ollamaBaseUrl(),
    model: config.transform.ollamaModel(),
    timeoutMs: config.transform.timeoutMs(),
  });
  // Discover OpenRouter's currently-free models live (the pool churns constantly).
  await openRouter.discover();
  const providers = { openrouter: openRouter, ollama };
  return new LlmTransformer({ router: new ModelRouter([...openRouter.candidates(), ...ollama.candidates()]), providers });
}

function elapsed(startMs: number, endMs: number): number {
  return Math.max(0, Math.round(endMs - startMs));
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
