// Diagnostic endpoint — returns which environment variables the serverless
// functions can actually see at runtime. Values are never echoed back, only
// "present: true | false" and the length, so it's safe to leave deployed.
//
// Endpoint: GET /api/health
//
// Use it to confirm GEMINI_API_KEY actually made it into the deployment.
// If "present" is false here, /api/explain will 503 — fix the env var on
// Vercel and redeploy.

export default function handler(req, res) {
  const checked = ["GEMINI_API_KEY", "GEMINI_MODEL"];
  const env = {};
  for (const name of checked) {
    const v = process.env[name];
    env[name] = {
      present: typeof v === "string" && v.length > 0,
      length: typeof v === "string" ? v.length : 0
    };
  }
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.status(200).json({
    ok: true,
    runtime: process.env.VERCEL ? "vercel" : "local",
    region: process.env.VERCEL_REGION || null,
    env
  });
}
