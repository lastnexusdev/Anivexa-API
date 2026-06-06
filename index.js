import { getMedia, getHomeFeed, getPopularAnime, getCurrentlyAiringAnime, searchAnime } from "./core/anilist.js";
import { mapAnimeIds }             from "./core/mapper.js";
import paheHandler                 from "./providers/animepahe.js";
import mangaHandler                from "./providers/allmanga.js";
import reanimeHandler              from "./providers/reanime.js";
import anikotoHandler              from "./providers/anikoto.js";
import animeggHandler              from "./providers/animegg.js";
import aninekoHandler              from "./providers/anineko.js";
import anidbappHandler             from "./providers/anidbapp.js";
import { getEpisodesResponse }     from "./core/episode-cache.js";
import { getAsync, setAsync, isFresh, mapTTL, WATCH_TTL, _CACHE_ENABLED } from "./core/smartcache.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=300",
    },
  });
}

function rewriteRequest(request, newPath) {
  const u = new URL(request.url);
  u.pathname = newPath;
  return new Request(u.toString(), { method: request.method, headers: request.headers });
}

function intParam(url, name, fallback, max = 50) {
  const value = Number.parseInt(url.searchParams.get(name) ?? "", 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(1, value));
}

async function cachedJson(cacheKey, ttlMs, producer) {
  const entry = await getAsync(cacheKey);
  if (entry && isFresh(entry)) return json(entry.data);
  const data = await producer();
  await setAsync(cacheKey, data, ttlMs);
  return json(data);
}

function proxiedUrl(origin, target, referer) {
  const u = new URL("/proxy", origin);
  u.searchParams.set("url", target);
  if (referer) u.searchParams.set("referer", referer);
  return u.toString();
}

function rewriteM3U8(text, target, origin, referer) {
  return text.split(/\r?\n/).map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      return line.replace(/URI="([^"]+)"/g, (_, uri) => {
        const absolute = new URL(uri, target).toString();
        return `URI="${proxiedUrl(origin, absolute, referer)}"`;
      });
    }
    const absolute = new URL(trimmed, target).toString();
    return proxiedUrl(origin, absolute, referer);
  }).join("\n");
}

