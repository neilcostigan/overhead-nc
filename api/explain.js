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

const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";

// Cache identical questions for an hour so spam-clicks don't burn quota.
const CACHE_MS = 60 * 60 * 1000;
const cache = new Map();   // hex → { ts, text, model }

export default async function handler(req, res) {
  if (req.method !== "POST" && req.method !== "GET") {
    return res.status(405).json({ error: "POST or GET" });
  }
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    return res.status(503).json({
      error: "Explain disabled — set GEMINI_API_KEY in Vercel env vars"
    });
  }

  // Accept payload from JSON body (POST) or query (GET).
  const src = req.method === "POST" ? (req.body || {}) : req.query;
  const hex = (src.hex || "").toString().trim().toLowerCase();
  if (!/^[0-9a-f]{6}$/.test(hex)) {
    return res.status(400).json({ error: "hex must be 6 hex chars" });
  }
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
    hex, callsign, lat, lon, altFt, gsKt, trkDeg,
    info:  acInfo.status === "fulfilled" ? acInfo.value : null,
    route: routeInfo.status === "fulfilled" ? routeInfo.value : null
  });

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${key}`;
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 500, temperature: 0.3 }
      })
    });
    if (!r.ok) {
      const errBody = await r.text().catch(() => "");
      return res.status(502).json({
        error: `gemini ${r.status}`,
        body: errBody.slice(0, 400)
      });
    }
    const data = await r.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text
              || "(empty response)";
    cache.set(hex, { ts: now, text, model: MODEL });
    res.setHeader("X-Cache", "MISS");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.status(200).json({ text, model: MODEL });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
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
    "You are an aviation assistant for a user watching live ADS-B traffic",
    "over a chosen city. Below are the facts we have about one aircraft.",
    "Write one short paragraph and three bullet points explaining who it",
    "is, what it's doing, and anything notable. Stay factual — corroborate",
    "what's listed, do not invent. If you cannot tell, say so plainly.",
    "Keep the whole reply under 120 words.",
    "",
    "Facts:",
    ...facts
  ].join("\n");
}
