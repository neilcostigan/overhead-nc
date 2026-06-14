// Vercel serverless function — current ISS position from wheretheiss.at
// (free, no auth). Computes distance and bearing from the user's chosen
// city centre so the UI can show "ISS is 4218 km away, NW" without doing
// the haversine math in the browser.
//
// Endpoint: GET /api/iss?lat=…&lon=…
//
// Returns: {
//   lat, lon, altitudeKm, velocityKmh, visibility, footprintKm,
//   distNm, distKm, bearingDeg, isOverhead
// }
//
// "Overhead" here means the ISS is within its visibility footprint of the
// observer — roughly 2200 km on either side of the ground track. When
// isOverhead is true, the station could be seen if it were a dawn / dusk
// pass with no cloud.

const UPSTREAM = "https://api.wheretheiss.at/v1/satellites/25544";

// ISS moves ~7.66 km/s — at 5s polling the position is off by ~38 km.
// Cache for 4s so concurrent visitors share the same call.
const CACHE_MS = 4 * 1000;
let cached = null;

export default async function handler(req, res) {
  const lat = parseFloat(req.query.lat);
  const lon = parseFloat(req.query.lon);

  const now = Date.now();
  let data = (cached && now - cached.ts < CACHE_MS) ? cached.data : null;
  if (!data) {
    try {
      const r = await fetch(UPSTREAM, {
        headers: { "Accept": "application/json",
                   "User-Agent": "nc-overhead/0.1" }
      });
      if (!r.ok) {
        return res.status(502).json({ error: "wheretheiss " + r.status });
      }
      data = await r.json();
      cached = { ts: now, data };
    } catch (e) {
      return res.status(500).json({ error: String(e) });
    }
  }

  const body = {
    lat: data.latitude,
    lon: data.longitude,
    altitudeKm: data.altitude,
    velocityKmh: data.velocity,
    visibility: data.visibility,
    footprintKm: data.footprint
  };

  if (!isNaN(lat) && !isNaN(lon)) {
    const distKm = haversineKm(lat, lon, data.latitude, data.longitude);
    body.distKm = Math.round(distKm);
    body.distNm = Math.round(distKm * 0.539957);
    body.bearingDeg = Math.round(bearingDeg(lat, lon, data.latitude, data.longitude));
    body.isOverhead = distKm <= (data.footprint || 4400) / 2;
  }

  res.setHeader("Cache-Control", "public, s-maxage=4");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.status(200).json(body);
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
            Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function bearingDeg(lat1, lon1, lat2, lon2) {
  const toRad = d => d * Math.PI / 180;
  const toDeg = r => r * 180 / Math.PI;
  const f1 = toRad(lat1), f2 = toRad(lat2);
  const dl = toRad(lon2 - lon1);
  const y = Math.sin(dl) * Math.cos(f2);
  const x = Math.cos(f1) * Math.sin(f2) -
            Math.sin(f1) * Math.cos(f2) * Math.cos(dl);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}
