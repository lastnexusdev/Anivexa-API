const state = {
  feed: "home",
  selected: null,
  episodes: null,
  audio: "sub",
  selectedEpisode: null,
  sources: [],
  selectedSourceIndex: -1,
  hls: null,
  catalog: new Map(),
};

const els = {
  hero: document.querySelector("#hero"),
  content: document.querySelector("#content"),
  status: document.querySelector("#status"),
  searchForm: document.querySelector("#searchForm"),
  searchInput: document.querySelector("#searchInput"),
  homeButton: document.querySelector("#homeButton"),
  cardTemplate: document.querySelector("#cardTemplate"),
};

const api = async (path) => {
  const res = await fetch(path);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(data.error || `Request failed: ${res.status}`);
  return data;
};

const titleOf = (anime) => anime?.title?.english || anime?.title?.romaji || anime?.title?.native || "Untitled";
const imageOf = (anime) => anime?.coverImage?.extraLarge || anime?.coverImage?.large || "";
const yearOf = (anime) => anime?.seasonYear || "";
const clean = (text, limit = 260) => {
  const value = (text || "").replace(/\s+/g, " ").trim();
  return value.length > limit ? `${value.slice(0, limit).trim()}...` : value;
};

function remember(anime) {
  if (anime?.id) state.catalog.set(Number(anime.id), anime);
  return anime;
}

function setStatus(message, isError = false) {
  els.status.hidden = !message;
  els.status.textContent = message || "";
  els.status.style.color = isError ? "var(--danger)" : "var(--muted)";
}

function refreshIcons() {
  if (window.lucide) window.lucide.createIcons();
}

function setActiveFeed(feed) {
  state.feed = feed;
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.classList.toggle("is-active", tab.dataset.feed === feed);
  });
}

function renderHero(anime, label = "Featured") {
  remember(anime);
  if (!anime) {
    els.hero.innerHTML = "";
    els.hero.style.backgroundImage = "";
    return;
  }

  els.hero.style.backgroundImage = anime.bannerImage ? `url("${anime.bannerImage}")` : `url("${imageOf(anime)}")`;
  els.hero.innerHTML = `
    <div class="hero-inner">
      <p class="kicker">${label}</p>
      <h1>${titleOf(anime)}</h1>
      <p>${clean(anime.description, 330) || "Browse episodes and streams from the Anivexa provider network."}</p>
      <div class="meta-line">${[anime.format, yearOf(anime), anime.episodes ? `${anime.episodes} episodes` : null, anime.averageScore ? `${anime.averageScore}%` : null].filter(Boolean).join(" / ")}</div>
      <div class="actions">
        <button class="primary" type="button" data-open="${anime.id}"><i data-lucide="play"></i><span>Watch</span></button>
        <button class="secondary" type="button" data-open="${anime.id}"><i data-lucide="info"></i><span>Details</span></button>
      </div>
    </div>`;
  refreshIcons();
}

function animeCard(anime) {
  remember(anime);
  const node = els.cardTemplate.content.firstElementChild.cloneNode(true);
  const img = node.querySelector(".poster");
  img.src = imageOf(anime);
  img.alt = titleOf(anime);
  node.querySelector(".score").textContent = anime.averageScore ? `${anime.averageScore}%` : "NEW";
  node.querySelector(".card-title").textContent = titleOf(anime);
  node.querySelector(".card-meta").textContent = [anime.format, yearOf(anime)].filter(Boolean).join(" / ");
  node.addEventListener("click", () => openAnime(anime));
  return node;
}

function renderShelf(title, items) {
  const section = document.createElement("section");
  section.className = "shelf";
  section.innerHTML = `
    <div class="shelf-head">
      <h2>${title}</h2>
    </div>
    <div class="grid"></div>`;
  const grid = section.querySelector(".grid");
  items.forEach((anime) => grid.append(animeCard(anime)));
  return section;
}

function renderGrid(title, items) {
  els.content.innerHTML = "";
  if (!items.length) {
    els.content.innerHTML = `<div class="empty">No anime found.</div>`;
    return;
  }
  els.content.append(renderShelf(title, items));
}

