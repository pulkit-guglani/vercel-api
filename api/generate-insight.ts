import type { VercelRequest, VercelResponse } from "@vercel/node";

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";

interface RequestBody {
  system: string;
  prompt: string;
  allowMonthly: boolean;
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
        maxOutputTokens: 1200,
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
  const model = process.env.GEMINI_MODEL || "gemini-2.0-flash";

  if (!apiKey) {
    res.status(500).json({ error: "GEMINI_API_KEY not configured on server" });
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
