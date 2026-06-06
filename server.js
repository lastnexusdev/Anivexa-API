import http from "node:http";
import { createReadStream, existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import worker from "./index.js";

const PORT = process.env.PORT ?? 4000;
const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC = join(ROOT, "public");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
};

async function nodeToRequest(req) {
  const host = req.headers["host"] ?? `localhost:${PORT}`;
  const url = `http://${host}${req.url}`;

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? Buffer.concat(chunks) : null;

  return new Request(url, {
    method: req.method,
    headers: req.headers,
    body: body?.length ? body : undefined,
    duplex: "half",
  });
}

function serveStatic(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") return false;

  const url = new URL(req.url, `http://${req.headers.host ?? `localhost:${PORT}`}`);
  const pathname = decodeURIComponent(url.pathname);
  const filePath = pathname === "/" ? join(PUBLIC, "index.html") : join(PUBLIC, pathname);
  const safePath = normalize(filePath);
  if (!safePath.startsWith(PUBLIC) || !existsSync(safePath)) return false;

  res.statusCode = 200;
  res.setHeader("Content-Type", MIME[extname(safePath)] ?? "application/octet-stream");
  res.setHeader("Cache-Control", pathname === "/" ? "no-store" : "public, max-age=3600");
  if (req.method === "HEAD") {
    res.end();
    return true;
  }
  createReadStream(safePath).pipe(res);
  return true;
}

const server = http.createServer(async (req, res) => {
  console.log(`→ ${req.method} ${req.url}`);
  if (serveStatic(req, res)) return;

  try {
    const request  = await nodeToRequest(req);
    const response = await worker.fetch(request, {});

    res.statusCode = response.status;
    for (const [k, v] of response.headers) res.setHeader(k, v);

    const buf = await response.arrayBuffer();
    res.end(Buffer.from(buf));
  } catch (err) {
    console.error("Unhandled error:", err);
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: err.message }));
  }
});

server.listen(PORT, () => {
  console.log(`api-vexa dev server running at http://localhost:${PORT}`);
  console.log(`  Web app http://localhost:${PORT}/`);
  console.log(`  GET /home`);
  console.log(`  GET /popular?page=1`);
  console.log(`  GET /airing?page=1`);
  console.log(`  GET /search?q=query`);
  console.log(`  GET /map/:anilistId`);
  console.log(`  GET /episodes/:anilistId`);
  console.log(`  GET /watch/animepahe/:id/sub|dub/animepahe-:ep`);
  console.log(`  GET /watch/allmanga/:id/sub|dub/allmanga-:ep`);
  console.log(`  GET /watch/reanime/:id/sub|dub/reanime-:ep`);
  console.log(`  GET /watch/anikoto/:id/sub|dub/anikoto-:ep`);
  console.log(`  GET /watch/animegg/:id/sub|dub/animegg-:ep`);
  console.log(`  GET /watch/anineko/:id/sub|dub/anineko-:ep`);
  console.log(`  GET /watch/anidbapp/:id/sub|dub/anidbapp-:ep`);
});