async function loadHome() {
  setActiveFeed("home");
  setStatus("Loading home feed...");
  els.content.innerHTML = "";
  const feed = await api("/home");
  const featured = feed.trending?.[0] || feed.airing?.[0] || feed.popular?.[0];
  renderHero(featured, "Trending now");
  els.content.append(renderShelf("Currently Airing", feed.airing || []));
  els.content.append(renderShelf("Popular Anime", feed.popular || []));
  els.content.append(renderShelf("Trending", feed.trending || []));
  setStatus("");
}

async function loadFeed(feed) {
  setActiveFeed(feed);
  setStatus(`Loading ${feed === "airing" ? "currently airing" : "popular"} anime...`);
  const path = feed === "airing" ? "/airing?perPage=30" : "/popular?perPage=30";
  const data = await api(path);
  renderHero(data.results?.[0], feed === "airing" ? "Currently airing" : "Popular");
  renderGrid(feed === "airing" ? "Currently Airing" : "Popular Anime", data.results || []);
  setStatus("");
}

async function search(q) {
  setActiveFeed("");
  setStatus(`Searching for "${q}"...`);
  const data = await api(`/search?q=${encodeURIComponent(q)}&perPage=30`);
  renderHero(data.results?.[0], "Search result");
  renderGrid(`Search: ${q}`, data.results || []);
  setStatus("");
}

function providerEntries(data, audio) {
  const entries = [];
  for (const [provider, value] of Object.entries(data || {})) {
    if (["page", "type", "mappings"].includes(provider)) continue;
    const lists = value?.episodes || value;
    const episodes = Array.isArray(lists?.[audio]) ? lists[audio] : [];
    if (episodes.length) entries.push({ provider, episodes });
  }
  return entries;
}

function episodeNumber(ep) {
  return Number(ep?.number ?? ep?.episode ?? ep?.ep ?? 0) || 0;
}

function canonicalEpisodes() {
  const byNumber = new Map();
  for (const { provider, episodes } of providerEntries(state.episodes, state.audio)) {
    for (const ep of episodes) {
      const number = episodeNumber(ep);
      if (!number) continue;
      const existing = byNumber.get(number);
      if (!existing) {
        byNumber.set(number, { ...ep, number, providers: [{ provider, ep }] });
      } else {
        existing.providers.push({ provider, ep });
        existing.title ||= ep.title;
        existing.image ||= ep.image;
        existing.description ||= ep.description;
      }
    }
  }
  return [...byNumber.values()].sort((a, b) => a.number - b.number);
}

function episodeProviders(episode) {
  const target = episodeNumber(episode);
  return providerEntries(state.episodes, state.audio)
    .map(({ provider, episodes }) => ({ provider, ep: episodes.find((item) => episodeNumber(item) === target) }))
    .filter((item) => item.ep?.id);
}

function sourceType(value) {
  const type = String(value || "").toLowerCase();
  if (type.includes("hls") || type.includes("m3u8")) return "hls";
  if (type.includes("mp4")) return "mp4";
  if (type.includes("embed") || type.includes("iframe")) return "embed";
  return "direct";
}

function absoluteUrl(url) {
  try {
    return new URL(url, window.location.origin).toString();
  } catch {
    return url;
  }
}

function proxiedStreamUrl(url, referer) {
  const proxied = new URL("/proxy", window.location.origin);
  proxied.searchParams.set("url", absoluteUrl(url));
  if (referer) proxied.searchParams.set("referer", referer);
  return proxied.toString();
}

