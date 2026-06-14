// Vercel serverless function — sends the current visible aircraft list to
// Gemini and asks for a one-paragraph "what's going on overhead right now"
// summary plus a few bullets on the standout flights.
//
// Endpoint: POST /api/analyse
//   body: { city: "ARN", aircraft: [{hex, flight, alt_baro, gs, track, lat, lon, distNm}, ...] }
//
// Returns: { text, model } or { error }
//
// Requires GEMINI_API_KEY env var (same one used by /api/explain).

const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";

// Short cache so a double-click doesn't waste a call. Keyed by city + a
// coarse fingerprint of the aircraft set.
const CACHE_MS = 60 * 1000;
const cache = new Map();

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST only" });
  }
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    return res.status(503).json({
      error: "Analyse disabled — set GEMINI_API_KEY in Vercel env vars"
    });
  }
  const { city = "", aircraft = [] } = req.body || {};
  if (!Array.isArray(aircraft) || aircraft.length === 0) {
    return res.status(400).json({ error: "no aircraft in payload" });
  }

  // Cache key: city + first-30 hexes fingerprint.
  const fp = aircraft.slice(0, 30).map(a => a.hex || "").sort().join(",");
  const ckey = city + "|" + fp.slice(0, 200);
  const now = Date.now();
  const hit = cache.get(ckey);
  if (hit && now - hit.ts < CACHE_MS) {
    res.setHeader("X-Cache", "HIT");
    return res.status(200).json({ text: hit.text, model: hit.model });
  }

  // Build prompt — keep payload compact, model only needs the headlines.
  const top = aircraft.slice(0, 30);
  const lines = top.map(a => {
    const cs = (a.flight || "").trim() || "(no callsign)";
    const alt = a.alt_baro === "ground" ? "ground"
              : (typeof a.alt_baro === "number" ? Math.round(a.alt_baro) + " ft" : "?");
    const spd = typeof a.gs === "number" ? Math.round(a.gs) + " kt" : "?";
    const trk = typeof a.track === "number" ? Math.round(a.track) + "°" : "?";
    const dist = typeof a.distNm === "number" ? Math.round(a.distNm) + " nm" : "?";
    return `  ${cs.padEnd(10)}  ${a.hex || ""}  alt ${alt}  spd ${spd}  trk ${trk}  dist ${dist}`;
  }).join("\n");

  const prompt =
`You are an aviation assistant. The user is watching live ADS-B traffic
around ${city || "an airport"}. ${aircraft.length} aircraft are currently
in range. The closest 30 are listed below.

Write a short paragraph (no headers, no preamble) describing what's
going on in the sky right now — the dominant pattern, any standouts,
anything unusual about altitudes or directions. Then 3-5 bullet points
on the most interesting individual flights. Keep the whole reply under
160 words. Stay factual; if you can't identify something, say so.

Aircraft:
${lines}`;

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${key}`;
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 600, temperature: 0.3 }
      })
    });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      return res.status(502).json({
        error: `gemini ${r.status}`, body: body.slice(0, 400)
      });
    }
    const data = await r.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text
              || "(empty response)";
    cache.set(ckey, { ts: now, text, model: MODEL });
    res.setHeader("X-Cache", "MISS");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.status(200).json({ text, model: MODEL });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}
