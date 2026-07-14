import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const LINE_CHANNEL_ACCESS_TOKEN = Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN")!;
const LINE_PUSH_USER_ID = "U5adc26764bb82f1c0ceedaffcb8edda4";
const LINE_PUSH_URL = "https://api.line.me/v2/bot/message/push";

const TOP_N = 3;
// LINEのtextメッセージはUTF-16で2000文字以内という制約があるため、送信前に必ず確認する
const LINE_TEXT_MAX_LENGTH = 2000;

const SENTIMENT_LABELS: Record<string, string> = { positive: "ポジティブ", negative: "ネガティブ", neutral: "中立" };

type UsRow = {
  ticker_symbol: string;
  current_price: number;
  price_change_pct: number | null;
  market_sentiment: string | null;
  impact_score: number | null;
  news_summary: string | null;
};

type JpRow = {
  ticker_symbol: string;
  current_price: number | null;
  price_change_pct: number | null;
  market_sentiment: string | null;
  impact_score: number | null;
  news_summary: string | null;
  recorded_at: string;
};

function notabilityScore(impactScore: number | null, priceChangePct: number | null): number {
  const impact = impactScore ?? 0;
  const change = Math.abs(Number(priceChangePct ?? 0));
  return impact * 2 + change;
}

function formatYen(value: number | null): string {
  if (value === null || value === undefined || isNaN(Number(value))) return "データなし";
  return `¥${Math.round(Number(value)).toLocaleString("ja-JP")}`;
}

// JS文字列の.lengthはUTF-16コードユニット数と一致するため、そのままLINEの文字数上限チェックに使える。
// 超過時は安全側に倒し、末尾を切り詰めて送信自体は継続する（全く送らないより有用なため）。
function enforceLineTextLimit(text: string): { text: string; truncated: boolean; length: number } {
  if (text.length <= LINE_TEXT_MAX_LENGTH) {
    return { text, truncated: false, length: text.length };
  }
  const notice = "\n\n※文字数上限のため一部省略しました";
  const truncated = text.slice(0, LINE_TEXT_MAX_LENGTH - notice.length) + notice;
  return { text: truncated, truncated: true, length: truncated.length };
}

async function buildUsSection(supabase: ReturnType<typeof createClient>): Promise<string | null> {
  const { data: tickers, error: tickerError } = await supabase
    .from("ai_stock_tickers")
    .select("ticker_symbol, company_name, company_name_ja")
    .eq("is_active", true);
  if (tickerError) throw new Error(`Failed to load US tickers: ${tickerError.message}`);

  const nameMap = new Map((tickers ?? []).map((t) => [t.ticker_symbol, t.company_name_ja || t.company_name]));
  const activeSymbols = new Set((tickers ?? []).map((t) => t.ticker_symbol));

  const { data: latest, error: latestError } = await supabase
    .from("ai_stock_intelligence_latest")
    .select("ticker_symbol, current_price, price_change_pct, market_sentiment, impact_score, news_summary");
  if (latestError) throw new Error(`Failed to load US latest snapshot: ${latestError.message}`);

  const rows = (latest ?? []).filter((r) => activeSymbols.has(r.ticker_symbol)) as UsRow[];
  if (rows.length === 0) return null;

  const top = rows.slice().sort((a, b) =>
    notabilityScore(b.impact_score, b.price_change_pct) - notabilityScore(a.impact_score, a.price_change_pct)
  ).slice(0, TOP_N);

  const lines = top.map((r, i) => {
    const name = nameMap.get(r.ticker_symbol) ?? r.ticker_symbol;
    const changeSign = Number(r.price_change_pct ?? 0) >= 0 ? "+" : "";
    const sentiment = r.market_sentiment ? (SENTIMENT_LABELS[r.market_sentiment] ?? r.market_sentiment) : "分析なし";
    const summary = r.news_summary ?? "関連ニュースの要約はありません。";
    return `${i + 1}. ${name}（${r.ticker_symbol}）\n` +
      `株価: $${Number(r.current_price).toFixed(2)}（前日比 ${changeSign}${Number(r.price_change_pct ?? 0).toFixed(2)}%）\n` +
      `AI判定: ${sentiment}\n` +
      `注目理由: ${summary}`;
  });

  const today = new Date().toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "numeric", day: "numeric" });

  return `📊 米国AI関連銘柄 本日の注目 Top${top.length}（${today}引け）\n\n${lines.join("\n\n")}`;
}

