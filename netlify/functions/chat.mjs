const PRIMARY_MODEL = "gemini-3.5-flash-lite";
const FALLBACK_MODELS = ["gemini-3.8-flash", "gemini-3.6-flash"];
const RETRYABLE_STATUSES = new Set([502, 503, 504]);
const MAX_BODY_BYTES = 256 * 1024;
const MAX_HISTORY_MESSAGES = 36;
const MAX_MESSAGE_CHARS = 12000;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT = 30;
const buckets = new Map();

function json(payload, status = 200, headers = {}) {
  return Response.json(payload, {
    status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers }
  });
}

function checkRateLimit(ip) {
  const now = Date.now();
  let bucket = buckets.get(ip);
  if (!bucket || now - bucket.startedAt >= RATE_WINDOW_MS) {
    bucket = { startedAt: now, count: 0 };
    buckets.set(ip, bucket);
  }
  bucket.count += 1;
  if (buckets.size > 5000) {
    for (const [key, value] of buckets) {
      if (now - value.startedAt >= RATE_WINDOW_MS) buckets.delete(key);
    }
  }
  return bucket.count <= RATE_LIMIT;
}

async function readPayload(request) {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw Object.assign(new Error("Request is too large."), { status: 413 });
  let body;
  try { body = JSON.parse(text || "{}"); }
  catch { throw Object.assign(new Error("Request body must be valid JSON."), { status: 400 }); }

  if (!Array.isArray(body.contents) || body.contents.length < 1 || body.contents.length > MAX_HISTORY_MESSAGES) {
    throw Object.assign(new Error("Chat history is missing or too long. Start a new chat and try again."), { status: 400 });
  }
  let totalChars = 0;
  const contents = body.contents.map(item => {
    if (!item || !["user", "model"].includes(item.role) || !Array.isArray(item.parts) || !item.parts.length) {
      throw Object.assign(new Error("The chat history contains an invalid message."), { status: 400 });
    }
    const parts = item.parts.filter(part => part && typeof part.text === "string").map(part => {
      if (part.text.length > MAX_MESSAGE_CHARS) throw Object.assign(new Error("A message is too long. Please shorten it."), { status: 413 });
      totalChars += part.text.length;
      return { text: part.text };
    });
    if (!parts.length) throw Object.assign(new Error("A message is empty or unsupported."), { status: 400 });
    return { role: item.role, parts };
  });
  if (totalChars > 60000) throw Object.assign(new Error("This conversation is too long. Start a new chat and try again."), { status: 413 });

  const systemParts = body.systemInstruction && Array.isArray(body.systemInstruction.parts)
    ? body.systemInstruction.parts.filter(part => part && typeof part.text === "string").slice(0, 1).map(part => ({ text: part.text.slice(0, 7000) }))
    : [];
  const generation = body.generationConfig && typeof body.generationConfig === "object" ? body.generationConfig : {};
  return {
    ...(systemParts.length ? { systemInstruction: { parts: systemParts } } : {}),
    contents,
    generationConfig: {
      maxOutputTokens: Math.min(Math.max(Number(generation.maxOutputTokens) || 420, 64), 700),
      temperature: Math.min(Math.max(Number(generation.temperature) || 0.9, 0), 1.2)
    }
  };
}

async function callGemini(model, payload, apiKey) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    const data = await response.json().catch(() => ({}));
    return { response, data };
  } finally {
    clearTimeout(timeout);
  }
}

export default async (request, context) => {
  const apiKey = Netlify.env.get("GEMINI_API_KEY");
  if (request.method === "GET" && new URL(request.url).pathname.endsWith("/health")) {
    return json({ ready: Boolean(apiKey), sharedKeyMode: true }, apiKey ? 200 : 503);
  }
  if (request.method !== "POST") return json({ message: "Method not allowed." }, 405, { Allow: "GET, POST" });
  if (!apiKey) return json({ message: "Dakshina’s shared server is not configured yet. The owner must add GEMINI_API_KEY to Netlify Environment Variables." }, 503);

  const ip = context.ip || "unknown";
  if (!checkRateLimit(ip)) {
    return json({ message: "Too many messages from this connection. Please wait a few minutes and try again." }, 429, { "Retry-After": "600" });
  }

  let payload;
  try { payload = await readPayload(request); }
  catch (error) { return json({ message: error.message || "Invalid request." }, error.status || 400); }

  let lastIssue = "";
  for (let index = 0; index < [PRIMARY_MODEL, ...FALLBACK_MODELS].length; index++) {
    const model = [PRIMARY_MODEL, ...FALLBACK_MODELS][index];
    try {
      const result = await callGemini(model, payload, apiKey);
      if (result.response.ok) return json({ data: result.data, model, attemptsMade: index + 1 });
      const message = result.data?.error?.message;
      if (RETRYABLE_STATUSES.has(result.response.status) || (result.response.status === 404 && index < FALLBACK_MODELS.length)) {
        lastIssue = `HTTP ${result.response.status}${message ? ": " + message : ""}`;
        continue;
      }
      const friendly = result.response.status === 401 || result.response.status === 403
        ? "The server’s Gemini key is not authorized. The owner should check the key and its Gemini API access."
        : result.response.status === 429
          ? "The shared Gemini quota or rate limit has been reached. Please try again later."
          : `Gemini rejected the request (${result.response.status}).`;
      return json({ message: friendly }, result.response.status);
    } catch (error) {
      lastIssue = error?.name === "AbortError" ? `Timed out on ${model}.` : "Could not reach the Gemini API.";
      if (index === FALLBACK_MODELS.length) break;
    }
  }
  return json({ message: "Gemini is busy right now 😭 I tried Dakshina’s main and backup models. Please try again in a little while. " + lastIssue }, 503);
};
