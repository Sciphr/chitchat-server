import { Router } from "express";
import { getConfig } from "../config.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

type GiphyImageVariant = {
  url?: string;
  width?: string;
  height?: string;
  webp?: string;
};

type GiphyResult = {
  id?: string;
  title?: string;
  url?: string;
  images?: {
    fixed_width?: GiphyImageVariant;
    fixed_height?: GiphyImageVariant;
    original?: GiphyImageVariant;
  };
};

function mapGif(item: GiphyResult) {
  const best =
    item.images?.fixed_height ||
    item.images?.fixed_width ||
    item.images?.original ||
    {};
  const fallback = item.images?.original || {};
  return {
    id: item.id || "",
    title: item.title || "GIF",
    pageUrl: item.url || "",
    gifUrl: best.url || fallback.url || "",
    webpUrl: best.webp || fallback.webp || "",
    width: Number(best.width || fallback.width || 0) || 0,
    height: Number(best.height || fallback.height || 0) || 0,
  };
}

function buildQuery(params: Record<string, string | number>) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    query.set(key, String(value));
  }
  return query.toString();
}

router.get("/enabled", requireAuth, (_req, res) => {
  const cfg = getConfig().giphy;
  res.json({
    enabled: cfg.enabled && Boolean(cfg.apiKey),
  });
});

router.get("/search", requireAuth, async (req, res) => {
  const cfg = getConfig().giphy;
  if (!cfg.enabled || !cfg.apiKey) {
    res.status(404).json({ error: "GIF search is disabled" });
    return;
  }

  const q = String(req.query.q || "").trim();
  if (q.length < 2) {
    res.status(400).json({ error: "Query must be at least 2 characters" });
    return;
  }

  try {
    const query = buildQuery({
      api_key: cfg.apiKey,
      q,
      limit: cfg.maxResults,
      offset: 0,
      rating: cfg.rating,
      lang: "en",
    });
    const response = await fetch(`https://api.giphy.com/v1/gifs/search?${query}`);
    if (!response.ok) {
      const text = await response.text();
      res.status(502).json({ error: `GIPHY search failed: ${text || response.statusText}` });
      return;
    }
    const payload = (await response.json()) as { data?: GiphyResult[] };
    const results = (payload.data || []).map(mapGif).filter((item) => item.gifUrl);
    res.json({ results });
  } catch (err) {
    res.status(502).json({
      error:
        err instanceof Error
          ? `GIPHY search failed: ${err.message}`
          : "GIPHY search failed",
    });
  }
});

router.get("/trending", requireAuth, async (_req, res) => {
  const cfg = getConfig().giphy;
  if (!cfg.enabled || !cfg.apiKey) {
    res.status(404).json({ error: "GIF search is disabled" });
    return;
  }

  try {
    const query = buildQuery({
      api_key: cfg.apiKey,
      limit: cfg.maxResults,
      rating: cfg.rating,
    });
    const response = await fetch(`https://api.giphy.com/v1/gifs/trending?${query}`);
    if (!response.ok) {
      const text = await response.text();
      res.status(502).json({ error: `GIPHY trending failed: ${text || response.statusText}` });
      return;
    }
    const payload = (await response.json()) as { data?: GiphyResult[] };
    const results = (payload.data || []).map(mapGif).filter((item) => item.gifUrl);
    res.json({ results });
  } catch (err) {
    res.status(502).json({
      error:
        err instanceof Error
          ? `GIPHY trending failed: ${err.message}`
          : "GIPHY trending failed",
    });
  }
});

export default router;
