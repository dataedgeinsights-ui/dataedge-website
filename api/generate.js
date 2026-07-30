/**
 * /api/generate  —  server-side proxy to the Anthropic Messages API.
 *
 * Why this exists
 * ---------------
 * Inside Claude.ai, an artifact can call api.anthropic.com with no key because
 * the host injects authentication. On a normal website that mechanism does not
 * exist, and a key placed in the page source would be readable by anyone. So
 * the browser calls this function instead, and the function holds the key.
 *
 * Deploy target
 * -------------
 * Written for Vercel's Node runtime: drop this file at api/generate.js in the
 * repository root and the route /api/generate exists automatically. Netlify
 * uses a different handler signature; ask and it can be supplied.
 *
 * Uses ESM (export default), matching the previous version of this file, so it
 * works whether or not the project's package.json declares "type": "module".
 *
 * Required environment variable
 * -----------------------------
 *   ANTHROPIC_API_KEY      your key, set in the host's dashboard, never in code
 *
 * Optional environment variables
 * ------------------------------
 *   ALLOWED_ORIGINS        comma-separated list, e.g.
 *                          (required when the site and this function are on
 *                          different domains, since the browser will refuse the
 *                          response without a matching CORS header)
 *                          https://www.dataedgeinsights.org,https://dataedgeinsights.org
 *                          Requests from other origins are refused. Defaults to
 *                          allowing same-origin requests only.
 *   DEFAULT_MODEL          model used when the caller does not name one, and
*                          always permitted. Default: claude-sonnet-4-6
*   ALLOWED_MODELS         comma-separated list of additional permitted models
 *   MAX_TOKENS_CAP         hard ceiling on max_tokens. Default: 8000
 *   REQUIRE_ACCESS_CODE    set to "1" to require a valid subscription code on
 *                          every request (see VERIFY_URL). Default: off.
 *   VERIFY_URL             the Apps Script web-app URL used by the tools to
 *                          verify codes. Only needed when REQUIRE_ACCESS_CODE=1.
 *   VERIFY_ACTION          action name passed to that endpoint.
 *                          Default: verifySubscription
 */

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

/* Overridable with the DEFAULT_MODEL environment variable, so the model can be
   changed in the hosting dashboard rather than in this file. Whatever is set
   here is automatically permitted, in addition to ALLOWED_MODELS. */
const DEFAULT_MODEL = (process.env.DEFAULT_MODEL || "claude-sonnet-4-6").trim();
const DEFAULT_MAX_TOKENS = 4000;   // used when the caller sends only a prompt
const BODY_LIMIT_BYTES = 300000;   // ~300KB, enough for a long syllabus

function allowedModels() {
  const list = (process.env.ALLOWED_MODELS || "")
    .split(",").map(s => s.trim()).filter(Boolean);
  if (!list.includes(DEFAULT_MODEL)) list.push(DEFAULT_MODEL);
  return list;
}

function allowedOrigins() {
  return (process.env.ALLOWED_ORIGINS || "")
    .split(",").map(s => s.trim().replace(/\/$/, "")).filter(Boolean);
}

/** Same-origin browser requests send no Origin on some navigations, so an
 *  absent Origin is accepted; a present one must be on the allowlist when an
 *  allowlist is configured. This deters casual reuse of the endpoint. It does
 *  not stop a forged header, so keep a spend cap on the API key as well. */
function originPermitted(req) {
  const list = allowedOrigins();
  if (list.length === 0) return true;
  const origin = (req.headers.origin || "").replace(/\/$/, "");
  if (!origin) return true;
  return list.includes(origin);
}

async function codeAccepted(code) {
  if (process.env.REQUIRE_ACCESS_CODE !== "1") return true;
  if (!code) return false;
  const base = process.env.VERIFY_URL;
  if (!base) return false;
  const action = process.env.VERIFY_ACTION || "verifySubscription";
  const url = `${base}?action=${encodeURIComponent(action)}&code=${encodeURIComponent(code)}`;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    const r = await fetch(url, { signal: ctl.signal });
    clearTimeout(timer);
    const parsed = JSON.parse(await r.text());
    return !!(parsed && parsed.valid);
  } catch (e) {
    return false;   // cannot verify, so do not spend tokens
  }
}

/** Echo the caller's origin back when it is permitted, so a site on another
 *  domain (GitHub Pages, say) can call a function deployed elsewhere. */
