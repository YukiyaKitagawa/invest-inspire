import { createClient } from "jsr:@supabase/supabase-js@2";
import { extractText, generateWithFallback } from "../_shared/geminiClient.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY")!;

// Edge Functionは約150秒で中断されるため、Gemini呼び出し全体に締め切りを設ける
const TOTAL_BUDGET_MS = 120_000;

type PendingRow = {
  id: string;
  ticker_symbol: string;
  company_name: string;
  news_headline: string | null;
  news_summary: string | null;
};

type Analysis = { summary: string; sentiment: "positive" | "negative" | "neutral"; impactScore: number };

// 本日（JST暦日）のUTC時刻範囲を求める
function jstTodayUtcRange(): { start: string; end: string } {
  const now = new Date();
  const jstParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const map = Object.fromEntries(jstParts.map((p) => [p.type, p.value]));
  const y = Number(map.year), m = Number(map.month), d = Number(map.day);
  // JST 00:00 = 前日 UTC 15:00
  const start = new Date(Date.UTC(y, m - 1, d - 1, 15, 0, 0));
  const end = new Date(Date.UTC(y, m - 1, d, 15, 0, 0));
  return { start: start.toISOString(), end: end.toISOString() };
}

async function callGeminiBatch(rows: PendingRow[], deadline: number): Promise<{ map: Map<string, Analysis>; model: string }> {
  const systemInstruction = `あなたは株式市場のニュース分析アナリストです。
複数の銘柄について、見出しと本文が与えられます。日本語要50〜80字に要約し、
抽象的・一般論のみの表現は避け、具体的な情報があれば必ず盛り込んでください。
AI関連銘柄への影響という観点で sentiment を "positive" | "negative" | "neutral" のいずれかで判定し、
impact_score を1〜10の整数で評価してください。
入力されたすべての ticker_symbol について、必ず1件ずつ対応するオブジェクトを含めてください。
必ず次のJSON配列形式のみを出力してください（説明文・コードブロック不要）:
[{"ticker_symbol": "...", "summary": "...", "sentiment": "positive|negative|neutral", "impact_score": 1-10}, ...]`;

  const userPrompt = rows
    .map((r, i) => `${i + 1}. ticker_symbol: ${r.ticker_symbol}　企業名: ${r.company_name}\n見出し: ${r.news_headline}\n本文抄粒: ${r.news_summary}`)
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

Deno.serve(async (_req) => {
  const startedAt = Date.now();
  try {
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const { start, end } = jstTodayUtcRange();

    // 本日分で、ニュースは取れたが分析が欠落している行だけを抽出
    const { data: pending, error: fetchError } = await supabase
      .from("ai_stock_intelligence")
      .select("id, ticker_symbol, company_name, news_headline, news_summary")
      .gte("recorded_at", start)
      .lt("recorded_at", end)
      .is("market_sentiment", null)
      .not("news_headline", "is", null);
    if (fetchError) throw new Error(`Failed to load pending rows: ${fetchError.message}`);

    const rows = (pending ?? []) as PendingRow[];
    if (rows.length === 0) {
      return new Response(JSON.stringify({ pending: 0, updated: 0 }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    const { map: analysisMap, model } = await callGeminiBatch(rows, startedAt + TOTAL_BUDGET_MS);

    let updated = 0;
    const errors: { symbol: string; message: string }[] = [];
    for (const row of rows) {
      const analysis = analysisMap.get(row.ticker_symbol);
      if (!analysis) {
        errors.push({ symbol: row.ticker_symbol, message: "Gemini did not return analysis for this ticker" });
        continue;
      }
      const { error } = await supabase
        .from("ai_stock_intelligence")
        .update({
          market_sentiment: analysis.sentiment,
          impact_score: analysis.impactScore,
          news_summary: analysis.summary,
        })
        .eq("id", row.id);
      if (error) {
        errors.push({ symbol: row.ticker_symbol, message: error.message });
        continue;
      }
      updated++;
    }

    if (errors.length > 0) {
      console.error(`ai-stock-reanalyze-pending errors: ${JSON.stringify(errors)}`);
    }
    console.log(`[ai-stock-reanalyze-pending] done in ${Date.now() - startedAt}ms: pending ${rows.length}, updated ${updated}, model ${model}`);

    return new Response(JSON.stringify({ pending: rows.length, updated, model, errors }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error(`ai-stock-reanalyze-pending fatal error: ${(err as Error).message}`);
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
