// Gemini呼び出しの共通クライアント（米国株側の3関数で共用）。
//
// - モデルは固定せず、優先順リスト（環境変数 GEMINI_MODELS、カンマ区切り）を順に試す。
//   Geminiはモデルの世代交代が速く、固定すると廃止・新規利用不可(404)で突然止まるため、
//   404/403/429/5xx/タイムアウト/応答のパース失敗のときは次のモデルに自動で切り替える。
//   レート制限はモデルごとに独立しているので、切替はクォータ超過の回避にもなる。
// - すべての呼び出しにタイムアウトと全体の締め切り(deadline)を設ける。
//   Edge Functionは約150秒でゲートウェイが504を返して処理が中断されるため、
//   応答が返らない呼び出しで関数全体が固まらないようにするため。

// 現行運用で動作実績のあるモデルを先頭に置き（挙動を変えないため）、後ろに現行世代の推奨モデルを並べる。
const DEFAULT_MODELS = [
  "gemini-2.5-flash",
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-3.8-flash",
];

const DEFAULT_PER_CALL_TIMEOUT_MS = 45_000;
const MIN_REMAINING_MS = 5_000;
const MAX_RATE_LIMIT_WAIT_MS = 15_000;

export function geminiModelChain(): string[] {
  const configured = (Deno.env.get("GEMINI_MODELS") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return configured.length > 0 ? configured : DEFAULT_MODELS;
}

export function extractText(data: unknown): string {
  const res = data as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  return res?.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryDelayMs(errorBody: string): number | null {
  const match = errorBody.match(/"retryDelay"\s*:\s*"(\d+)s"/);
  return match ? (parseInt(match[1], 10) + 2) * 1000 : null;
}

// 404/403（廃止・新規利用不可・権限なし）になったモデルは、この実行中は再試行しても無駄なので飛ばす
const unavailableModels = new Set<string>();

export interface GeminiCallOptions {
  deadline: number; // epoch ms。これを過ぎたら打ち切る
  perCallTimeoutMs?: number;
}

// requestBody を優先順リストの各モデルに送り、parse が成功した最初の結果を返す。
// parse は応答(JSON)から欲しい値を取り出す関数で、例外を投げるとそのモデルは失敗扱いになり次のモデルへ進む。
export async function generateWithFallback<T>(
  apiKey: string,
  requestBody: Record<string, unknown>,
  parse: (data: unknown) => T,
  options: GeminiCallOptions,
): Promise<{ result: T; model: string }> {
  const errors: string[] = [];
  const perCallTimeout = options.perCallTimeoutMs ?? DEFAULT_PER_CALL_TIMEOUT_MS;

  for (const model of geminiModelChain()) {
    if (unavailableModels.has(model)) continue;
    for (let attempt = 0; attempt < 2; attempt++) {
      const remaining = options.deadline - Date.now();
      if (remaining < MIN_REMAINING_MS) {
        throw new Error(`Gemini deadline exceeded. ${errors.join(" | ")}`);
      }

      try {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(requestBody),
            signal: AbortSignal.timeout(Math.min(perCallTimeout, remaining)),
          },
        );

        if (res.ok) return { result: parse(await res.json()), model };

        const bodyText = await res.text();
        errors.push(`${model}: HTTP ${res.status}`);
        if (res.status === 404 || res.status === 403) unavailableModels.add(model);

        // 429は待ち時間が短ければ同じモデルで1回だけ待って再試行。長ければ次のモデルへ（クォータはモデルごと）
        if (res.status === 429 && attempt === 0) {
          const wait = parseRetryDelayMs(bodyText);
          if (wait !== null && wait <= MAX_RATE_LIMIT_WAIT_MS && options.deadline - Date.now() > wait + 10_000) {
            console.warn(`Gemini ${model} rate limited, waiting ${wait}ms before one retry`);
            await sleep(wait);
            continue;
          }
        }
        console.warn(`Gemini ${model} failed with HTTP ${res.status}, trying next model: ${bodyText.slice(0, 200)}`);
      } catch (err) {
        // タイムアウト・通信エラー・応答のパース失敗はこのモデルを諦めて次へ
        errors.push(`${model}: ${String(err).slice(0, 120)}`);
        console.warn(`Gemini ${model} error, trying next model: ${String(err).slice(0, 200)}`);
      }
      break; // 次のモデルへ
    }
  }

  throw new Error(`All Gemini models failed. ${errors.join(" | ")}`);
}
