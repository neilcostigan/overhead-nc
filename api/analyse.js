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

import { callLlm } from "./_llm.js";

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
  const { city = "", aircraft = [], mode = "scene", units = "metric", llm: llmSettings = {} } = req.body || {};
  const haveKey = !!(llmSettings.apiKey
                  || process.env.GEMINI_API_KEY
                  || process.env.OPENAI_API_KEY);
  if (!haveKey) {
    return res.status(503).json({
      error: "Analyse disabled — open Settings ⚙ and add a Gemini or OpenAI API key"
    });
  }
  if (!Array.isArray(aircraft) || aircraft.length === 0) {
    return res.status(400).json({ error: "no aircraft in payload" });
  }

  // Mode-specific aircraft selection.
  //   scene     — closest 25 (mix of arrivals, departures, transits)
  //   overflies — high & far: alt ≥ 25 000 ft AND dist ≥ 30 nm, top 25 by alt
  //   unusual   — full list; LLM identifies non-commercial / military /
  //               diplomatic / emergency from callsigns + types
  let candidates;
  if (mode === "overflies") {
    candidates = aircraft
      .filter(a => typeof a.alt_baro === "number" && a.alt_baro >= 25000)
      .filter(a => typeof a.distNm === "number" && a.distNm >= 30)
      .sort((a, b) => (b.alt_baro || 0) - (a.alt_baro || 0));
  } else if (mode === "unusual") {
    candidates = aircraft.slice();   // send everything; LLM filters
  } else {
    candidates = aircraft.slice();   // scene — already sorted by distance client-side
  }
  if (candidates.length === 0) {
    return res.status(200).json({
      text: mode === "overflies"
          ? "_Nothing high overhead right now — no aircraft above FL250 in range._"
          : "_No aircraft visible to summarise._",
      model: null,
      enriched: 0
    });
  }

  // Cache key includes mode so the two views don't collide.
  const fp = candidates.slice(0, 30).map(a => a.hex || "").sort().join(",");
  const ckey = mode + "|" + city + "|" + fp.slice(0, 200);
  const now = Date.now();
  const hit = cache.get(ckey);
  if (hit && now - hit.ts < CACHE_MS) {
    res.setHeader("X-Cache", "HIT");
    return res.status(200).json({ text: hit.text, model: hit.model });
  }

  // Enrich the top N with route + airline in parallel. Each lookup hits
  // adsbdb.com (free, no auth). For "unusual" we widen the net to 40 so
  // the LLM has the most callsign/operator context possible.
  const top = candidates.slice(0, mode === "unusual" ? 40 : 25);
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

  const prompt = mode === "overflies"
      ? overfliesPrompt({ city, all: aircraft, top, lines, units })
      : mode === "unusual"
      ? unusualPrompt  ({ city, all: aircraft, top, lines, units })
      : scenePrompt    ({ city, all: aircraft, top, lines, units });

  const result = await callLlm(prompt, llmSettings, { maxTokens: 2000 });
  if (result.error) {
    return res.status(502).json({
      error: result.error,
      status: result.status,
      body: result.body,
      model: result.model
    });
  }
  cache.set(ckey, { ts: now, text: result.text, model: result.model });
  res.setHeader("X-Cache", "MISS");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.status(200).json({
    text: result.text,
    model: result.model,
    enriched: enrichedCount
  });
}

function unitsLine(units) {
  return units === "aviation"
    ? "Use aviation units (ft / kt / nm) in your reply."
    : "Use metric units (m / km/h / km) in your reply.";
}

function scenePrompt({ city, all, top, lines, units }) {
  return `You are an aviation assistant. The user is watching live ADS-B traffic
around ${city || "an airport"}. ${all.length} aircraft are currently
in range. The closest ${top.length} are listed below, with airline and
scheduled route appended where adsbdb.com could resolve them.

Write a thorough briefing on the scene. Cover, in this order:

  1. The dominant flow — which airlines and which routes appear most,
     are these arrivals into ${city}, departures from it, or passing
     through. If the picture splits clearly between low traffic and
     high traffic, say so.
  2. Standouts — unexpected airlines for this region, rare aircraft
     types, atypical altitudes, anything that breaks the pattern
     (military, head-of-state, ambulance, ferry, business jets).
  3. Schedule context — for the routes you recognise, mention typical
     daily frequency, where this flight sits in the day's rotation,
     and whether it's running on time relative to a normal schedule.
  4. Geographic flow — which direction the traffic is moving as a
     whole; if there's a clear inbound or outbound wave, name it.

Open with a one-paragraph plain-English summary, then expand the four
points above as bullets. Follow with 5-8 bullet points on individual
flights worth a closer look — callsign, airline, type if known, route,
altitude, and why interesting in one or two sentences each. Bold the
key facts. Aim for ~350 words; go longer if there's substance.

Stay factual; if you can't identify something, say so plainly rather
than guess. Don't pad. Don't repeat the prompt.

${unitsLine(units)}

Aircraft (top ${top.length} of ${all.length}):
${lines}`;
}

