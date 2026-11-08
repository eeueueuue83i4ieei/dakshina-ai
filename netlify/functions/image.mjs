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

export default async (request, context) => {
  const apiKey = Netlify.env.get("GEMINI_API_KEY");
  if (!apiKey) return json({ message: "Dakshina’s image service is not configured." }, 503);
  const pathname = new URL(request.url).pathname;
  if (request.method !== "POST") return json({ message: "Method not allowed." }, 405);
  {
    if (!apiKey) return json({ message: "Dakshina’s image service is not configured." }, 503);
    const ip = context.ip || "unknown";
    if (!checkRateLimit(ip)) return json({ message: "Too many requests from this connection. Please wait a few minutes." }, 429, { "Retry-After": "600" });
    let body;
    try {
      const raw = await request.text();
      if (raw.length > 10 * 1024 * 1024) return json({ message: "Your photo is too large. Please choose an image under 6 MB." }, 413);
      body = JSON.parse(raw || "{}");
    }
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
};
