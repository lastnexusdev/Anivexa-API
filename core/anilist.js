const __name = (fn, _) => fn;

var resolved = new Map();
var inflight = new Map();
var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
var ARM = "https://arm.haglund.dev/api/v2/ids";
var JIKAN = "https://api.jikan.moe/v4";
var ANILIST = "https://graphql.anilist.co";
var STATUS_MAP = {
  "Currently Airing": "RELEASING",
  "Finished Airing": "FINISHED",
  "Not yet aired": "NOT_YET_RELEASED",
  "On Hiatus": "HIATUS"
};

const AL_STATUS_MAP = {
  RELEASING: "RELEASING",
  FINISHED: "FINISHED",
  NOT_YET_RELEASED: "NOT_YET_RELEASED",
  CANCELLED: "FINISHED",
  HIATUS: "HIATUS",
};

async function fetchFromAniList(id) {
  const fullQuery = `query($id:Int){Media(id:$id,type:ANIME){id title{english romaji native} status format episodes seasonYear startDate{year} synonyms nextAiringEpisode{episode airingAt timeUntilAiring}}}`;
  const res = await fetch(ANILIST, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json", "User-Agent": UA },
    body: JSON.stringify({ query: fullQuery, variables: { id } }),
  }).catch(() => null);
  if (!res || !res.ok) return null;
  const json = await res.json();
  return json.data?.Media ?? null;
}

function compactMedia(media) {
  return {
    id: media.id,
    idMal: media.idMal ?? null,
    title: media.title ?? {},
    coverImage: media.coverImage ?? null,
    bannerImage: media.bannerImage ?? null,
    description: media.description ? media.description.replace(/<[^>]*>/g, "") : null,
    status: media.status ?? null,
    format: media.format ?? null,
    episodes: media.episodes ?? null,
    duration: media.duration ?? null,
    season: media.season ?? null,
    seasonYear: media.seasonYear ?? null,
    averageScore: media.averageScore ?? null,
    popularity: media.popularity ?? null,
    genres: media.genres ?? [],
    nextAiringEpisode: media.nextAiringEpisode ?? null,
  };
}

async function aniListPage(variables) {
  const query = `
    query ($page: Int, $perPage: Int, $search: String, $status: MediaStatus, $sort: [MediaSort]) {
      Page(page: $page, perPage: $perPage) {
        pageInfo { currentPage hasNextPage total perPage }
        media(type: ANIME, search: $search, status: $status, sort: $sort, isAdult: false) {
          id
          idMal
          title { english romaji native }
          coverImage { extraLarge large color }
          bannerImage
          description(asHtml: false)
          status
          format
          episodes
          duration
          season
          seasonYear
          averageScore
          popularity
          genres
          nextAiringEpisode { episode airingAt timeUntilAiring }
        }
      }
    }`;

  const res = await fetch(ANILIST, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json", "User-Agent": UA },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`AniList discovery ${res.status}`);
  const json = await res.json();
  if (json.errors?.length) throw new Error(json.errors[0].message);

  const page = json.data?.Page ?? {};
  return {
    pageInfo: page.pageInfo ?? null,
    results: (page.media ?? []).map(compactMedia),
  };
}

async function getPopularAnime(page = 1, perPage = 20) {
  return aniListPage({
    page,
    perPage,
    sort: ["POPULARITY_DESC", "SCORE_DESC"],
  });
}

async function getCurrentlyAiringAnime(page = 1, perPage = 20) {
  return aniListPage({
    page,
    perPage,
    status: "RELEASING",
    sort: ["TRENDING_DESC", "POPULARITY_DESC"],
  });
}

async function searchAnime(query, page = 1, perPage = 24) {
  return aniListPage({
    page,
    perPage,
    search: query,
    sort: ["SEARCH_MATCH", "POPULARITY_DESC"],
  });
}

async function getHomeFeed() {
  const [airing, popular, trending] = await Promise.all([
    getCurrentlyAiringAnime(1, 16),
    getPopularAnime(1, 16),
    aniListPage({ page: 1, perPage: 16, sort: ["TRENDING_DESC", "POPULARITY_DESC"] }),
  ]);
  return { airing: airing.results, popular: popular.results, trending: trending.results };
}

async function getMedia(anilistId) {
  const id = Number(anilistId);
  if (resolved.has(id)) return resolved.get(id);
  if (inflight.has(id)) return inflight.get(id);
  const promise = (async () => {
    const arm = await fetch(`${ARM}?source=anilist&id=${id}`, {
      headers: { "User-Agent": UA, "Accept": "application/json" }
    }).then((r) => {
      if (!r.ok) return null;
      return r.json();
    }).catch(() => null);

    const malId = arm?.myanimelist ?? null;

    if (!malId) {
      const al = await fetchFromAniList(id);
      if (!al) throw new Error(`No data found for AniList ID ${id}`);
      const media = {
        id,
        idMal: null,
        title: {
          english: al.title?.english ?? null,
          romaji: al.title?.romaji ?? null,
          native: al.title?.native ?? null,
        },
        status: AL_STATUS_MAP[al.status] ?? "RELEASING",
        format: al.format ?? null,
        episodes: al.episodes ?? null,
        seasonYear: al.seasonYear ?? null,
        startDate: al.startDate ?? null,
        nextAiringEpisode: al.nextAiringEpisode ?? null,
        synonyms: Array.isArray(al.synonyms) ? al.synonyms : [],
      };
      resolved.set(id, media);
      inflight.delete(id);
      return media;
    }

    const al = await fetchFromAniList(id).catch(() => null);
    let jikan = null;
    for (let attempt = 0; attempt <= 4; attempt++) {
      const r = await fetch(`${JIKAN}/anime/${malId}`, { headers: { "User-Agent": UA, Accept: "application/json" } });
      if (r.status === 429) {
        const wait = (parseInt(r.headers.get("Retry-After") ?? "1") || 1) * 1e3 + attempt * 500;
        if (attempt < 4) {
          await new Promise((res) => setTimeout(res, wait));
          continue;
        }
        throw new Error(`Jikan 429 for MAL ID ${malId} (exhausted retries)`);
      }
      if (!r.ok) throw new Error(`Jikan ${r.status}`);
      jikan = await r.json();
      break;
    }
    const d = jikan.data;
    if (!d) throw new Error(`Jikan returned no data for MAL ID ${malId}`);
    const media = {
      id,
      idMal: malId,
      title: {
        english: d.title_english ?? null,
        romaji: d.title ?? null,
        native: d.title_japanese ?? null
      },
      status: STATUS_MAP[d.status] ?? "RELEASING",
      format: d.type ?? null,
      episodes: d.episodes ?? null,
      seasonYear: al?.seasonYear ?? d.year ?? null,
      startDate: al?.startDate ?? (d.aired?.from ? { year: new Date(d.aired.from).getFullYear() } : null),
      nextAiringEpisode: al?.nextAiringEpisode ?? null,
      synonyms: [
        ...(d.titles?.map((t) => t.title).filter(Boolean) ?? []),
        ...(Array.isArray(al?.synonyms) ? al.synonyms : []),
      ]
    };
    resolved.set(id, media);
    inflight.delete(id);
    return media;
  })().catch((e) => {
    inflight.delete(id);
    throw e;
  });
  inflight.set(id, promise);
  return promise;
}
__name(getMedia, "getMedia");

function forgetMedia(anilistId) {
  resolved.delete(Number(anilistId));
}

export { getMedia, forgetMedia, getPopularAnime, getCurrentlyAiringAnime, searchAnime, getHomeFeed };
