import type { VercelRequest, VercelResponse } from "@vercel/node";

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";

const MAX_REQUESTS_PER_DAY = 15;

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
  resetAt: number; // epoch ms (midnight PT)
}

const ipBuckets = new Map<string, RateBucket>();

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

async function callGemini(
  apiKey: string,
  model: string,
  system: string,
  user: string,
  insightKind: "week" | "month",
): Promise<string> {
  const generationConfigWithSchema =
    insightKind === "month"
      ? {
          responseMimeType: "application/json",
          temperature: 0.4,
          maxOutputTokens: 2400,
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
          maxOutputTokens: 2400,
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
    maxOutputTokens: 2400,
  };

  const q = new URLSearchParams({ key: apiKey });
  const url = `${GEMINI_BASE}/models/${encodeURIComponent(model)}:generateContent?${q}`;

  for (let attempt = 0; attempt < 2; attempt++) {
    const generationConfig =
      attempt === 0 ? generationConfigWithSchema : generationConfigMinimal;

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
      if (attempt === 0 && res.status === 400) {
        console.warn(
          "generate-insight: Gemini rejected responseSchema, retrying without schema",
        );
        continue;
      }
      throw new Error(`Gemini ${res.status}: ${t.slice(0, 300)}`);
    }

    const json = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const part = json.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!part) {
      throw new Error("Gemini returned an empty response");
    }
    return part;
  }

  throw new Error("Gemini: unreachable");
}

function stripCodeFences(text: string): string {
  let t = text.trim();
  if (t.startsWith("```")) {
    t = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "");
  }
  return t.trim();
}

/** If the model wraps JSON in prose, take the outermost `{ ... }` block. */
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
  "Next month: pick one non-negotiable anchor day, log it the night before, and review skips weekly so patterns do not repeat.";

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
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";

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

    const raw = await callGemini(
      apiKey,
      model,
      system,
      `DATA (compressed):\n${prompt}`,
      insightKind,
    );
    const payload = parsePayload(raw, insightKind);

    res.status(200).json(payload);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("generate-insight error:", message);
    res.status(500).json({ error: message });
  }
}
