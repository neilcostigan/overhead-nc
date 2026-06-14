# Overhead — online build

Public, hosted, no-receiver ADS-B viewer. One static HTML page plus a single
Vercel serverless function. Centred on **Stockholm Arlanda**, switchable to
**Dublin** or **London Heathrow** via the chips in the banner (or `?city=DUB`
in the URL).

The page makes clear it's the online build — no local DVB-T antenna,
data delayed 2–10 s via the [adsb.fi](https://adsb.fi) community
aggregator.

## Layout

```
web-online/
├── index.html              static page
├── api/
│   └── aircraft.json.js    Vercel Node serverless function
├── vercel.json             routing + cache headers
├── package.json            engines: node ≥18
└── .gitignore
```

## Run locally

```sh
cd web-online
npm i -g vercel              # one-time
vercel dev                   # serves on http://localhost:3000
```

## Deploy to Vercel — direct

```sh
cd web-online
vercel               # first-run prompts you to link or create a project
vercel --prod        # subsequent prod deploys
```

## Deploy via GitHub (recommended for auto-deploy)

1. Create a repo on GitHub, e.g. `lnrsflightsense-online`.
2. From inside `web-online/`:

   ```sh
   git init
   git add .
   git commit -m "initial commit"
   git branch -M main
   git remote add origin git@github.com:<you>/lnrsflightsense-online.git
   git push -u origin main
   ```

3. On Vercel: **Add New… → Project → Import** the GitHub repo. Accept the
   defaults — Vercel detects Node and the `api/` folder automatically.
4. Every push to `main` re-deploys. Pull requests get preview URLs.

## Switching cities

Five presets baked in:

| Code   | ICAO | Centre               | URL              |
|--------|------|----------------------|------------------|
| ARN    | ESSA | Stockholm Arlanda    | `/?city=ARN`     |
| DUB    | EIDW | Dublin               | `/?city=DUB`     |
| LHR    | EGLL | London Heathrow      | `/?city=LHR`     |
| EXT    | EGTE | Exeter               | `/?city=EXT`     |
| CARLOW | —    | Carlow (town)        | `/?city=CARLOW`  |

Carlow has no airport — it's a town-centre vantage point. The 100 nm
radius still picks up passing transatlantic and European traffic.

Add more by editing the `CITIES` map at the top of the `<script>` in
`index.html` — they pop into the banner automatically.

## Per-aircraft detail

Click any aircraft row in the sidebar. An inline card expands underneath
showing:

- Registration, type and operator — pulled from
  [hexdb.io](https://hexdb.io) via `/api/aircraft-info`.
- Scheduled origin / destination — pulled from
  [adsbdb.com](https://www.adsbdb.com) via `/api/route`.
- An **Explain** button that calls Gemini and writes a 100-word
  paragraph about who's flying, what type, and where to.

Both upstream APIs are free, no-auth, generous limits. Both responses
cache in the serverless function (24 h for aircraft info, 6 h for routes)
so reopening the same flight doesn't hammer them.

## Enabling Explain (Gemini)

Without a key the Explain button returns a 503 with a friendly message.
To enable:

1. Get a key at <https://aistudio.google.com/apikey>.
2. Vercel project → **Settings → Environment Variables** → add
   `GEMINI_API_KEY` with the key as the value. Pick "All Environments".
3. Redeploy: any push, or in the dashboard **Deployments → … → Redeploy**.
4. Optional: also set `GEMINI_MODEL` if you want a model other than the
   default `gemini-2.5-flash-lite` (e.g. `gemini-2.5-flash` for a better
   answer at higher cost).

Identical clicks within an hour reuse the cached reply so you can't
accidentally burn quota.

## What this is not

Online build deliberately omits:

- the raw Mode-S feed (no local dump1090)
- persistent history (Vercel functions are stateless)
- desktop notifications (browser-only context)

For all of those, use the Java app (`local flight sense with llm`) — it
talks to a Pi or a local USB dongle directly.

## Cost & limits

- Hobby Vercel plan is fine: a few hundred invocations per visitor per
  hour, easily under the free tier.
- Upstream adsb.fi is rate-limited to 1 req/sec. The function caches
  responses for 1.5 s so concurrent visitors share one upstream call.
