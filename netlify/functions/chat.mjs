const PRIMARY_MODEL = "gemini-3.5-flash-lite";
const FALLBACK_MODELS = ["gemini-3.8-flash", "gemini-3.6-flash"];
const RETRYABLE_STATUSES = new Set([502, 503, 504]);
const MAX_BODY_BYTES = 10 * 1024 * 1024;
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
  const rawContents = body.contents.map(item => {
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
  // Gemini expects a valid alternating conversation. Dakshina displays each
  // assistant line as a separate bubble, so combine adjacent messages with
  // the same role and discard any assistant-only opening before the first user.
  const contents = [];
  for (const item of rawContents) {
    if (contents.length && contents[contents.length - 1].role === item.role) {
      contents[contents.length - 1].parts.push(...item.parts);
    } else {
      contents.push({ role: item.role, parts: [...item.parts] });
    }
  }
  while (contents.length && contents[0].role !== "user") contents.shift();
  if (!contents.length || contents[contents.length - 1].role !== "user") {
    throw Object.assign(new Error("Please send a new message to continue the chat."), { status: 400 });
  }
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

  const pathname = new URL(request.url).pathname;
  if (request.method === "POST" && pathname.endsWith("/image")) {
    if (!apiKey) return json({ message: "Dakshina’s image service is not configured." }, 503);
    const ip = context.ip || "unknown";
    if (!checkRateLimit(ip)) return json({ message: "Too many requests from this connection. Please wait a few minutes." }, 429, { "Retry-After": "600" });
    let body;
    try { body = await request.json(); }
    catch { return json({ message: "Please send a valid image prompt." }, 400); }
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    if (!prompt || prompt.length > 1200) return json({ message: "Your image description must be between 1 and 1,200 characters." }, 400);
    const uploaded = body.image && typeof body.image === "object" ? body.image : null;
    let imagePart = null;
    if (uploaded) {
      const mimeType = typeof uploaded.mimeType === "string" ? uploaded.mimeType : "";
      const imageData = typeof uploaded.data === "string" ? uploaded.data : "";
      if (!["image/jpeg", "image/png", "image/webp"].includes(mimeType)) return json({ message: "Upload a JPG, PNG, or WEBP photo." }, 400);
      if (!imageData || imageData.length > 8 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(imageData)) return json({ message: "That photo is empty, too large, or invalid. Please try a smaller image." }, 413);
      imagePart = { inlineData: { mimeType, data: imageData } };
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);
    try {
      const response = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image:generateContent", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [
            { text: uploaded
              ? "Use the uploaded photo as the visual reference for the person. Preserve the person's recognizable facial identity, natural facial features, skin tone, and overall likeness. Follow the requested styling, pose, clothing, lighting, and background changes while keeping the result photorealistic unless another style is requested. Do not replace the person with a different face. User request: " + prompt
              : prompt },
            ...(imagePart ? [imagePart] : [])
          ] }],
          generationConfig: {
            responseModalities: ["TEXT", "IMAGE"],
            responseFormat: { image: { aspectRatio: "1:1", imageSize: "1K" } }
          }
        }),
        signal: controller.signal
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const detail = data?.error?.message || "";
        const message = response.status === 429
          ? "The shared image-generation quota is busy or has run out. Try again later."
          : response.status === 401 || response.status === 403
            ? "The server’s Gemini key does not have access to image generation."
            : "Gemini image generation failed (" + response.status + "). " + detail.slice(0, 260);
        return json({ message }, response.status);
      }
      const parts = data?.candidates?.[0]?.content?.parts || [];
      const imagePart = parts.find(part => part?.inlineData?.data || part?.inline_data?.data);
      const image = imagePart?.inlineData || imagePart?.inline_data;
      if (!image?.data || !image?.mimeType && !image?.mime_type) return json({ message: "Gemini did not return an image. Try a more specific prompt." }, 502);
      if (image.data.length > 12 * 1024 * 1024) return json({ message: "The generated image was too large to send. Try a simpler image prompt." }, 502);
      return json({ image: { data: image.data, mimeType: image.mimeType || image.mime_type }, text: parts.find(part => typeof part.text === "string")?.text || "" });
    } catch (error) {
      return json({ message: error?.name === "AbortError" ? "Image generation took too long. Please try again." : "Could not reach the image-generation service." }, 504);
    } finally {
      clearTimeout(timeout);
    }
  }

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
          : result.response.status === 400
            ? "Gemini rejected the request: " + (message || "The request format was not accepted.")
            : `Gemini rejected the request (${result.response.status}).`;
      return json({ message: friendly }, result.response.status);
    } catch (error) {
      lastIssue = error?.name === "AbortError" ? `Timed out on ${model}.` : "Could not reach the Gemini API.";
      if (index === FALLBACK_MODELS.length) break;
    }
  }
  return json({ message: "Gemini is busy right now 😭 I tried Dakshina’s main and backup models. Please try again in a little while. " + lastIssue }, 503);
};
