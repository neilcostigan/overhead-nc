// Vercel serverless function — asks Gemini for a one-paragraph plus three
// bullets explanation of a given aircraft. Combines the user-provided
// context with anything we already know from /api/aircraft-info and
// /api/route so the LLM has facts to corroborate rather than invent.
//
// Endpoint: POST /api/explain
//   body: { hex, callsign, lat, lon, altFt, gsKt, trkDeg }
//
// Returns: { text, model } or { error }
//
// Requires environment variable GEMINI_API_KEY (set on Vercel under
// Settings → Environment Variables). Without the key, returns a 503 so the
// UI can show a friendly "Explain disabled" badge.

import { callLlm } from "./_llm.js";

// Cache identical questions for an hour so spam-clicks don't burn quota.
const CACHE_MS = 60 * 60 * 1000;
const cache = new Map();   // hex → { ts, text, model }

export default async function handler(req, res) {
  if (req.method !== "POST" && req.method !== "GET") {
    return res.status(405).json({ error: "POST or GET" });
  }
  // Accept payload from JSON body (POST) or query (GET).
  const src = req.method === "POST" ? (req.body || {}) : req.query;
  // User-supplied LLM settings (from the settings dialog, stored client-side).
  const llmSettings = (src.llm && typeof src.llm === "object") ? src.llm : {};
  // No keys at all (neither user-supplied nor env) → don't even bother building the prompt.
  const haveKey = !!(llmSettings.apiKey
                  || process.env.GEMINI_API_KEY
                  || process.env.OPENAI_API_KEY);
  if (!haveKey) {
    return res.status(503).json({
      error: "Explain disabled — open Settings ⚙ and add a Gemini or OpenAI API key"
    });
  }
  const hex = (src.hex || "").toString().trim().toLowerCase();
  if (!/^[0-9a-f]{6}$/.test(hex)) {
    return res.status(400).json({ error: "hex must be 6 hex chars" });
  }
  const units = (src.units === "aviation") ? "aviation" : "metric";
  const callsign = (src.callsign || "").toString().trim().toUpperCase();
  const lat = parseFloat(src.lat);
  const lon = parseFloat(src.lon);
  const altFt = parseFloat(src.altFt);
  const gsKt = parseFloat(src.gsKt);
  const trkDeg = parseFloat(src.trkDeg);

  // Cache by hex (so identical clicks reuse).
  const now = Date.now();
  const cached = cache.get(hex);
  if (cached && now - cached.ts < CACHE_MS) {
    res.setHeader("X-Cache", "HIT");
    return res.status(200).json({ text: cached.text, model: cached.model });
  }

  // Enrich with whatever side-lookups we can get fast — in parallel.
  const origin = new URL(req.url, "http://x").origin;   // for sibling fetches
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["host"] || "";
  const selfBase = host ? `${proto}://${host}` : "";

  const [acInfo, routeInfo] = await Promise.allSettled([
    selfBase && fetch(`${selfBase}/api/aircraft-info?hex=${hex}`).then(r => r.json()),
    selfBase && callsign && fetch(`${selfBase}/api/route?callsign=${encodeURIComponent(callsign)}`).then(r => r.json())
  ]);

  const prompt = buildPrompt({
    hex, callsign, lat, lon, altFt, gsKt, trkDeg, units,
    info:  acInfo.status === "fulfilled" ? acInfo.value : null,
    route: routeInfo.status === "fulfilled" ? routeInfo.value : null
  });

  const result = await callLlm(prompt, llmSettings, { maxTokens: 1500 });
  if (result.error) {
    return res.status(502).json({
      error: result.error,
      status: result.status,
      body: result.body,
      model: result.model
    });
  }
  cache.set(hex, { ts: now, text: result.text, model: result.model });
  res.setHeader("X-Cache", "MISS");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.status(200).json({ text: result.text, model: result.model });
}

function unitsInstruction(units) {
  return units === "aviation"
    ? "Use aviation units in your reply: feet for altitude, knots for speed, nautical miles for distance."
    : "Use metric units in your reply: metres for altitude, km/h for speed, kilometres for distance.";
}

function buildPrompt(p) {
  const facts = [];
  if (p.callsign) facts.push(`Callsign: ${p.callsign}`);
  facts.push(`ICAO24: ${p.hex}`);
  if (p.info && !p.info.missing) {
    if (p.info.registration) facts.push(`Registration: ${p.info.registration}`);
    if (p.info.type)         facts.push(`Type: ${p.info.type}`);
    if (p.info.manufacturer) facts.push(`Manufacturer: ${p.info.manufacturer}`);
    if (p.info.operator)     facts.push(`Operator: ${p.info.operator}`);
  }
  if (p.route && !p.route.missing) {
    if (p.route.origin && p.route.destination) {
      facts.push(`Scheduled route: ${p.route.origin} → ${p.route.destination}`);
    }
    if (p.route.airline) facts.push(`Airline: ${p.route.airline}`);
  }
  if (!isNaN(p.lat) && !isNaN(p.lon)) {
    facts.push(`Position: ${p.lat.toFixed(3)}, ${p.lon.toFixed(3)}`);
  }
  if (!isNaN(p.altFt)) facts.push(`Altitude: ${Math.round(p.altFt)} ft`);
  if (!isNaN(p.gsKt))  facts.push(`Ground speed: ${Math.round(p.gsKt)} kt`);
  if (!isNaN(p.trkDeg)) facts.push(`Track: ${Math.round(p.trkDeg)}°`);

  return [
    "You are an aviation assistant. Below are the facts we have about ONE",
    "aircraft. Write a concise but informative briefing — short enough to",
    "read in 30 seconds, substantial enough to be worth reading.",
    "",
    "Cover, in this order, with the section labels exactly as shown:",
    "",
    "**Summary** — Two sentences: who, what, where to.",
    "**Operator** — Airline / operator and what kind of carrier it is.",
    "**Aircraft** — Type, role, and one or two distinguishing facts.",
    "**Route** — Origin → destination, corridor, distance.",
    "**In flight** — What the current altitude / speed / track imply",
    "  about the phase of flight.",
    "**Notable** — Anything quirky or interesting; say 'nothing unusual'",
    "  if there isn't.",
    "",
    "Use **bold** for key facts. Write each section as 1-3 sentences",
    "of flowing prose — not bullets. Aim for ~250-300 words total.",
    "",
    "STRICT: Don't invent. If a field is missing, say '(unknown)'.",
    "Start directly with **Summary** — no preamble.",
    "",
    unitsInstruction(p.units),
    "",
    "Facts:",
    ...facts
  ].join("\n");
}
