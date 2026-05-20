import type { VercelRequest, VercelResponse } from "@vercel/node";
import { augmentSystemForHtml } from "../prompt-html";

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";

/** Room for HTML fragments (paragraphs + tables/lists) inside JSON. */
const MAX_OUTPUT_TOKENS = 3048;

/** Per-client cap (independent of Google model quotas). */
const MAX_REQUESTS_PER_DAY = 15;

interface InsightModelEntry {
  id: string;
  rpm: number;
  rpd: number;
}

/**
 * Free-tier chain (highest priority first).
 * Fallback when local/API quota is hit or the request fails.
 */
const MODEL_CHAIN: InsightModelEntry[] = [
  { id: "gemini-3.1-flash-lite", rpm: 15, rpd: 500 },
  { id: "gemma-4-31b-it", rpm: 15, rpd: 1500 },
  { id: "gemma-4-26b-a4b-it", rpm: 15, rpd: 1500 },
];

interface RequestBody {
  system: string;
  prompt: string;
  /** @deprecated Prefer `insightKind`. Kept for older app builds. */
  allowMonthly?: boolean;
  insightKind?: "week" | "month";
}

/* ── IP-based rate limiter (in-memory, resets on cold start) ── */

interface RateBucket {
  count: number;
  resetAt: number;
}

const ipBuckets = new Map<string, RateBucket>();

/* ── Per-model quota tracker (API key free tier; resets on cold start) ── */

interface ModelQuotaBucket {
  dayCount: number;
  dayResetAt: number;
  minuteCount: number;
  minuteResetAt: number;
  exhaustedUntil: number;
}

const modelBuckets = new Map<string, ModelQuotaBucket>();

function nextMidnightPT(): number {
  const now = new Date();
  const pt = new Date(
    now.toLocaleString("en-US", { timeZone: "America/Los_Angeles" }),
  );
  const midnight = new Date(pt);
  midnight.setHours(24, 0, 0, 0);
  const diff = midnight.getTime() - pt.getTime();
  return now.getTime() + diff;
}

function getModelBucket(modelId: string): ModelQuotaBucket {
  const now = Date.now();
  let bucket = modelBuckets.get(modelId);
  if (!bucket) {
    bucket = {
      dayCount: 0,
      dayResetAt: nextMidnightPT(),
      minuteCount: 0,
      minuteResetAt: now + 60_000,
      exhaustedUntil: 0,
    };
    modelBuckets.set(modelId, bucket);
    return bucket;
  }
  if (now >= bucket.dayResetAt) {
    bucket.dayCount = 0;
    bucket.dayResetAt = nextMidnightPT();
    bucket.exhaustedUntil = 0;
  }
  if (now >= bucket.minuteResetAt) {
    bucket.minuteCount = 0;
    bucket.minuteResetAt = now + 60_000;
  }
  return bucket;
}

function isModelQuotaAvailable(model: InsightModelEntry): boolean {
  const bucket = getModelBucket(model.id);
  const now = Date.now();
  if (now < bucket.exhaustedUntil) return false;
  if (bucket.dayCount >= model.rpd) return false;
  if (bucket.minuteCount >= model.rpm) return false;
  return true;
}

function recordModelRequest(modelId: string): void {
  const bucket = getModelBucket(modelId);
  bucket.dayCount += 1;
  bucket.minuteCount += 1;
}

function markModelExhausted(modelId: string, untilMs?: number): void {
  const bucket = getModelBucket(modelId);
  bucket.exhaustedUntil = untilMs ?? nextMidnightPT();
}

function getClientIp(req: VercelRequest): string {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string") return xff.split(",")[0]!.trim();
  if (Array.isArray(xff)) return xff[0]!.split(",")[0]!.trim();
  return req.socket?.remoteAddress ?? "unknown";
}

function checkRateLimit(ip: string): {
  allowed: boolean;
  remaining: number;
  resetAt: number;
} {
  const now = Date.now();
  let bucket = ipBuckets.get(ip);

  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: nextMidnightPT() };
    ipBuckets.set(ip, bucket);
  }

  if (bucket.count >= MAX_REQUESTS_PER_DAY) {
    return { allowed: false, remaining: 0, resetAt: bucket.resetAt };
  }

  bucket.count += 1;
  return {
    allowed: true,
    remaining: MAX_REQUESTS_PER_DAY - bucket.count,
    resetAt: bucket.resetAt,
  };
}

