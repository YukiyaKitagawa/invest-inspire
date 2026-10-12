import { createClient } from "jsr:@supabase/supabase-js@2";
import { extractText, generateWithFallback } from "../_shared/geminiClient.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const FINNHUB_API_KEY = Deno.env.get("FINNHUB_API_KEY")!;
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY")!;

const NEWS_ITEMS_PER_TICKER = 3;

// Edge Functionは約150秒でゲートウェイが504を返して中断される。2026-10に実際に504となり、
// その日の行が1件も保存されなかったため、すべての外部呼び出しにタイムアウトを設け、
// Geminiには全体の締め切りを持たせて、必ず150秒より前に保存まで到達するようにする。
const FETCH_TIMEOUT_MS = 15_000;
const TOTAL_BUDGET_MS = 120_000;

type Ticker = { ticker_symbol: string; company_name: string; news_query: string; sector_category: string | null };

// ---------- 株価取得 (Finnhub) ----------
async function fetchQuote(symbol: string) {
  const url = `https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${FINNHUB_API_KEY}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Finnhub fetch failed for ${symbol}: ${res.status}`);
  const data = await res.json();
  if (data.c === undefined || data.c === null) {
    throw new Error(`Finnhub returned no quote data for ${symbol}`);
  }
  return { currentPrice: data.c as number, priceChangePct: data.dp as number };
}

// ---------- ニュース取得 (Google News RSS) ----------
// description内のHTMLタグはさらにXMLとしてエスケープされているため（例: &amp;nbsp;）、
// 1回のデコードだけでは&amp;→&変換後に現れる&nbsp;等が残る。必ず2回適用する。
function decodeEntitiesOnce(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}
function decodeEntities(text: string): string {
  return decodeEntitiesOnce(decodeEntitiesOnce(text));
}
function stripTags(html: string): string {
  const decoded = decodeEntities(html);
  return decoded.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}
function extractTag(itemXml: string, tag: string): string | null {
  const match = itemXml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  if (!match) return null;
  return match[1].replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "").trim();
}

type NewsArticle = { headline: string; url: string; description: string };

async function fetchTopNews(query: string, count: number): Promise<NewsArticle[]> {
  const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
  const res = await fetch(rssUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`RSS fetch failed: ${res.status}`);
  const xml = await res.text();
  const items = xml.match(/<item>[\s\S]*?<\/item>/g) ?? [];

  return items.slice(0, count).map((item) => ({
    headline: decodeEntities(extractTag(item, "title") ?? ""),
    url: extractTag(item, "link") ?? "",
    description: stripTags(extractTag(item, "description") ?? ""),
  })).filter((a) => a.headline && a.url);
}

// ---------- AI要約・感情分析 (Gemini) — 全銘柄を一括で1回呼び出し。モデルは優先順リストで自動切替 ----------
type NewsBundle = { symbol: string; companyName: string; articles: NewsArticle[] };
type Analysis = { summary: string; sentiment: "positive" | "negative" | "neutral"; impactScore: number };

async function analyzeNewsBatch(items: NewsBundle[], deadline: number): Promise<{ map: Map<string, Analysis>; model: string | null }> {
  if (items.length === 0) return { map: new Map(), model: null };

  const systemInstruction = `あなたは株式市場のニュース分析アナリストです。
複数の銘柄について、それぞれ複数の関連記事が与えられます。それらを総合して、次の方針で日本語要50〜80字に要約してください：
- 「AI需要を取り込む」「を支える」のような抽象的・一般論のみの表現は避ける。
- 記事に具体的な情報（契約先、制品名、数値・金額、発表内容、規制・診査など）があれば必ず盛り込む。
- 複数記事の内容が重複する場合は最も具体的な情報を優先し、異なる観点があれば統合する。
- 具体的な情報が乏しく、抽象的にしか書けない場合は、その旨を正直に反映して短めにする（無理に膚らませない）。

AI関連銘柄への影響という観点で sentiment を "positive" | "negative" | "neutral" のいずれかで判定し、
impact_score を1〜10の整数で評価してください。
入力されたすべての ticker_symbol について、必ず1件ずつ対応するオブジェクトを含めてください。
必ず次のJSON配列形式のみを出力してください（説明文・コードブロック不要）:
[{"ticker_symbol": "...", "summary": "...", "sentiment": "positive|negative|neutral", "impact_score": 1-10}, ...]`;

  const userPrompt = items
    .map((item, i) => {
      const articlesText = item.articles
        .map((a, j) => `  記事${j + 1} 見出し: ${a.headline}\n  記事${j + 1} 本文抄粒: ${a.description}`)
        .join("\n");
      return `${i + 1}. ticker_symbol: ${item.symbol}　企業名: ${item.companyName}\n${articlesText}`;
    })
    .join("\n\n");

  const { result, model } = await generateWithFallback(
    GEMINI_API_KEY,
    {
      systemInstruction: { parts: [{ text: systemInstruction }] },
      contents: [{ role: "user", parts: [{ text: userPrompt }] }],
      generationConfig: { temperature: 0.3, responseMimeType: "application/json" },
    },
    (data) => {
      const parsed = JSON.parse(extractText(data));
      if (!Array.isArray(parsed)) throw new Error("Gemini did not return a JSON array");
      return parsed as Array<Record<string, unknown>>;
    },
    { deadline },
  );

  const map = new Map<string, Analysis>();
  for (const entry of result) {
    if (!entry?.ticker_symbol) continue;
    map.set(String(entry.ticker_symbol), {
      summary: String(entry.summary ?? "").slice(0, 500),
      sentiment: ["positive", "negative", "neutral"].includes(entry.sentiment as string)
        ? (entry.sentiment as Analysis["sentiment"])
        : "neutral",
      impactScore: Math.min(10, Math.max(1, Number(entry.impact_score) || 5)),
    });
  }
  return { map, model };
}