function normalizeSources(data, provider) {
  const found = [];
  const add = (source) => {
    if (!source?.url) return;
    const type = sourceType([source.extractedType, source.type, source.label, source.name, source.server, source.url].filter(Boolean).join(" "));
    const referer = source.referer || source.headers?.Referer || source.headers?.referer || "";
    const direct = ["hls", "mp4", "direct"].includes(type);
    found.push({
      provider,
      label: source.label || source.name || source.server || source.quality || `${provider} ${type.toUpperCase()}`,
      type,
      url: source.url,
      referer,
      playUrl: direct ? proxiedStreamUrl(source.url, referer) : source.url,
      direct,
    });
  };

  if (data.stream_url) add({ url: data.stream_url, type: "hls", label: data.server || "Primary", referer: data.referer });
  if (Array.isArray(data.streams)) {
    data.streams.forEach((stream) => add(stream));
  }
  if (Array.isArray(data.sources)) {
    data.sources.forEach((source) => {
      if (source.extractedUrl) {
        add({
          url: source.extractedUrl,
          type: source.extractedType || source.type || "direct",
          label: source.name || source.server || "Direct",
          referer: source.referer || source.headers?.Referer,
        });
      } else {
        add({
          url: source.url,
          type: source.type || "embed",
          label: source.name || source.server || "Embed",
          referer: source.referer || source.headers?.Referer,
        });
      }
    });
  }

  const seen = new Set();
  return found.filter((source) => {
    const key = `${source.provider}:${source.type}:${source.url}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => Number(b.direct) - Number(a.direct));
}

function destroyPlayer() {
  if (state.hls) {
    state.hls.destroy();
    state.hls = null;
  }
  const video = document.querySelector("#player");
  if (video) {
    video.pause();
    video.removeAttribute("src");
    video.load();
    video.hidden = false;
  }
  const embedSlot = document.querySelector("#embedSlot");
  if (embedSlot) embedSlot.innerHTML = "";
}

function renderSources() {
  const holder = document.querySelector("#sourceList");
  if (!holder) return;
  if (!state.sources.length) {
    holder.innerHTML = `<p class="meta-line">Pick an episode to load available sources.</p>`;
    return;
  }
  holder.innerHTML = "";
  state.sources.forEach((source, index) => {
    const button = document.createElement("button");
    button.className = "source-button";
    button.classList.toggle("is-active", index === state.selectedSourceIndex);
    button.type = "button";
    button.dataset.sourceIndex = String(index);
    button.innerHTML = `
      <span>${source.provider}</span>
      <strong>${source.label}</strong>
      <small>${source.type.toUpperCase()}</small>`;
    holder.append(button);
  });
}

function renderDetail() {
  const anime = state.selected;
  const episodes = canonicalEpisodes();

  renderHero(anime, "Now watching");
  els.content.innerHTML = `
    <section class="detail">
      <div class="player-panel">
        <video class="player" id="player" controls playsinline poster="${imageOf(anime)}"></video>
        <div id="embedSlot"></div>
        <div class="player-copy">
          <h2>${titleOf(anime)}</h2>
          <p class="meta-line" id="playerMeta">Choose an episode, then pick a source.</p>
          <div class="sources-head">
            <strong>Sources</strong>
            <span class="provider-name" id="sourceCount">${state.sources.length ? `${state.sources.length} available` : "None loaded"}</span>
          </div>
          <div class="source-list" id="sourceList"></div>
        </div>
      </div>
      <aside class="episode-panel">
        <div class="episode-copy">
          <h2>Episodes</h2>
          <div class="mode">
            <button class="${state.audio === "sub" ? "is-active" : ""}" data-audio="sub" type="button">Sub</button>
            <button class="${state.audio === "dub" ? "is-active" : ""}" data-audio="dub" type="button">Dub</button>
          </div>
          <p class="meta-line">${episodes.length} episodes found across ${providerEntries(state.episodes, state.audio).length} sources.</p>
        </div>
        <div class="provider-block">
          <div class="episode-list" id="episodeList"></div>
        </div>
      </aside>
    </section>`;

  const list = document.querySelector("#episodeList");
  if (!episodes.length) {
    list.innerHTML = `<p class="meta-line">No ${state.audio} episodes are available yet.</p>`;
  } else {
    episodes.forEach((ep) => {
      const button = document.createElement("button");
      button.className = "episode";
      button.type = "button";
      button.textContent = ep.number;
      button.title = ep.title || `Episode ${ep.number}`;
      button.classList.toggle("is-active", state.selectedEpisode?.number === ep.number);
      button.addEventListener("click", () => selectEpisode(ep));
      list.append(button);
    });
  }
  renderSources();
}

async function openAnime(anime) {
  state.selected = anime;
  state.episodes = null;
  state.selectedEpisode = null;
  state.sources = [];
  state.selectedSourceIndex = -1;
  setStatus(`Loading episodes for ${titleOf(anime)}...`);
  renderHero(anime, "Loading episodes");
  els.content.innerHTML = "";
  try {
    state.episodes = await api(`/episodes/${anime.id}`);
    renderDetail();
    setStatus("");
  } catch (err) {
    setStatus(err.message, true);
    renderGrid("More to watch", []);
  }
}

async function selectEpisode(ep) {
  state.selectedEpisode = ep;
  state.sources = [];
  state.selectedSourceIndex = -1;
  destroyPlayer();
  renderDetail();
  setStatus(`Loading sources for episode ${ep.number}...`);

  const candidates = episodeProviders(ep);
  const settled = await Promise.allSettled(candidates.map(async ({ provider, ep: providerEp }) => {
    const path = providerEp.id.startsWith("/") ? providerEp.id : `/${providerEp.id}`;
    const data = await api(path);
    return normalizeSources(data, provider);
  }));

  state.sources = settled.flatMap((result) => result.status === "fulfilled" ? result.value : []);
  state.sources.sort((a, b) => Number(b.direct) - Number(a.direct));
  renderDetail();
  const sourceCount = document.querySelector("#sourceCount");
  if (sourceCount) sourceCount.textContent = `${state.sources.length} available`;

  const firstPlayable = state.sources.findIndex((source) => source.direct);
  if (firstPlayable >= 0) {
    await playSource(firstPlayable);
  } else if (state.sources.length) {
    await playSource(0);
  } else {
    setStatus("No playable sources were returned for this episode.", true);
  }
}

async function playSource(index) {
  const source = state.sources[index];
  if (!source) return;
  state.selectedSourceIndex = index;
  renderSources();
  destroyPlayer();

  const video = document.querySelector("#player");
  const embedSlot = document.querySelector("#embedSlot");
  const ep = state.selectedEpisode;
  const meta = document.querySelector("#playerMeta");
  if (meta) {
    meta.textContent = `${source.provider} / ${state.audio.toUpperCase()} / Episode ${ep?.number ?? "?"} / ${source.label}`;
  }

  try {
    if (source.type === "embed") {
      video.hidden = true;
      embedSlot.innerHTML = `<iframe class="embed" src="${source.url}" allowfullscreen referrerpolicy="no-referrer"></iframe>`;
    } else if (source.type === "mp4") {
      video.src = source.playUrl;
      await video.play().catch(() => {});
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = source.playUrl;
      await video.play().catch(() => {});
    } else if (window.Hls?.isSupported()) {
      state.hls = new Hls({ enableWorker: true });
      state.hls.loadSource(source.playUrl);
      state.hls.attachMedia(video);
      state.hls.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => {}));
      state.hls.on(Hls.Events.ERROR, (_, data) => {
        if (data.fatal) setStatus(`Source failed: ${data.details || data.type}`, true);
      });
    } else {
      throw new Error("This browser cannot play the returned stream.");
    }
    setStatus("");
  } catch (err) {
    setStatus(err.message, true);
  }
}

els.searchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const q = els.searchInput.value.trim();
  if (q) search(q).catch((err) => setStatus(err.message, true));
});

els.homeButton.addEventListener("click", () => loadHome().catch((err) => setStatus(err.message, true)));

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    const feed = tab.dataset.feed;
    const task = feed === "home" ? loadHome() : loadFeed(feed);
    task.catch((err) => setStatus(err.message, true));
  });
});

document.addEventListener("click", (event) => {
  const open = event.target.closest("[data-open]");
  if (open) {
    const id = Number(open.dataset.open);
    const anime = state.catalog.get(id) || state.selected;
    if (anime?.id === id) openAnime(anime).catch((err) => setStatus(err.message, true));
  }

  const audio = event.target.closest("[data-audio]");
  if (audio) {
    state.audio = audio.dataset.audio;
    state.selectedEpisode = null;
    state.sources = [];
    state.selectedSourceIndex = -1;
    destroyPlayer();
    renderDetail();
  }

  const source = event.target.closest("[data-source-index]");
  if (source) {
    playSource(Number(source.dataset.sourceIndex));
  }
});

window.addEventListener("DOMContentLoaded", () => {
  refreshIcons();
  loadHome().catch((err) => setStatus(err.message, true));
});