function setRateLimitHeaders(
  res: VercelResponse,
  remaining: number,
  resetAt: number,
): void {
  res.setHeader("X-RateLimit-Limit", MAX_REQUESTS_PER_DAY);
  res.setHeader("X-RateLimit-Remaining", remaining);
  res.setHeader("X-RateLimit-Reset", Math.ceil(resetAt / 1000));
}

interface AiInsightPayload {
  weekly_report: string;
  monthly_report: string | null;
  suggestions: string;
}

function isGeminiFamilyModel(modelId: string): boolean {
  return modelId.startsWith("gemini-");
}

function isQuotaOrRateLimitError(status: number, body: string): boolean {
  if (status === 429) return true;
  const lower = body.toLowerCase();
  return (
    lower.includes("quota") ||
    lower.includes("rate limit") ||
    lower.includes("resource exhausted") ||
    lower.includes("too many requests")
  );
}

function shouldFailoverToNextModel(status: number, body: string): boolean {
  if (isQuotaOrRateLimitError(status, body)) return true;
  if (status === 503 || status === 502 || status === 504) return true;
  if (status === 404) return true;
  if (status >= 500) return true;
  return false;
}

function buildGenerationConfigs(insightKind: "week" | "month", useSchema: boolean) {
  const generationConfigWithSchema =
    insightKind === "month"
      ? {
          responseMimeType: "application/json",
          temperature: 0.4,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          responseSchema: {
            type: "OBJECT",
            properties: {
              monthly_report: { type: "STRING" },
              suggestions: { type: "STRING" },
            },
            required: ["monthly_report", "suggestions"],
          },
        }
      : {
          responseMimeType: "application/json",
          temperature: 0.4,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          responseSchema: {
            type: "OBJECT",
            properties: {
              weekly_report: { type: "STRING" },
              suggestions: { type: "STRING" },
            },
            required: ["weekly_report", "suggestions"],
          },
        };

  const generationConfigMinimal = {
    responseMimeType: "application/json",
    temperature: 0.4,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  };

  if (!useSchema) {
    return [generationConfigMinimal];
  }
  return [generationConfigWithSchema, generationConfigMinimal];
}

type ModelCallResult =
  | { ok: true; text: string }
  | {
      ok: false;
      failover: boolean;
      quotaExceeded: boolean;
      message: string;
    };

async function callModelOnce(
  apiKey: string,
  model: string,
  system: string,
  user: string,
  insightKind: "week" | "month",
): Promise<ModelCallResult> {
  const useSchema = isGeminiFamilyModel(model);
  const configs = buildGenerationConfigs(insightKind, useSchema);
  const q = new URLSearchParams({ key: apiKey });
  const url = `${GEMINI_BASE}/models/${encodeURIComponent(model)}:generateContent?${q}`;

  let lastMessage = "Unknown model error";

  for (let attempt = 0; attempt < configs.length; attempt++) {
    const generationConfig = configs[attempt]!;

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig,
      }),
    });

    if (!res.ok) {
      const t = await res.text();
      lastMessage = `${model} ${res.status}: ${t.slice(0, 300)}`;
      if (attempt === 0 && res.status === 400 && useSchema) {
        console.warn(
          `generate-insight: ${model} rejected responseSchema, retrying without schema`,
        );
        continue;
      }
      return {
        ok: false,
        failover: shouldFailoverToNextModel(res.status, t),
        quotaExceeded: isQuotaOrRateLimitError(res.status, t),
        message: lastMessage,
      };
    }

    const json = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const part = json.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!part?.trim()) {
      return {
        ok: false,
        failover: true,
        quotaExceeded: false,
        message: `${model} returned an empty response`,
      };
    }
    return { ok: true, text: part };
  }

  return {
    ok: false,
    failover: true,
    quotaExceeded: false,
    message: lastMessage,
  };
}

async function callWithModelFallback(
  apiKey: string,
  system: string,
  user: string,
  insightKind: "week" | "month",
): Promise<{ text: string; modelUsed: string }> {
  const primaryOverride = process.env.GEMINI_MODEL?.trim();
  const chain: InsightModelEntry[] = [...MODEL_CHAIN];
  if (primaryOverride && primaryOverride !== chain[0]!.id) {
    const idx = chain.findIndex((m) => m.id === primaryOverride);
    if (idx > 0) {
      const [picked] = chain.splice(idx, 1);
      chain.unshift(picked!);
    } else if (idx === -1) {
      chain.unshift({ id: primaryOverride, rpm: 15, rpd: 500 });
    }
  }

  const errors: string[] = [];

  for (const model of chain) {
    if (!isModelQuotaAvailable(model)) {
      errors.push(`${model.id}: local free-tier quota exhausted`);
      continue;
    }

    recordModelRequest(model.id);
    const result = await callModelOnce(
      apiKey,
      model.id,
      system,
      user,
      insightKind,
    );

    if (result.ok) {
      console.info(`generate-insight: success via ${model.id}`);
      return { text: result.text, modelUsed: model.id };
    }

    errors.push(result.message);
    console.warn(`generate-insight: ${model.id} failed — ${result.message}`);

    if (result.failover) {
      if (result.quotaExceeded) {
        markModelExhausted(model.id);
      }
      continue;
    }

    throw new Error(result.message);
  }

  throw new Error(
    `All models unavailable. ${errors.join(" | ")}`,
  );
}