// ---------- エントリーポイント ----------
Deno.serve(async (_req) => {
  const startedAt = Date.now();
  try {
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // 0. 追跡対象銘柄をDBから取得（週次レビューで追加・除外されるためハードコードしない）
    const { data: tickerRows, error: tickerError } = await supabase
      .from("ai_stock_tickers")
      .select("ticker_symbol, company_name, news_query, sector_category")
      .eq("is_active", true);
    if (tickerError) throw new Error(`Failed to load tickers: ${tickerError.message}`);

    const TICKERS = (tickerRows ?? []) as Ticker[];

    // 1. 株価・ニュース（上位${NEWS_ITEMS_PER_TICKER}件）を全銘柄並列取得。
    //    株価は必須、ニュースは任意: Google Newsが失敗しても株価の行は保存する。
    const fetched = await Promise.all(
      TICKERS.map(async (ticker) => {
        const [quoteResult, articlesResult] = await Promise.allSettled([
          fetchQuote(ticker.ticker_symbol),
          fetchTopNews(ticker.news_query, NEWS_ITEMS_PER_TICKER),
        ]);
        const articles = articlesResult.status === "fulfilled" ? articlesResult.value : ([] as NewsArticle[]);
        const newsFailed = articlesResult.status === "rejected";
        if (quoteResult.status === "rejected") {
          return { ticker, quote: null, articles, newsFailed, error: String(quoteResult.reason?.message ?? quoteResult.reason) };
        }
        return { ticker, quote: quoteResult.value, articles, newsFailed, error: null as string | null };
      }),
    );

    const quoteFailedCount = fetched.filter((f) => !f.quote).length;
    const newsFailedCount = fetched.filter((f) => f.newsFailed).length;
    console.log(
      `[ai-stock-intelligence] fetch phase done in ${Date.now() - startedAt}ms: ` +
        `quote failed ${quoteFailedCount}/${fetched.length}, news failed ${newsFailedCount}/${fetched.length}`,
    );

    // 2. ニュースが取れた銘柄だけを、Geminiに1回の呼び出し（モデル自動切替つき）でまとめて分析
    const newsBundles: NewsBundle[] = fetched
      .filter((f) => f.articles.length > 0)
      .map((f) => ({ symbol: f.ticker.ticker_symbol, companyName: f.ticker.company_name, articles: f.articles }));

    let analysisMap = new Map<string, Analysis>();
    let analysisModel: string | null = null;
    let analysisError: string | null = null;
    try {
      const analyzed = await analyzeNewsBatch(newsBundles, startedAt + TOTAL_BUDGET_MS);
      analysisMap = analyzed.map;
      analysisModel = analyzed.model;
    } catch (err) {
      analysisError = (err as Error).message;
      console.error(`[ai-stock-intelligence] Gemini analysis failed: ${analysisError}`);
    }

    // 3. 行を組み立ててINSERT（news_headline/news_urlは最新（先頭）記事を代表として保存）
    const results = [];
    const errors: { symbol: string; message: string }[] = [];

    for (const f of fetched) {
      if (f.error || !f.quote) {
        errors.push({ symbol: f.ticker.ticker_symbol, message: f.error ?? "quote fetch failed" });
        continue;
      }

      const topArticle = f.articles[0];
      const analysis = topArticle ? analysisMap.get(f.ticker.ticker_symbol) : undefined;
      if (topArticle && !analysis && analysisError) {
        errors.push({ symbol: f.ticker.ticker_symbol, message: `AI analysis failed: ${analysisError}` });
      }

      results.push({
        ticker_symbol: f.ticker.ticker_symbol,
        company_name: f.ticker.company_name,
        current_price: f.quote.currentPrice,
        price_change_pct: f.quote.priceChangePct,
        news_headline: topArticle?.headline ?? null,
        news_summary: analysis?.summary ?? topArticle?.description?.slice(0, 500) ?? null,
        news_url: topArticle?.url ?? null,
        market_sentiment: analysis?.sentiment ?? null,
        impact_score: analysis?.impactScore ?? null,
        sector_category: f.ticker.sector_category,
      });
    }

    let inserted = 0;
    if (results.length > 0) {
      const { error, count } = await supabase
        .from("ai_stock_intelligence")
        .insert(results, { count: "exact" });
      if (error) throw new Error(`Insert failed: ${error.message}`);
      inserted = count ?? 0;
    }

    if (errors.length > 0) {
      console.error(`ai-stock-intelligence run completed with ${errors.length} errors: ${JSON.stringify(errors)}`);
    }
    console.log(
      `[ai-stock-intelligence] done in ${Date.now() - startedAt}ms: inserted ${inserted}/${TICKERS.length}, model ${analysisModel ?? "-"}`,
    );

    return new Response(
      JSON.stringify({
        inserted,
        tracked: TICKERS.length,
        newsFailed: newsFailedCount,
        model: analysisModel,
        elapsedMs: Date.now() - startedAt,
        errors,
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error(`ai-stock-intelligence fatal error: ${(err as Error).message}`);
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
