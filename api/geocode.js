// Vercel serverless function — turns a free-text place name into lat/lon
// via Nominatim (OpenStreetMap). Used by the dropdown's text input so the
// user can type "Reykjavík" or "Cape Town" and the radar centres there.
//
// Endpoint: GET /api/geocode?q=Tokyo
//
// Returns: { name, displayName, lat, lon, type, country } or
//          { q, missing: true }
//
// Nominatim usage policy: max 1 req/s, must send a User-Agent that
// identifies the app. We cache 24 h per query so a busy site stays
// well under their limit.

const UPSTREAM = "https://nominatim.openstreetmap.org/search";
const UA = "nc-overhead/0.1 (https://overhead-nc.vercel.app)";

const CACHE_MS = 24 * 60 * 60 * 1000;
const cache = new Map();   // q (lowercase) → { ts, body }

export default async function handler(req, res) {
  const q = (req.query.q || "").toString().trim();
  if (q.length < 2 || q.length > 100) {
    return res.status(400).json({ error: "q must be 2-100 chars" });
  }
  const key = q.toLowerCase();
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.ts < CACHE_MS) {
    res.setHeader("X-Cache", "HIT");
    return ok(res, hit.body);
  }
  try {
    const url = `${UPSTREAM}?format=json&limit=1&q=${encodeURIComponent(q)}`;
    const r = await fetch(url, {
      headers: { "User-Agent": UA, "Accept": "application/json" }
    });
    if (!r.ok) {
      return res.status(502).json({ error: "nominatim " + r.status });
    }
    const data = await r.json();
    if (!Array.isArray(data) || data.length === 0) {
      const body = { q, missing: true };
      cache.set(key, { ts: now, body });
      return ok(res, body);
    }
    const top = data[0];
    // Pull the most useful single label out of Nominatim's payload.
    const name = top.name
              || top.display_name?.split(",")[0]
              || q;
    const body = {
      name,
      displayName: top.display_name || name,
      lat: parseFloat(top.lat),
      lon: parseFloat(top.lon),
      type: top.type || null,
      country: top.address?.country || null
    };
    cache.set(key, { ts: now, body });
    res.setHeader("X-Cache", "MISS");
    ok(res, body);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

function ok(res, body) {
  res.setHeader("Cache-Control", "public, s-maxage=86400");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.status(200).json(body);
}
