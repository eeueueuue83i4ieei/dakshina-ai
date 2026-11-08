const IMAGE_MODEL = "gemini-3.1-flash-image";
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT = 8;
const buckets = new Map();

function json(payload, status = 200) {
  return Response.json(payload, {
    status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }
  });
}

function allowed(ip) {
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

export default async (request, context) => {
  if (request.method !== "POST") return json({ message: "Method not allowed." }, 405);
  const apiKey = Netlify.env.get("GEMINI_API_KEY");
  if (!apiKey) return json({ message: "Dakshina’s image service is not configured." }, 503);

  if (!allowed(context.ip || "unknown")) {
    return json({ message: "Too many image requests from this connection. Please wait a few minutes." }, 429);
  }

  let body;
  try {
    const raw = await request.text();
    if (raw.length > 10000) return json({ message: "That image prompt is too large. Please shorten it." }, 413);
    body = JSON.parse(raw || "{}");
  } catch {
    return json({ message: "Please send a valid image prompt." }, 400);
  }

  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt || prompt.length > 1200) {
    return json({ message: "Your image description must be between 1 and 1,200 characters." }, 400);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);
  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${IMAGE_MODEL}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
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
    const mimeType = image?.mimeType || image?.mime_type;
    if (!image?.data || !mimeType) {
      return json({ message: "Gemini did not return an image. Try a more specific prompt." }, 502);
    }
    if (image.data.length > 12 * 1024 * 1024) {
      return json({ message: "The generated image was too large to send. Try a simpler prompt." }, 502);
    }
    return json({
      image: { data: image.data, mimeType },
      text: parts.find(part => typeof part.text === "string")?.text || ""
    });
  } catch (error) {
    return json({
      message: error?.name === "AbortError"
        ? "Image generation took too long. Please try again."
        : "Could not reach the image-generation service."
    }, 504);
  } finally {
    clearTimeout(timeout);
  }
};
