// Vercel serverless function — sends the current visible aircraft list to
// Gemini and asks for a one-paragraph "what's going on overhead right now"
// summary plus a few bullets on the standout flights.
//
// Before calling the LLM, fans out to adsbdb.com to enrich each callsign
// with airline + origin/destination so the model has something concrete to
// say beyond "altitudes and speeds". Route lookups are aggressively cached
// (6 h) so repeat calls on the same fleet are essentially free.
//
// Endpoint: POST /api/analyse
//   body: { city: "ARN", aircraft: [{hex, flight, alt_baro, gs, track, lat, lon, distNm}, ...] }
//
// Returns: { text, model, enriched: <int> } or { error }
//
// Requires GEMINI_API_KEY env var (same one used by /api/explain).

const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";

const ADSBDB_URL = "https://api.adsbdb.com/v0/callsign";

// Short cache for analysis text so a double-click doesn't waste a call.
const CACHE_MS = 60 * 1000;
const cache = new Map();

// Route enrichment cache — 6 h, keyed by callsign.
const ROUTE_CACHE_MS = 6 * 60 * 60 * 1000;
const routeCache = new Map();

/** Fetch the adsbdb.com route for a callsign, with caching. Returns
 *  { airline, origin, destination, originName, destName } or null. */
async function fetchRoute(callsign) {
  if (!callsign) return null;
  const cs = callsign.trim().toUpperCase();
  if (!/^[A-Z0-9]{2,8}$/.test(cs)) return null;
  const now = Date.now();
  const hit = routeCache.get(cs);
  if (hit && now - hit.ts < ROUTE_CACHE_MS) return hit.value;
  try {
    const r = await fetch(`${ADSBDB_URL}/${cs}`, {
      headers: { "Accept": "application/json",
                 "User-Agent": "nc-overhead/0.1" }
    });
    if (!r.ok) { routeCache.set(cs, { ts: now, value: null }); return null; }
    const data = await r.json();
    const fr = data?.response?.flightroute || {};
    const value = {
      airline:     fr.airline?.name || null,
      origin:      fr.origin?.iata_code || fr.origin?.icao_code || null,
      destination: fr.destination?.iata_code || fr.destination?.icao_code || null,
      originName:  fr.origin?.municipality   || fr.origin?.name   || null,
      destName:    fr.destination?.municipality || fr.destination?.name || null,
    };
    routeCache.set(cs, { ts: now, value });
    return value;
  } catch {
    return null;
  }
}

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

  // Enrich the top 25 with route + airline in parallel. Each lookup hits
  // adsbdb.com (free, no auth). 25 is a balance: covers the user's
  // interesting set without making adsbdb angry.
  const top = aircraft.slice(0, 25);
  const routes = await Promise.allSettled(top.map(a => fetchRoute(a.flight)));
  let enrichedCount = 0;

  const lines = top.map((a, i) => {
    const cs = (a.flight || "").trim() || "(no callsign)";
    const alt = a.alt_baro === "ground" ? "ground"
              : (typeof a.alt_baro === "number" ? Math.round(a.alt_baro) + " ft" : "?");
    const spd = typeof a.gs === "number" ? Math.round(a.gs) + " kt" : "?";
    const trk = typeof a.track === "number" ? Math.round(a.track) + "°" : "?";
    const dist = typeof a.distNm === "number" ? Math.round(a.distNm) + " nm" : "?";

    const r = routes[i].status === "fulfilled" ? routes[i].value : null;
    let suffix = "";
    if (r) {
      enrichedCount++;
      const route = r.origin && r.destination
          ? `${r.origin}→${r.destination}` : null;
      const airline = r.airline || null;
      const cityRoute = r.originName && r.destName
          ? `(${r.originName}→${r.destName})` : null;
      suffix = "  " + [airline, route, cityRoute].filter(Boolean).join("  ");
    }

    return `  ${cs.padEnd(10)}  ${(a.hex||"").padEnd(7)}  alt ${alt}  spd ${spd}  trk ${trk}  dist ${dist}${suffix}`;
  }).join("\n");

  const prompt =
`You are an aviation assistant. The user is watching live ADS-B traffic
around ${city || "an airport"}. ${aircraft.length} aircraft are currently
in range. The closest ${top.length} are listed below, with airline and
scheduled route appended where adsbdb.com could resolve them.

Write a short paragraph (no headers, no preamble) describing what's
going on in the sky right now — the dominant flow (which airlines and
which routes are most represented, are people arriving or departing),
any standouts (rare routes, unusual altitudes, military or business
traffic if you can spot it from the callsign / airline), and anything
notable.

Then 3-5 bullet points on the most interesting individual flights.
Mention each one by callsign, airline, route, and what makes it
interesting in one short sentence. Keep the whole reply under 180 words.
Stay factual; if you can't identify something, say so.

Aircraft (top ${top.length} of ${aircraft.length}):
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
