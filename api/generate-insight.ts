import type { VercelRequest, VercelResponse } from "@vercel/node";

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";

const MAX_REQUESTS_PER_DAY = 15;

interface RequestBody {
  system: string;
  prompt: string;
  allowMonthly: boolean;
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
): Promise<string> {
  const q = new URLSearchParams({ key: apiKey });
  const url = `${GEMINI_BASE}/models/${encodeURIComponent(model)}:generateContent?${q}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig: {
        responseMimeType: "application/json",
        temperature: 0.4,
        maxOutputTokens: 2400,
      },
    }),
  });
  if (!res.ok) {
    const t = await res.text();
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

function parsePayload(raw: string, allowMonthly: boolean): AiInsightPayload {
  const j = JSON.parse(raw) as Record<string, unknown>;
  const weekly = String(j.weekly_report ?? j.weeklyReport ?? "");
  const monthly = j.monthly_report ?? j.monthlyReport;
  const suggestions = String(j.suggestions ?? "");
  if (!weekly || !suggestions) {
    throw new Error("Missing weekly_report or suggestions in Gemini JSON");
  }
  if (!allowMonthly) {
    return { weekly_report: weekly, monthly_report: null, suggestions };
  }
  if (typeof monthly === "string" && monthly.length > 0) {
    return { weekly_report: weekly, monthly_report: monthly, suggestions };
  }
  return { weekly_report: weekly, monthly_report: null, suggestions };
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
    const { system, prompt, allowMonthly } = req.body as RequestBody;

    if (!system || !prompt) {
      res.status(400).json({ error: "Missing required fields: system, prompt" });
      return;
    }

    const raw = await callGemini(apiKey, model, system, `DATA (compressed):\n${prompt}`);
    const payload = parsePayload(raw, allowMonthly ?? false);

    res.status(200).json(payload);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("generate-insight error:", message);
    res.status(500).json({ error: message });
  }
}
