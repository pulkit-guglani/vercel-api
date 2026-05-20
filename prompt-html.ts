/**
 * Appended to every insight system prompt on the server so responses use
 * mobile-friendly HTML (lists, tables when patterns warrant).
 */
export const INSIGHT_HTML_OUTPUT_RULES = `
HTML OUTPUT (required for weekly_report, monthly_report, and suggestions string values):
- Each report/suggestions field is an HTML fragment only — NOT markdown, NOT code fences, NOT \\n\\n plain paragraphs.
- Allowed tags: <p>, <strong>, <em>, <h3>, <h4>, <ul>, <ol>, <li>, <br/>, <table>, <thead>, <tbody>, <tr>, <th>, <td>.
- Wrap narrative in <p>...</p>. Use <strong> for emphasis sparingly.
- Use lists when they improve scanability:
  • <ul> for unordered takeaways or mixed points.
  • <ol> for ranked or step-by-step directives (especially suggestions).
- Use a <table> when the data shows a clear pattern worth comparing in columns, for example:
  • completion vs skip counts by weekday;
  • top skip reasons and how often each appeared;
  • week-by-week or stretch-by-stretch done vs missed (monthly);
  • time-of-day or early/late drift summarized by row.
  Keep tables small (≤6 rows, ≤4 columns). Include <thead><tr><th>...</th></tr></thead> and <tbody> with <tr><td>...</td></tr>.
- Do NOT add a table or list every time — use plain <p> prose when that is enough. When you use a table or list, still include at least one <p> opening or closing the narrative.

MONTHLY REPORT (monthly_report field only):
- Start monthly_report with these two lines (compute from DATA; target days only, exclude "x" rest days):
  <p><strong>Best streak:</strong> {longest consecutive done streak in the month, with optional date span}</p>
  <p><strong>Missed days:</strong> {count of target days not completed — skips and no-log; optional split in parentheses}</p>
- Then continue with narrative <p> blocks (and optional table/list). Use <strong>Label:</strong> value in the same tag, never markdown bold.
- JSON safety: escape double quotes inside HTML as \\". No raw newlines inside JSON strings; use <br/> or separate <p> tags instead.
- No <a>, <img>, <script>, inline styles, or class attributes. English only.
`.trim();

export function augmentSystemForHtml(system: string): string {
  if (system.includes("HTML OUTPUT")) {
    return system;
  }
  return `${system}\n\n${INSIGHT_HTML_OUTPUT_RULES}`;
}
