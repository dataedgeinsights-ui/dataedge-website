// /api/generate.js
// Add this file to your GitHub repo at exactly this path: api/generate.js
// (a top-level "api" folder, sibling to wherever your HTML lives).
// Vercel automatically turns any file in /api into a serverless endpoint,
// no extra configuration needed.
//
// This function is the only place your real Anthropic API key ever
// touches the network. It never reaches the browser, so it can't be
// read from page source the way a client-side key could.
//
// Setup:
// 1. Get an API key at https://console.anthropic.com (Settings -> API Keys).
// 2. In your Vercel project: Settings -> Environment Variables -> add
//    ANTHROPIC_API_KEY with that value. Redeploy after adding it.
// 3. That's it - DataEdge_Lecture_Studio.html already calls this endpoint.

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "ANTHROPIC_API_KEY is not set in this Vercel project's environment variables." });
    return;
  }

  const { prompt } = req.body || {};
  if (!prompt || typeof prompt !== "string") {
    res.status(400).json({ error: "Request body must include a 'prompt' string." });
    return;
  }

  try {
    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1000,
        messages: [{ role: "user", content: prompt }]
      })
    });

    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (err) {
    res.status(500).json({ error: "Could not reach Anthropic's API: " + err.message });
  }
}
