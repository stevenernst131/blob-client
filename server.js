import express from "express";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const BLOB_KEY = process.env.EMBR_BLOB_KEY || "";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build the absolute data-plane URL for a blob operation. */
function blobUrl(_req, path) {
  let base;
  if (process.env.EMBR_BLOB_URL) {
    // EMBR_BLOB_URL may lack a scheme — ensure it starts with https://
    const raw = process.env.EMBR_BLOB_URL;
    base = raw.startsWith("http://") || raw.startsWith("https://") ? raw : `https://${raw}`;
  } else if (process.env.EMBR_APP_HOSTNAME) {
    base = `https://${process.env.EMBR_APP_HOSTNAME}/_embr/blob`;
  } else {
    base = "http://localhost:3000/_embr/blob";
  }

  // Normalize: strip trailing slashes, then append path
  base = base.replace(/\/+$/, "");
  const suffix = (path ?? "").replace(/^\/+/, "");
  return suffix ? `${base}/${suffix}` : `${base}/`;
}

/** Extract scheme+host from a full URL. */
function extractOrigin(url) {
  if (!url) return null;
  try { return new URL(url).origin; } catch { return null; }
}

/** Standard headers for authenticated data-plane calls. */
function authHeaders() {
  return { Authorization: `Bearer ${BLOB_KEY}` };
}

/** Forward an upstream error response to the client. */
async function forwardError(upstreamRes, res) {
  const body = await upstreamRes.text();
  res.status(upstreamRes.status).type("text/plain").send(body);
}

// ---------------------------------------------------------------------------
// Static files
// ---------------------------------------------------------------------------

app.use(express.static(join(__dirname, "public")));

// ---------------------------------------------------------------------------
// Health check — also surfaces whether the blob key is configured
// ---------------------------------------------------------------------------

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, blobKeyConfigured: BLOB_KEY.length > 0 });
});

app.get("/api/debug", (req, res) => {
  const resolvedUrl = blobUrl(req, "");
  res.json({
    blobKeyLength: BLOB_KEY.length,
    blobKeyPrefix: BLOB_KEY.length > 4 ? BLOB_KEY.slice(0, 4) + "…" : "(empty)",
    constructedBlobUrl: resolvedUrl,
    env: {
      PORT: process.env.PORT || "(default 3000)",
      EMBR_BLOB_URL: process.env.EMBR_BLOB_URL || "(not set)",
      EMBR_APP_HOSTNAME: process.env.EMBR_APP_HOSTNAME || "(not set)",
      EMBR_BLOB_KEY_SET: !!process.env.EMBR_BLOB_KEY,
    },
  });
});

// ---------------------------------------------------------------------------
// List blobs  GET /api/blobs?prefix=&pageSize=&continuationToken=
// ---------------------------------------------------------------------------

app.get("/api/blobs", async (req, res) => {
  if (!BLOB_KEY) {
    return res.status(503).json({ error: "EMBR_BLOB_KEY is not configured" });
  }

  const qs = new URLSearchParams();
  if (req.query.prefix) qs.set("prefix", req.query.prefix);
  if (req.query.pageSize) qs.set("pageSize", req.query.pageSize);
  if (req.query.continuationToken) qs.set("continuationToken", req.query.continuationToken);

  const qsStr = qs.toString();
  const url = blobUrl(req, qsStr ? `?${qsStr}` : "");

  console.log(`[list] → ${url}  (key length: ${BLOB_KEY.length})`);
  console.log(`[list] headers: ${JSON.stringify(authHeaders())}`);

  try {
    const upstream = await fetch(url, { headers: authHeaders() });
    const responseHeaders = Object.fromEntries(upstream.headers.entries());
    console.log(`[list] ← ${upstream.status} ${upstream.statusText}`);
    console.log(`[list] response headers: ${JSON.stringify(responseHeaders)}`);

    if (!upstream.ok) {
      const errorBody = await upstream.text();
      console.error(`[list] error body: ${errorBody}`);
      res.status(upstream.status).type("text/plain").send(errorBody);
      return;
    }

    const rawBody = await upstream.text();
    console.log(`[list] response body: ${rawBody}`);

    let data;
    try { data = JSON.parse(rawBody); } catch (e) {
      console.error(`[list] failed to parse JSON: ${e.message}`);
      return res.status(502).json({ error: "Invalid JSON from upstream", raw: rawBody.slice(0, 500) });
    }

    console.log(`[list] blob count: ${data.count}, keys: ${(data.blobs || []).map(b => b.key).join(", ")}`);
    if (data.continuationToken) console.log(`[list] continuationToken: ${data.continuationToken}`);

    res.json(data);
  } catch (err) {
    console.error(`[list] fetch error: ${err.message}\n${err.stack}`);
    res.status(502).json({ error: `Failed to list blobs: ${err.message}` });
  }
});

// ---------------------------------------------------------------------------
// Upload blob  POST /api/blobs/:key(*)
// Streams the request body to PUT /_embr/blob/:key
// ---------------------------------------------------------------------------

app.post("/api/blobs/*key", async (req, res) => {
  if (!BLOB_KEY) {
    return res.status(503).json({ error: "EMBR_BLOB_KEY is not configured" });
  }

  const key = req.params.key;
  if (!key) {
    return res.status(400).json({ error: "Blob key is required" });
  }

  const contentType = req.get("content-type") || "application/octet-stream";
  const url = blobUrl(req, key);

  try {
    const upstream = await fetch(url, {
      method: "PUT",
      headers: {
        ...authHeaders(),
        "Content-Type": contentType,
      },
      body: req,
      duplex: "half",
    });

    if (!upstream.ok) return await forwardError(upstream, res);

    // Return 201 with the key echoed back
    const data = await upstream.json().catch(() => ({}));
    res.status(201).json({ key, ...data });
  } catch (err) {
    console.error("Upload failed:", err.message);
    res.status(502).json({ error: "Failed to upload blob" });
  }
});

// ---------------------------------------------------------------------------
// Delete blob  DELETE /api/blobs/:key(*)
// ---------------------------------------------------------------------------

app.delete("/api/blobs/*key", async (req, res) => {
  if (!BLOB_KEY) {
    return res.status(503).json({ error: "EMBR_BLOB_KEY is not configured" });
  }

  const key = req.params.key;
  if (!key) {
    return res.status(400).json({ error: "Blob key is required" });
  }

  const url = blobUrl(req, key);

  try {
    const upstream = await fetch(url, {
      method: "DELETE",
      headers: authHeaders(),
    });

    if (!upstream.ok) return await forwardError(upstream, res);
    res.status(204).end();
  } catch (err) {
    console.error("Delete failed:", err.message);
    res.status(502).json({ error: "Failed to delete blob" });
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`Blob client listening on http://localhost:${PORT}`);
  if (!BLOB_KEY) {
    console.warn("⚠  EMBR_BLOB_KEY is not set — blob operations will return 503");
  }
});