function applyCors(req, res) {
  const list = allowedOrigins();
  const origin = (req.headers.origin || "").replace(/\/$/, "");
  if (!origin) return;
  if (list.length === 0 || list.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
}

function apiKey() {
  // ANTHROPIC_API_KEY is the name used in the deployment notes, but an existing
  // project may already hold the key under another name. Any of these will do.
  const names = ["ANTHROPIC_API_KEY", "ANTHROPIC_KEY", "CLAUDE_API_KEY", "API_KEY"];
  for (const n of names) {
    const v = process.env[n];
    if (v && v.trim()) return v.trim();
  }
  return null;
}

function fail(res, status, message) {
  res.status(status).json({ error: { message } });
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  applyCors(req, res);

  if (req.method === "OPTIONS") {
    const list = allowedOrigins();
    const origin = (req.headers.origin || "").replace(/\/$/, "");
    if (list.length === 0 || list.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin || "*");
      res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Dei-Code");
      res.setHeader("Access-Control-Max-Age", "86400");
    }
    return res.status(204).end();
  }

  if (req.method !== "POST") return fail(res, 405, "Use POST.");
  if (!originPermitted(req)) return fail(res, 403, "This endpoint is not available from that origin.");

  // Echo the origin back when it is allowlisted, so the function can serve a
  // site hosted on a different domain (for example GitHub Pages).
  const reqOrigin = (req.headers.origin || "").replace(/\/$/, "");
  if (reqOrigin && (allowedOrigins().length === 0 || allowedOrigins().includes(reqOrigin))) {
    res.setHeader("Access-Control-Allow-Origin", reqOrigin);
    res.setHeader("Vary", "Origin");
  }

  const key = apiKey();
  if (!key) {
    return fail(res, 500, "The server has no API key configured. Set ANTHROPIC_API_KEY in the hosting dashboard and redeploy.");
  }

  // Body arrives parsed on Vercel, but accept a raw string defensively.
  let body = req.body;
  if (typeof body === "string") {
    if (body.length > BODY_LIMIT_BYTES) return fail(res, 413, "That request is too large.");
    try { body = JSON.parse(body); } catch (e) { return fail(res, 400, "Request body is not valid JSON."); }
  }
  if (!body || typeof body !== "object") return fail(res, 400, "Request body is missing.");

  if (body.mcp_servers) {
    return fail(res, 400, "Connector-based features are not available on the hosted version of this tool.");
  }

  if (!(await codeAccepted(req.headers["x-dei-code"]))) {
    return fail(res, 402, "A current subscription code is required for this feature.");
  }

  // Accept both shapes: {prompt} from the Lecture Studio, and a full
  // {model, max_tokens, messages} body from the Evaluation Workbench.
  let messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    if (typeof body.prompt !== "string" || !body.prompt.trim()) {
      return fail(res, 400, "Send either a prompt or a messages array.");
    }
    messages = [{ role: "user", content: body.prompt }];
  }

  const model = typeof body.model === "string" ? body.model : DEFAULT_MODEL;
  if (!allowedModels().includes(model)) return fail(res, 400, "That model is not permitted on this endpoint.");

  const cap = parseInt(process.env.MAX_TOKENS_CAP || "8000", 10);
  const asked = parseInt(body.max_tokens, 10);
  const maxTokens = Math.min(Number.isFinite(asked) && asked > 0 ? asked : DEFAULT_MAX_TOKENS, cap);

  const payload = { model, max_tokens: maxTokens, messages };
  if (typeof body.system === "string" && body.system.trim()) payload.system = body.system;
  if (Array.isArray(body.tools) && body.tools.length) payload.tools = body.tools;

  const serialised = JSON.stringify(payload);
  if (Buffer.byteLength(serialised, "utf8") > BODY_LIMIT_BYTES) {
    return fail(res, 413, "That request is too large. Shorten the source material and try again.");
  }

  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 120000);
    const upstream = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: serialised,
      signal: ctl.signal,
    });
    clearTimeout(timer);

    const text = await upstream.text();
    if (!upstream.ok) {
      // Pass the status through but not the raw upstream body, which can carry
      // request detail that need not reach the browser.
      let message = `The generation service returned an error (${upstream.status}).`;
      try {
        const parsed = JSON.parse(text);
        if (parsed && parsed.error && parsed.error.message) message = parsed.error.message;
      } catch (e) { /* keep the generic message */ }
      console.error("Upstream error", upstream.status);      // status only, no content
      return fail(res, upstream.status === 401 ? 500 : upstream.status, message);
    }

    res.setHeader("Content-Type", "application/json");
    return res.status(200).send(text);   // Anthropic's shape, unaltered
  } catch (e) {
    const timedOut = e && e.name === "AbortError";
    console.error("Proxy failure:", timedOut ? "timeout" : (e && e.message));
    return fail(res, timedOut ? 504 : 502,
      timedOut ? "The generation step took too long and was stopped. Try again with less source material."
               : "Could not reach the generation service. Try again in a moment.");
  }
}

