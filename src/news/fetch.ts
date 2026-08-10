import { config } from "../config.js";
import { log } from "../logger.js";

export interface NewsItem {
  title: string;
  source: string;
  publishedAt?: string;
  summary?: string;
}

// Free financial RSS feeds used when no NEWS_API_KEY is configured. A broad,
// global spread (US + world + markets/econ) so the brain "reads the whole market".
// Unreachable feeds are tolerated (fetchRss skips failures and de-dupes).
const RSS_FEEDS = [
  { url: "https://feeds.a.dj.com/rss/RSSMarketsMain.xml", source: "WSJ Markets" },
  { url: "https://feeds.a.dj.com/rss/RSSWorldNews.xml", source: "WSJ World" },
  { url: "https://www.cnbc.com/id/100003114/device/rss/rss.html", source: "CNBC Finance" },
  { url: "https://www.cnbc.com/id/100727362/device/rss/rss.html", source: "CNBC Economy" },
  { url: "https://feeds.marketwatch.com/marketwatch/topstories/", source: "MarketWatch" },
  { url: "https://finance.yahoo.com/news/rssindex", source: "Yahoo Finance" },
  { url: "https://www.investing.com/rss/news.rss", source: "Investing.com" },
];

function stripTags(s: string): string {
  return s
    .replace(/<!\[CDATA\[(.*?)\]\]>/gs, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

function parseRss(xml: string, source: string, limit: number): NewsItem[] {
  const items: NewsItem[] = [];
  const blocks = xml.match(/<item[\s\S]*?<\/item>/g) ?? [];
  for (const block of blocks.slice(0, limit)) {
    const title = block.match(/<title>([\s\S]*?)<\/title>/)?.[1];
    const desc = block.match(/<description>([\s\S]*?)<\/description>/)?.[1];
    const date = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1];
    if (title) {
      items.push({
        title: stripTags(title),
        source,
        publishedAt: date ? stripTags(date) : undefined,
        summary: desc ? stripTags(desc).slice(0, 300) : undefined,
      });
    }
  }
  return items;
}

async function fetchRss(perFeed = 6): Promise<NewsItem[]> {
  // Fetch feeds in parallel so more sources don't slow the cycle down.
  const results = await Promise.all(
    RSS_FEEDS.map(async (feed) => {
      try {
        const res = await fetch(feed.url, {
          headers: { "User-Agent": "capitaltinking/0.1" },
        });
        if (!res.ok) {
          log.warn(`RSS ${feed.source} -> ${res.status}`);
          return [] as NewsItem[];
        }
        return parseRss(await res.text(), feed.source, perFeed);
      } catch (e) {
        log.warn(`RSS ${feed.source} failed:`, (e as Error).message);
        return [] as NewsItem[];
      }
    }),
  );
  return results.flat();
}

async function fetchNewsApi(limit: number): Promise<NewsItem[]> {
  const url = new URL("https://newsapi.org/v2/top-headlines");
  url.searchParams.set("category", "business");
  url.searchParams.set("language", "en");
  url.searchParams.set("pageSize", String(limit));
  url.searchParams.set("apiKey", config.news.apiKey);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`NewsAPI ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { articles: any[] };
  return (data.articles ?? []).map((a) => ({
    title: a.title,
    source: a.source?.name ?? "NewsAPI",
    publishedAt: a.publishedAt,
    summary: a.description ?? undefined,
  }));
}

/** Fetch today's latest market news from the best available source. */
export async function fetchLatestNews(limit = 30): Promise<NewsItem[]> {
  let items: NewsItem[];
  if (config.news.apiKey) {
    try {
      items = await fetchNewsApi(limit);
    } catch (e) {
      log.warn("NewsAPI failed, falling back to RSS:", (e as Error).message);
      items = await fetchRss();
    }
  } else {
    items = await fetchRss();
  }
  // de-dupe by title
  const seen = new Set<string>();
  const unique = items.filter((i) => {
    const k = i.title.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  log.info(`Fetched ${unique.length} news items`);
  return unique.slice(0, limit);
}
