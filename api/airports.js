// Vercel serverless function — returns every bundled airport within
// a given radius of (lat, lon). Used by the 3D view to plant ground
// markers + IATA labels around the user's chosen centre.
//
// Endpoint: GET /api/airports?lat=52.84&lon=-6.93&dist=200
//   lat, lon, dist (nm) — required, all numeric
//
// Returns: { centre: {lat, lon}, count, airports: [{iata, icao, name, city, country, lat, lon, distNm}, ...] }
//
// Cap of 60 returned to keep the 3D scene readable.

import { AIRPORTS } from "./_airports.js";

const MAX_RESULTS = 60;

export default function handler(req, res) {
  const lat = parseFloat(req.query.lat);
  const lon = parseFloat(req.query.lon);
  const dist = Math.min(500, parseFloat(req.query.dist) || 200);
  if (isNaN(lat) || isNaN(lon)) {
    return res.status(400).json({ error: "lat and lon required" });
  }

  // AIRPORTS is keyed by both IATA and ICAO — dedupe by iata.
  const seen = new Set();
  const within = [];
  for (const v of Object.values(AIRPORTS)) {
    if (seen.has(v.iata)) continue;
    seen.add(v.iata);
    const nm = haversineNm(lat, lon, v.lat, v.lon);
    if (nm <= dist) {
      within.push({ ...v, distNm: Math.round(nm) });
    }
  }
  within.sort((a, b) => a.distNm - b.distNm);

  res.setHeader("Cache-Control", "public, s-maxage=3600");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.status(200).json({
    centre: { lat, lon },
    count: within.length,
    airports: within.slice(0, MAX_RESULTS)
  });
}

function haversineNm(lat1, lon1, lat2, lon2) {
  const R = 3440.065;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
            Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
