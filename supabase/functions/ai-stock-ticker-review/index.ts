import { createClient } from "jsr:@supabase/supabase-js@2";
import { extractText, generateWithFallback } from "../_shared/geminiClient.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY")!;

const MAX_ADD_PER_RUN = 5;
const MAX_REMOVE_PER_RUN = 5;
const MIN_ACTIVE_TICKERS = 10;
const MAX_ACTIVE_TICKERS = 40;

// Edge Functionは約150秒で中断される。Google検索グラウンディング付きの呼び出しは遅めなので
// 1回あたり60秒、全体で120秒を上限にして、固まらずにエラー内容を返せるようにする。
const GEMINI_CALL_TIMEOUT_MS = 60_000;
const TOTAL_BUDGET_MS = 120_000;

type ActiveTicker = { ticker_symbol: string; company_name: string; sector_category: string | null };
type AddProposal = { ticker_symbol: string; company_name: string; company_name_ja?: string; news_query: string; sector_category: string; reason: string };
type RemoveProposal = { ticker_symbol: string; reason: string };

function parseJsonLoose(text: string): unknown {
  const cleaned = text.replace(/^```json\s*/i, "").replace(/^```\s*/, "").replace(/```\s*$/, "").trim();
  return JSON.parse(cleaned);
}

function isValidSymbol(symbol: unknown): symbol is string {
  return typeof symbol === "string" && /^[A-Z]{1,6}(\.[A-Z])?$/.test(symbol);
}

// ---------- Gemini + Google検索グラウンディングで銘柄見直しを提案 ----------
async function proposeTickerChanges(
  activeTickers: ActiveTicker[],
  deadline: number,
): Promise<{ add: AddProposal[]; remove: RemoveProposal[]; model: string }> {
  const systemInstruction = `あなたは機関投資家向けのAI関連銘柄リサーチ担当です。
Google検索を使って、現時点で注目されているAI関連銘柄（半導体・クラウド・ソフトウェア・データ基盤・AIハードウェアなど）の
最新動向を調査してください。米国上場株（NYSE/NASDAQ）を対象とします。
新規追加候補には、日本の投資家が一般的に目にするカタカナ表記の日本語企業名（略称ではなく正式名称または一般的な呼称）を company_name_ja として必ず付与してください。
必ず次のJSON形式のみを出力してください（説明文・コードブロック不要）:
{"add": [{"ticker_symbol": "...", "company_name": "...", "company_name_ja": "...", "news_query": "... AI", "sector_category": "...", "reason": "..."}], "remove": [{"ticker_symbol": "...", "reason": "..."}]}`;

  const currentList = activeTickers
    .map((t) => `- ${t.ticker_symbol} (${t.company_name}, ${t.sector_category ?? "unknown"})`)
    .join("\n");

  const userPrompt = `現在追跡中のAI関連銘柄一覧（${activeTickers.length}銘柄）:
${currentList}

上記リストと最新の市場動向を比較し、次の観点で提案してください。
- add: 現在のリストにないが、AI関連銘柄として今後有望・注目度が高い企業（最多${MAX_ADD_PER_RUN}件、無理に作らなくてよい）
- remove: 現在のリストにあるが、AI関連としての注目度が明らかに低下した、あるいは重大なネガティブ材料がある企業（最多${MAX_REMOVE_PER_RUN}件、無理に作らなくてよい）

必ず上記のJSON形式のみで回答してください。`;

  const { result, model } = await generateWithFallback(
    GEMINI_API_KEY,
    {
      systemInstruction: { parts: [{ text: systemInstruction }] },
      contents: [{ role: "user", parts: [{ text: userPrompt }] }],
      tools: [{ google_search: {} }],
      generationConfig: { temperature: 0.3 },
    },
    (data) => parseJsonLoose(extractText(data)) as { add?: unknown[]; remove?: unknown[] },
    { deadline, perCallTimeoutMs: GEMINI_CALL_TIMEOUT_MS },
  );

  const add = (result.add ?? [])
    .filter((e): e is AddProposal =>
      !!e && typeof e === "object" && isValidSymbol((e as AddProposal).ticker_symbol) && !!(e as AddProposal).company_name
    )
    .slice(0, MAX_ADD_PER_RUN);

  const remove = (result.remove ?? [])
    .filter((e): e is RemoveProposal => !!e && typeof e === "object" && isValidSymbol((e as RemoveProposal).ticker_symbol))
    .slice(0, MAX_REMOVE_PER_RUN);

  return { add, remove, model };
}

Deno.serve(async (_req) => {
  const startedAt = Date.now();
  try {
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    const { data: activeRows, error: activeError } = await supabase
      .from("ai_stock_tickers")
      .select("ticker_symbol, company_name, sector_category")
      .eq("is_active", true);
    if (activeError) throw new Error(`Failed to load active tickers: ${activeError.message}`);

    const activeTickers = (activeRows ?? []) as ActiveTicker[];
    const activeSymbols = new Set(activeTickers.map((t) => t.ticker_symbol));

    const { add, remove, model } = await proposeTickerChanges(activeTickers, startedAt + TOTAL_BUDGET_MS);

    const added: string[] = [];
    const removed: string[] = [];
    const skipped: { symbol: string; reason: string }[] = [];

    // 除外処理（最低追跡数を下回らないように制限）
    let remainingAfterRemoval = activeTickers.length;
    for (const r of remove) {
      if (!activeSymbols.has(r.ticker_symbol)) {
        skipped.push({ symbol: r.ticker_symbol, reason: "現在追跡中ではないためスキップ" });
        continue;
      }
      if (remainingAfterRemoval - 1 < MIN_ACTIVE_TICKERS) {
        skipped.push({ symbol: r.ticker_symbol, reason: `最低追跡銘柄数(${MIN_ACTIVE_TICKERS})を下回るためスキップ` });
        continue;
      }
      const { error } = await supabase
        .from("ai_stock_tickers")
        .update({ is_active: false, removed_at: new Date().toISOString(), removed_reason: r.reason })
        .eq("ticker_symbol", r.ticker_symbol)
        .eq("is_active", true);
      if (error) {
        skipped.push({ symbol: r.ticker_symbol, reason: `DB update failed: ${error.message}` });
        continue;
      }
      removed.push(r.ticker_symbol);
      remainingAfterRemoval -= 1;
    }

    // 追加処理（最大追跡数を超えないように制限）
    let currentCount = remainingAfterRemoval;
    for (const a of add) {
      if (activeSymbols.has(a.ticker_symbol)) {
        skipped.push({ symbol: a.ticker_symbol, reason: "すでに追跡中のためスキップ" });
        continue;
      }
      if (currentCount + 1 > MAX_ACTIVE_TICKERS) {
        skipped.push({ symbol: a.ticker_symbol, reason: `最大追跡銘柄数(${MAX_ACTIVE_TICKERS})を超えるためスキップ` });
        continue;
      }

      const { error } = await supabase
        .from("ai_stock_tickers")
        .upsert(
          {
            ticker_symbol: a.ticker_symbol,
            company_name: a.company_name,
            company_name_ja: a.company_name_ja ?? null,
            news_query: a.news_query || `${a.company_name} AI`,
            sector_category: a.sector_category ?? null,
            is_active: true,
            added_at: new Date().toISOString(),
            added_reason: a.reason,
            removed_at: null,
            removed_reason: null,
          },
          { onConflict: "ticker_symbol" },
        );
      if (error) {
        skipped.push({ symbol: a.ticker_symbol, reason: `DB upsert failed: ${error.message}` });
        continue;
      }
      added.push(a.ticker_symbol);
      currentCount += 1;
    }

    console.log(`[ai-stock-ticker-review] done in ${Date.now() - startedAt}ms: added ${added.length}, removed ${removed.length}, model ${model}`);

    return new Response(JSON.stringify({ added, removed, skipped, model, activeCountBefore: activeTickers.length, activeCountAfter: currentCount }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    // 以前は500だけが記録されて原因が分からなかったため、必ずログにも残す
    console.error(`ai-stock-ticker-review fatal error: ${(err as Error).message}`);
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