async function buildJpSection(supabase: ReturnType<typeof createClient>): Promise<string | null> {
  const { data: tickers, error: tickerError } = await supabase
    .from("jp_stock_tickers")
    .select("ticker_symbol, company_name")
    .eq("is_active", true);
  if (tickerError) throw new Error(`Failed to load JP tickers: ${tickerError.message}`);

  const nameMap = new Map((tickers ?? []).map((t) => [t.ticker_symbol, t.company_name]));
  const activeSymbols = new Set((tickers ?? []).map((t) => t.ticker_symbol));

  const { data: latest, error: latestError } = await supabase
    .from("jp_stock_intelligence_latest")
    .select("ticker_symbol, current_price, price_change_pct, market_sentiment, impact_score, news_summary, recorded_at");
  if (latestError) throw new Error(`Failed to load JP latest snapshot: ${latestError.message}`);

  const rows = (latest ?? []).filter((r) => activeSymbols.has(r.ticker_symbol) && r.market_sentiment !== null) as JpRow[];
  if (rows.length === 0) return null; // JP側の分析がまだ一度も完了していない場合はセクションごと省略

  const top = rows.slice().sort((a, b) =>
    notabilityScore(b.impact_score, b.price_change_pct) - notabilityScore(a.impact_score, a.price_change_pct)
  ).slice(0, TOP_N);

  const lines = top.map((r, i) => {
    const name = nameMap.get(r.ticker_symbol) ?? r.ticker_symbol;
    const changeSign = Number(r.price_change_pct ?? 0) >= 0 ? "+" : "";
    const sentiment = r.market_sentiment ? (SENTIMENT_LABELS[r.market_sentiment] ?? r.market_sentiment) : "分析なし";
    const summary = r.news_summary ?? "関連ニュースの要約はありません。";
    return `${i + 1}. ${name}（${r.ticker_symbol}）\n` +
      `株価: ${formatYen(r.current_price)}（前日比 ${changeSign}${Number(r.price_change_pct ?? 0).toFixed(2)}%）\n` +
      `AI判定: ${sentiment}\n` +
      `注目理由: ${summary}`;
  });

  // JP分析は16:30 JST実行のため、この配信(07:10 JST)時点では前営業日分になる
  const recordedDate = new Date(top[0].recorded_at).toLocaleDateString("ja-JP", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "numeric", day: "numeric",
  });

  return `🇯🇵 日本株(AI・半導体テーマ) 前営業日Top${top.length}（${recordedDate} 16:30時点）\n\n${lines.join("\n\n")}`;
}

Deno.serve(async (_req) => {
  try {
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    const [usSection, jpSection] = await Promise.all([
      buildUsSection(supabase),
      buildJpSection(supabase),
    ]);

    if (!usSection && !jpSection) {
      return new Response(JSON.stringify({ skipped: true, reason: "no active ticker data" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    const sections = [usSection, jpSection].filter((s): s is string => s !== null);
    const rawText = sections.join("\n\n━━━━━━━━━━\n\n") +
      `\n\n※本情報はAIによる分析結果の共有を目的としており、売買を推奨するものではありません。投資判断はご自身の責任で行ってください。`;

    const { text, truncated, length } = enforceLineTextLimit(rawText);
    if (truncated) {
      console.warn(`LINE text truncated: ${length} chars (raw ${rawText.length} chars, limit ${LINE_TEXT_MAX_LENGTH})`);
    }

    const res = await fetch(LINE_PUSH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
      },
      body: JSON.stringify({
        to: LINE_PUSH_USER_ID,
        messages: [{ type: "text", text }],
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`LINE push failed: ${res.status} ${body}`);
    }

    return new Response(
      JSON.stringify({ sent: true, hasUsSection: !!usSection, hasJpSection: !!jpSection, textLength: length, truncated }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