function stripCodeFences(text: string): string {
  let t = text.trim();
  if (t.startsWith("```")) {
    t = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "");
  }
  return t.trim();
}

function extractFirstJsonObject(text: string): string {
  const start = text.indexOf("{");
  if (start === -1) return text;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const c = text[i]!;
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return text.slice(start);
}

function parseJsonLenient(raw: string): Record<string, unknown> {
  const cleaned = stripCodeFences(raw);
  try {
    return JSON.parse(cleaned) as Record<string, unknown>;
  } catch {
    try {
      return JSON.parse(extractFirstJsonObject(cleaned)) as Record<string, unknown>;
    } catch {
      throw new Error(
        `Invalid JSON from model (first 240 chars): ${cleaned.slice(0, 240)}`,
      );
    }
  }
}

function pickString(j: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    const v = j[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

const MONTH_SUGGESTIONS_FALLBACK =
  "<ol><li>Pick one non-negotiable anchor day and log it the night before.</li><li>Review skips weekly so patterns do not repeat.</li><li>Protect your best weekday with a calendar block.</li></ol>";

function parsePayload(raw: string, insightKind: "week" | "month"): AiInsightPayload {
  const j = parseJsonLenient(raw);

  if (insightKind === "week") {
    const weekly = pickString(
      j,
      "weekly_report",
      "weeklyReport",
      "week_report",
      "report",
    );
    const suggestions = pickString(
      j,
      "suggestions",
      "suggestion",
      "coaching",
      "coach_notes",
    );
    if (!weekly) {
      throw new Error("Missing weekly_report in Gemini JSON");
    }
    if (!suggestions) {
      throw new Error("Missing suggestions in Gemini JSON");
    }
    return { weekly_report: weekly, monthly_report: null, suggestions };
  }

  let monthly = pickString(
    j,
    "monthly_report",
    "monthlyReport",
    "month_report",
    "report",
  );
  if (!monthly) {
    monthly = pickString(j, "weekly_report", "weeklyReport");
  }
  if (!monthly) {
    throw new Error("Missing monthly_report in Gemini JSON");
  }
  let suggestions = pickString(
    j,
    "suggestions",
    "suggestion",
    "coaching",
    "coach_notes",
  );
  if (!suggestions) {
    suggestions = MONTH_SUGGESTIONS_FALLBACK;
  }
  return { weekly_report: "", monthly_report: monthly, suggestions };
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    res.status(500).json({ error: "GEMINI_API_KEY not configured on server" });
    return;
  }

  const ip = getClientIp(req);
  const rl = checkRateLimit(ip);
  setRateLimitHeaders(res, rl.remaining, rl.resetAt);

  if (!rl.allowed) {
    res.status(429).json({
      error: "Daily limit reached",
      resetAt: rl.resetAt,
    });
    return;
  }

  try {
    let body = req.body as RequestBody;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body) as RequestBody;
      } catch {
        res.status(400).json({ error: "Invalid JSON body" });
        return;
      }
    }

    const { system, prompt } = body;

    if (!system || !prompt) {
      res.status(400).json({ error: "Missing required fields: system, prompt" });
      return;
    }

    const insightKind: "week" | "month" =
      body.insightKind === "week" || body.insightKind === "month"
        ? body.insightKind
        : body.allowMonthly === true
          ? "month"
          : "week";

    const systemWithHtml = augmentSystemForHtml(system);

    const { text: raw, modelUsed } = await callWithModelFallback(
      apiKey,
      systemWithHtml,
      `DATA (compressed):\n${prompt}`,
      insightKind,
    );
    const payload = parsePayload(raw, insightKind);

    res.setHeader("X-Model-Used", modelUsed);
    res.status(200).json(payload);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("generate-insight error:", message);
    res.status(500).json({ error: message });
  }
}
