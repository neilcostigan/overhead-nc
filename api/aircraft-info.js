// Vercel serverless function — looks up registration, type, operator for
// a single ICAO24 hex code via hexdb.io. Free, no auth, generous limits.
//
// Endpoint: GET /api/aircraft-info?hex=4ACA90
//
// Returns: { hex, registration, type, manufacturer, operator } or
//          { hex, missing: true } when the database has no record.

const UPSTREAM = "https://hexdb.io/api/v1/aircraft";

const CACHE_MS = 24 * 60 * 60 * 1000;   // 24 h — these values change rarely
const cache = new Map();                 // hex → { ts, body }

export default async function handler(req, res) {
  const hex = (req.query.hex || "").toString().trim().toLowerCase();
  if (!/^[0-9a-f]{6}$/.test(hex)) {
    return res.status(400).json({ error: "hex must be 6 hex chars" });
  }
  const now = Date.now();
  const cached = cache.get(hex);
  if (cached && now - cached.ts < CACHE_MS) {
    res.setHeader("X-Cache", "HIT");
    return ok(res, cached.body);
  }
  try {
    const r = await fetch(`${UPSTREAM}/${hex}`, {
      headers: { "Accept": "application/json",
                 "User-Agent": "nc-overhead/0.1" }
    });
    if (r.status === 404) {
      const body = { hex, missing: true };
      cache.set(hex, { ts: now, body });
      return ok(res, body);
    }
    if (!r.ok) {
      return res.status(200).json({ hex, _upstream: r.status });
    }
    const data = await r.json();
    const body = {
      hex,
      registration: data.Registration || null,
      type: data.ICAOTypeCode || null,
      manufacturer: data.Manufacturer || null,
      operator: data.RegisteredOwners || null
    };
    cache.set(hex, { ts: now, body });
    res.setHeader("X-Cache", "MISS");
    ok(res, body);
  } catch (e) {
    res.status(200).json({ hex, _error: String(e) });
  }
}

function ok(res, body) {
  res.setHeader("Cache-Control", "public, s-maxage=86400");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.status(200).json(body);
}
