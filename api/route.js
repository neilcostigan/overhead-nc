// Vercel serverless function — resolves a callsign / flight number to its
// scheduled origin and destination airports via adsbdb.com.
//
// Endpoint: GET /api/route?callsign=RYR1234
//
// Returns: { callsign, origin, destination, originName, destName } or
//          { callsign, missing: true } when the route isn't on file.
//
// adsbdb.com is free with no auth; routes change slowly so the result
// caches for 6 h per callsign.

const UPSTREAM = "https://api.adsbdb.com/v0/callsign";

const CACHE_MS = 6 * 60 * 60 * 1000;
const cache = new Map();   // callsign → { ts, body }

export default async function handler(req, res) {
  const callsign = (req.query.callsign || "").toString().trim().toUpperCase();
  if (!/^[A-Z0-9]{2,8}$/.test(callsign)) {
    return res.status(400).json({ error: "callsign must be 2-8 alphanumeric" });
  }
  const now = Date.now();
  const cached = cache.get(callsign);
  if (cached && now - cached.ts < CACHE_MS) {
    res.setHeader("X-Cache", "HIT");
    return ok(res, cached.body);
  }
  try {
    const r = await fetch(`${UPSTREAM}/${callsign}`, {
      headers: { "Accept": "application/json",
                 "User-Agent": "nc-overhead/0.1" }
    });
    if (r.status === 404) {
      const body = { callsign, missing: true };
      cache.set(callsign, { ts: now, body });
      return ok(res, body);
    }
    if (!r.ok) {
      return res.status(200).json({ callsign, _upstream: r.status });
    }
    const data = await r.json();
    // adsbdb wraps payload under data.response.flightroute
    const fr = data?.response?.flightroute || {};
    const origin = fr.origin || {};
    const dest   = fr.destination || {};
    const body = {
      callsign,
      origin:    origin.iata_code || origin.icao_code || null,
      destination: dest.iata_code || dest.icao_code || null,
      originName: origin.municipality || origin.name || null,
      destName:   dest.municipality   || dest.name   || null,
      airline:   data?.response?.flightroute?.airline?.name || null
    };
    cache.set(callsign, { ts: now, body });
    res.setHeader("X-Cache", "MISS");
    ok(res, body);
  } catch (e) {
    res.status(200).json({ callsign, _error: String(e) });
  }
}

function ok(res, body) {
  res.setHeader("Cache-Control", "public, s-maxage=21600");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.status(200).json(body);
}