function overfliesPrompt({ city, all, top, lines, units }) {
  return `You are an aviation assistant. The user is watching live ADS-B traffic
around ${city || "an airport"}. Below are the ${top.length} highest aircraft
currently in range (all at or above FL250, at least 30 nm out — so almost
certainly transit traffic rather than arrivals or departures).

Write a thorough briefing on the high-altitude picture. Cover:

  1. Dominant corridors — which long-haul routes are running overhead
     right now (e.g. North Atlantic westbound, intra-European eastbound,
     polar Asia routes). Name the named ATS routes / NAT tracks where
     you can infer them from the bearings and origin/destination.
  2. Flow direction — is the traffic predominantly outbound, inbound,
     or split. If a clear wave is visible (morning trans-Atlantic
     westbounds, evening Asia eastbounds), say so.
  3. Operators — which airlines dominate at altitude, which alliances
     they belong to, anything regionally unusual (e.g. a US carrier
     deep into Europe, a low-cost in a wide-body role).
  4. Equipment — typical aircraft types in service on these corridors;
     mention if anything stands out (twin vs quad, very new or very old
     variant).
  5. Anomalies — unusual cruise altitudes, unexpected origin/destination
     pairs, unusual operators, military / state / freighter traffic.

Open with a one-paragraph plain-English summary, then expand the five
points above as bullets. Follow with 5-8 bullet points on the most
striking individual overflies — callsign, airline, type if known,
route, altitude, and why interesting in one or two sentences.

Bold the key facts. Aim for ~300 words; longer if there's substance.
Stay factual; if you can't identify a route or operator, say so plainly
rather than guess.

${unitsLine(units)}

High-altitude aircraft (top ${top.length} of ${all.length} in range):
${lines}`;
}

function unusualPrompt({ city, all, top, lines, units }) {
  return `You are an aviation assistant. The user is watching live ADS-B traffic
around ${city || "an airport"}. The full visible list is below
(${top.length} aircraft of ${all.length} in range, enriched with airline
and route where adsbdb.com had them).

Your job is to scan this list and surface every aircraft that is NOT
routine commercial passenger traffic. Specifically look for, and call
out, any of:

  • **Military** — air force, navy, coastguard. Indicators include
    callsigns prefixed RCH, MMF, RRR, GAF, ASCOT, NATO, etc.; missing
    airline; types like C-17, C-130, A330 MRTT, P-8, KC-46, Typhoon,
    F-35, E-3 / E-7 AEW, R/C-135 Rivet Joint.
  • **Government / diplomatic / head of state** — callsigns like
    AF1/Air Force One, EXEC1F, SAM, GAF (German government), SUI001
    (Swiss Air Force VIP), etc. Boeing 737/757/747 or A319/A330 in
    government colours, executive 737-700/-800/BBJ.
  • **Emergency / medical** — squawk patterns (7700, 7600, 7500) when
    visible; LIFEGUARD callsigns; air ambulance operators (Babcock,
    Bond, ORNGE). Helicopters at low altitude near hospitals.
  • **Business jets** — Gulfstream G550/G650, Bombardier Global,
    Dassault Falcon, Cessna Citation, Embraer Praetor / Phenom, when
    operating outside scheduled airline patterns.
  • **Cargo / freighter** — DHL, FedEx, UPS, ASL, Cargolux, Atlas Air,
    777F/747-8F/767F.
  • **Survey / calibration / patrol** — flight inspection, mapping,
    police, border patrol, oil-spill, search-and-rescue.
  • **Anything unusual** — rare type, unexpected operator for the
    region, very low altitude transit, unusual squawk.

Format:

Open with a one-paragraph summary of what (if anything) stands out.
Then bullet each individual flight you've flagged: callsign / hex,
likely category, what it is, what makes it interesting, where it's
going if known. One or two sentences per bullet.

If everything visible looks like routine scheduled commercial traffic,
say so plainly in two sentences and stop.

Bold the key facts. Aim for ~300 words. Do not invent a category for
a flight that doesn't fit — leave routine traffic out.

${unitsLine(units)}

Aircraft (top ${top.length} of ${all.length} in range):
${lines}`;
}