async function handleProxy(url, request) {
  const target = url.searchParams.get("url");
  const referer = url.searchParams.get("referer") ?? "";
  if (!target) return json({ error: "Missing required ?url= param" }, 400);

  let targetUrl;
  try {
    targetUrl = new URL(target);
  } catch {
    return json({ error: "Invalid url param" }, 400);
  }

  const upstream = await fetch(target, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Accept": "*/*",
      "Accept-Language": "en-US,en;q=0.9",
      ...(request.headers.get("Range") ? { Range: request.headers.get("Range") } : {}),
      ...(referer ? { Referer: referer } : {}),
    },
  });
  const contentType = upstream.headers.get("Content-Type") ?? "";
  const isM3U8 = contentType.includes("mpegurl") || contentType.includes("x-mpegurl") || targetUrl.pathname.endsWith(".m3u8") || targetUrl.pathname.endsWith(".m3u");
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Cache-Control": "no-store",
    "Accept-Ranges": upstream.headers.get("Accept-Ranges") ?? "bytes",
  };
  for (const name of ["Content-Length", "Content-Range"]) {
    const value = upstream.headers.get(name);
    if (value) headers[name] = value;
  }

  if (!upstream.ok) {
    return new Response(await upstream.text(), {
      status: upstream.status,
      headers: { ...headers, "Content-Type": contentType || "text/plain; charset=utf-8" },
    });
  }

  if (isM3U8) {
    const rewritten = rewriteM3U8(await upstream.text(), target, url.origin, referer);
    return new Response(rewritten, {
      status: 200,
      headers: { ...headers, "Content-Type": "application/vnd.apple.mpegurl" },
    });
  }

  return new Response(upstream.body, {
    status: upstream.status,
    headers: { ...headers, "Content-Type": contentType || "application/octet-stream" },
  });
}

const watchInflight = new Map();

async function cachedWatch(cacheKey, handlerFn) {
  const entry = await getAsync(cacheKey);
  if (entry && isFresh(entry)) return json(entry.data);

  if (watchInflight.has(cacheKey)) {
    await watchInflight.get(cacheKey).catch(() => {});
    const warm = await getAsync(cacheKey);
    if (warm && isFresh(warm)) return json(warm.data);
    return handlerFn();
  }

  const promise = (async () => {
    const response = await handlerFn();
    if (response.status === 200) {
      try {
        const data = await response.clone().json();
        await setAsync(cacheKey, data, WATCH_TTL);
      } catch {}
    }
    return response;
  })();

  watchInflight.set(cacheKey, promise);
  try   { return await promise; }
  finally { watchInflight.delete(cacheKey); }
}

export default {
  async fetch(request, env) {
    const url  = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin":  "*",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "*",
        },
      });
    }

    if (path === "/proxy") {
      try {
        return handleProxy(url, request);
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    let m = path.match(/^\/map\/(\d+)\/?$/);
    if (m) {
      const anilistId = m[1];
      const cacheKey  = `map:${anilistId}`;
      const entry     = await getAsync(cacheKey);
      if (entry && isFresh(entry)) return json(entry.data);

      try {
        const [data, media] = await Promise.all([
          mapAnimeIds(anilistId),
          getMedia(anilistId).catch(() => null),
        ]);
        await setAsync(cacheKey, data, mapTTL(media?.status ?? "RELEASING"));
        return json(data);
      } catch (e) {
        if (entry) return json(entry.data);
        return json({ error: e.message }, 500);
      }
    }

    if (path === "/home" || path === "/feed") {
      try {
        return cachedJson("discover:home", 10 * 60_000, getHomeFeed);
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    if (path === "/popular") {
      const page = intParam(url, "page", 1);
      const perPage = intParam(url, "perPage", 24);
      try {
        return cachedJson(`discover:popular:${page}:${perPage}`, 10 * 60_000, () => getPopularAnime(page, perPage));
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    if (path === "/airing" || path === "/currently-airing") {
      const page = intParam(url, "page", 1);
      const perPage = intParam(url, "perPage", 24);
      try {
        return cachedJson(`discover:airing:${page}:${perPage}`, 5 * 60_000, () => getCurrentlyAiringAnime(page, perPage));
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    if (path === "/search") {
      const q = url.searchParams.get("q")?.trim() ?? "";
      if (!q) return json({ pageInfo: null, results: [] });
      const page = intParam(url, "page", 1);
      const perPage = intParam(url, "perPage", 24);
      try {
        return cachedJson(`discover:search:${q.toLowerCase()}:${page}:${perPage}`, 10 * 60_000, () => searchAnime(q, page, perPage));
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    m = path.match(/^\/episodes\/(\d+)\/?$/);
    if (m) {
      const anilistId = m[1];
      try {
        return json(await getEpisodesResponse(anilistId, env));
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    m = path.match(/^\/watch\/animepahe\/(\d+)\/(sub|dub)\/animepahe-(\d+)\/?$/);
    if (m) {
      const [, id, audio, ep] = m;
      return cachedWatch(
        `watch:pahe:${id}:${audio}:${ep}`,
        () => paheHandler.fetch(rewriteRequest(request, `/watch/${id}/${audio}/${ep}`))
      );
    }

    m = path.match(/^\/watch\/allmanga\/(\d+)\/(sub|dub)\/allmanga-(\d+)\/?$/);
    if (m) {
      const [, id, audio, ep] = m;
      return cachedWatch(
        `watch:manga:${id}:${audio}:${ep}`,
        () => mangaHandler.fetch(request)
      );
    }

    m = path.match(/^\/watch\/reanime\/(\d+)\/(sub|dub)\/reanime-(\d+)\/?$/);
    if (m) {
      const [, id, audio, ep] = m;
      return cachedWatch(
        `watch:reanime:${id}:${audio}:${ep}`,
        () => reanimeHandler.fetch(rewriteRequest(request, `/watch/${id}/${audio}/${ep}`))
      );
    }

    m = path.match(/^\/stream\/reanime\/(\d+)\/(sub|dub)\/(\d+)\/?$/);
    if (m) {
      const [, id, audio, ep] = m;
      return reanimeHandler.fetch(rewriteRequest(request, `/stream/${id}/${audio}/${ep}`));
    }

    m = path.match(/^\/watch\/anikoto\/(\d+)\/(sub|dub)\/anikoto-(\d+)\/?$/);
    if (m) {
      const [, id, audio, ep] = m;
      return cachedWatch(
        `watch:anikoto:${id}:${audio}:${ep}`,
        () => anikotoHandler.fetch(request)
      );
    }

    m = path.match(/^\/watch\/animegg\/(\d+)\/(sub|dub)\/animegg-(\d+)\/?$/);
    if (m) {
      const [, id, audio, ep] = m;
      return cachedWatch(
        `watch:animegg:${id}:${audio}:${ep}`,
        () => animeggHandler.fetch(request)
      );
    }

    m = path.match(/^\/watch\/anineko\/(\d+)\/(sub|dub)\/anineko-(\d+)\/?$/);
    if (m) {
      const [, id, audio, ep] = m;
      return cachedWatch(
        `watch:anineko:${id}:${audio}:${ep}`,
        () => aninekoHandler.fetch(request)
      );
    }

    m = path.match(/^\/watch\/anidbapp\/(\d+)\/(sub|dub)\/anidbapp-(\d+)\/?$/);
    if (m) {
      const [, id, audio, ep] = m;
      return cachedWatch(
        `watch:anidbapp:${id}:${audio}:${ep}`,
        () => anidbappHandler.fetch(request)
      );
    }

    return json({
      name: "Anivexa API 2.1", //actually i will goon to you if you change this ok? so erm..maybe i wont..or maybe i will idk
      cache: _CACHE_ENABLED,
      providers: [
        "animepahe",
        "allmanga",
        "reanime",
        "anikoto",
        "animegg",
        "anineko",
        "anidbapp",
      ],
      routes: [
        "/home",
        "/popular?page=1",
        "/airing?page=1",
        "/search?q=:query",
        "/proxy?url=:streamUrl&referer=:referer",
        "/map/:anilistId",
        "/episodes/:anilistId",
        "/watch/animepahe/:id/sub|dub/animepahe-:ep",
        "/watch/allmanga/:id/sub|dub/allmanga-:ep",
        "/watch/reanime/:id/sub|dub/reanime-:ep",
        "/stream/reanime/:id/sub|dub/:ep",
        "/watch/anikoto/:id/sub|dub/anikoto-:ep",
        "/watch/animegg/:id/sub|dub/animegg-:ep",
        "/watch/anineko/:id/sub|dub/anineko-:ep",
        "/watch/anidbapp/:id/sub|dub/anidbapp-:ep",
      ],
    });
  },
};
