// Shared Gemini call helper. Retries on transient 5xx errors with
// exponential backoff and falls back to a secondary model if the primary
// keeps misbehaving. Used by /api/explain and /api/analyse.
//
// Gemini 503s are common during demand spikes — Google's API returns
// "model is overloaded, please try again". A quick retry is almost
// always enough; the fallback covers the rare extended outage.

const PRIMARY = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";
const FALLBACK = "gemini-flash-latest";

const BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";

/**
 * Send a prompt to Gemini with retry + fallback.
 * @param {string} prompt   the user prompt
 * @param {object} opts     { maxTokens, temperature, key }
 * @returns {{ text: string, model: string } | { error: string, status: number, body?: string }}
 */
export async function callGemini(prompt, opts = {}) {
  const key = opts.key || process.env.GEMINI_API_KEY;
  if (!key) return { error: "GEMINI_API_KEY not set", status: 503 };

  const maxTokens   = opts.maxTokens   || 500;
  const temperature = opts.temperature ?? 0.3;

  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { maxOutputTokens: maxTokens, temperature }
  });

  // Two attempts on the primary, one on the fallback. Backoffs in between.
  const attempts = [
    { model: PRIMARY,  wait: 0 },
    { model: PRIMARY,  wait: 700 },
    { model: FALLBACK, wait: 1500 }
  ];

  let lastErr = { error: "no attempts ran", status: 500 };
  for (const a of attempts) {
    if (a.wait) await sleep(a.wait);
    const url = `${BASE_URL}/${a.model}:generateContent?key=${key}`;
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body
      });
      if (r.ok) {
        const data = await r.json();
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text
                  || "(empty response)";
        return { text, model: a.model };
      }
      // Retry on 5xx + a couple of 4xx codes that Gemini uses to mean
      // "try again" (e.g., 429 rate limit). Hard fail on 400/401/403.
      const status = r.status;
      const errBody = await r.text().catch(() => "");
      lastErr = {
        error: `gemini ${status}`,
        status,
        body: errBody.slice(0, 400),
        model: a.model
      };
      if (status < 500 && status !== 429) break;   // permanent — stop retrying
    } catch (e) {
      lastErr = { error: String(e), status: 500, model: a.model };
    }
  }
  return lastErr;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
