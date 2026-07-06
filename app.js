const SUPABASE_URL = "https://jkacguhaabaqtrjaahgl.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImprYWNndWhhYWJhcXRyamFhaGdsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIxNTIxNjAsImV4cCI6MjA5NzcyODE2MH0.6BnIs9aq4pM9DKicbdiEBG95fvw4Oyihd4YW4_Q1U4c";

const SENTIMENT_LABELS = { positive: "ポジティブ", negative: "ネガティブ", neutral: "中立" };

const GLOSSARY = {
  sentiment: "AIが関連ニュースを読み、その銘柄にとって「プラス材料」「マイナス材料」「どちらでもない」のいずれかを判定した結果です。あくまでAIの一次判断であり、売買の推奨ではありません。",
  impact: "そのニュースが株価に与える影響の大きさを、AIが1〜10の数字で評価したものです。数字が大きいほど「見逃さない方がよい」重要度が高いニュースと考えられます。",
  change: "前営業日の終値と比べた株価の変化率です。プラスは値上がり、マイナスは値下がりを意味します。数%の変動は日常的にあるため、過度に一喜一憂する必要はありません。",
  sector: "この企業が属する業種・分野の分類です。同じセクターの銘柄は似た要因（金利、規制、需要動向など）で値動きが連動することがあります。",
};

function infoIcon(term) {
  const text = GLOSSARY[term];
  if (!text) return "";
  return `<span class="info-icon" data-term="${term}" tabindex="0" role="button" aria-label="用語解説">ⓘ<span class="info-tooltip">${text}</span></span>`;
}

document.addEventListener("click", (e) => {
  const icon = e.target.closest(".info-icon");
  document.querySelectorAll(".info-icon.open").forEach((el) => {
    if (el !== icon) el.classList.remove("open");
  });
  if (icon) {
    icon.classList.toggle("open");
    e.stopPropagation();
  }
});

const client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let latestRows = [];
let tickerRows = [];
let tickerMap = new Map();

function displayName(symbol, fallbackName) {
  return tickerMap.get(symbol)?.company_name_ja || fallbackName;
}

const els = {
  cardGrid: document.getElementById("cardGrid"),
  summaryCards: document.getElementById("summaryCards"),
  tickerChanges: document.getElementById("tickerChanges"),
  lastUpdated: document.getElementById("lastUpdated"),
  searchInput: document.getElementById("searchInput"),
  sectorFilter: document.getElementById("sectorFilter"),
  sentimentFilter: document.getElementById("sentimentFilter"),
  sortSelect: document.getElementById("sortSelect"),
  trendTickerSelect: document.getElementById("trendTickerSelect"),
  periodToggle: document.getElementById("periodToggle"),
  trendChart: document.getElementById("trendChart"),
  trendEmptyState: document.getElementById("trendEmptyState"),
  trendTableBody: document.getElementById("trendTableBody"),
};

function formatDateTime(iso) {
  if (!iso) return "-";
  const d = new Date(iso);
  return d.toLocaleString("ja-JP", { dateStyle: "medium", timeStyle: "short" });
}

function formatRelativeDays(iso) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (days <= 0) return "今日";
  return `${days}日前`;
}

async function loadData() {
  const [{ data: latest, error: latestError }, { data: tickers, error: tickerError }] = await Promise.all([
    client.from("ai_stock_intelligence_latest").select("*"),
    client.from("ai_stock_tickers").select("*"),
  ]);

  if (latestError || tickerError) {
    const message = (latestError && latestError.message) || (tickerError && tickerError.message);
    els.cardGrid.innerHTML = `<p class="error-state">データの取得に失敗しました: ${message}</p>`;
    els.lastUpdated.textContent = "取得エラー";
    return;
  }

  tickerRows = tickers ?? [];
  tickerMap = new Map(tickerRows.map((t) => [t.ticker_symbol, t]));
  const activeSymbols = new Set(tickerRows.filter((t) => t.is_active).map((t) => t.ticker_symbol));
  latestRows = (latest ?? []).filter((r) => activeSymbols.has(r.ticker_symbol));

  populateSectorFilter();
  renderLastUpdated();
  renderSummary();
  renderCards();
  renderTickerChanges();
  populateTrendTickerSelect();
  loadTrendChart();
}

function populateSectorFilter() {
  const sectors = Array.from(new Set(latestRows.map((r) => r.sector_category).filter(Boolean))).sort();
  for (const sector of sectors) {
    const opt = document.createElement("option");
    opt.value = sector;
    opt.textContent = sector;
    els.sectorFilter.appendChild(opt);
  }
}

function renderLastUpdated() {
  const timestamps = latestRows.map((r) => r.recorded_at).filter(Boolean);
  if (timestamps.length === 0) {
    els.lastUpdated.textContent = "データがありません";
    return;
  }
  const latestTime = timestamps.sort().at(-1);
  els.lastUpdated.textContent = `最終更新: ${formatDateTime(latestTime)}`;
}

function renderSummary() {
  const total = latestRows.length;
  const positive = latestRows.filter((r) => r.market_sentiment === "positive").length;
  const negative = latestRows.filter((r) => r.market_sentiment === "negative").length;
  const neutral = latestRows.filter((r) => r.market_sentiment === "neutral").length;

  els.summaryCards.innerHTML = `
    <div class="summary-card"><div class="value">${total}</div><div class="label">追跡銘柄数</div></div>
    <div class="summary-card"><div class="value" style="color:var(--positive)">${positive}</div><div class="label">ポジティブ</div></div>
    <div class="summary-card"><div class="value" style="color:var(--neutral)">${neutral}</div><div class="label">中立</div></div>
    <div class="summary-card"><div class="value" style="color:var(--negative)">${negative}</div><div class="label">ネガティブ</div></div>
  `;
}

function getFilteredSortedRows() {
  const search = els.searchInput.value.trim().toLowerCase();
  const sector = els.sectorFilter.value;
  const sentiment = els.sentimentFilter.value;
  const sort = els.sortSelect.value;

  let rows = latestRows.filter((r) => {
    if (search) {
      const haystack = `${r.ticker_symbol} ${r.company_name} ${displayName(r.ticker_symbol, r.company_name)}`.toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    if (sector && r.sector_category !== sector) return false;
    if (sentiment && r.market_sentiment !== sentiment) return false;
    return true;
  });

  const byNum = (v) => (v === null || v === undefined ? -Infinity : Number(v));

  switch (sort) {
    case "change_desc":
      rows.sort((a, b) => byNum(b.price_change_pct) - byNum(a.price_change_pct));
      break;
    case "change_asc":
      rows.sort((a, b) => byNum(a.price_change_pct) - byNum(b.price_change_pct));
      break;
    case "symbol_asc":
      rows.sort((a, b) => a.ticker_symbol.localeCompare(b.ticker_symbol));
      break;
    case "impact_desc":
    default:
      rows.sort((a, b) => byNum(b.impact_score) - byNum(a.impact_score));
      break;
  }

  return rows;
}

function renderCards() {
  const rows = getFilteredSortedRows();

  if (rows.length === 0) {
    els.cardGrid.innerHTML = `<p class="empty-state">条件に一致する銘柄がありません。</p>`;
    return;
  }

  els.cardGrid.innerHTML = rows.map((r) => {
    const changeClass = Number(r.price_change_pct) >= 0 ? "positive" : "negative";
    const changeSign = Number(r.price_change_pct) >= 0 ? "+" : "";
    const sentimentClass = r.market_sentiment && SENTIMENT_LABELS[r.market_sentiment] ? r.market_sentiment : "unknown";
    const sentimentLabel = SENTIMENT_LABELS[r.market_sentiment] ?? "分析なし";
    const impactLabel = r.impact_score ? `影響度 ${r.impact_score}/10` : "影響度未評価";

    const name = displayName(r.ticker_symbol, r.company_name);

    return `
      <article class="stock-card">
        <div class="stock-card-top">
          <div>
            <div class="stock-symbol">${name}<span class="stock-ticker-code">（${r.ticker_symbol}）</span></div>
            ${r.sector_category ? `<span class="sector-badge">${r.sector_category}${infoIcon("sector")}</span>` : ""}
          </div>
          <div class="price-block">
            <div class="price">$${Number(r.current_price).toFixed(2)}</div>
            <div class="price-change ${changeClass}">${changeSign}${Number(r.price_change_pct ?? 0).toFixed(2)}%${infoIcon("change")}</div>
          </div>
        </div>
        <div class="badge-row">
          <span class="sentiment-badge ${sentimentClass}">${sentimentLabel}${infoIcon("sentiment")}</span>
          <span class="impact-score">${impactLabel}${infoIcon("impact")}</span>
        </div>
        ${r.news_summary ? `<div class="news-summary">${r.news_summary}</div>` : `<div class="news-summary">関連ニュースの要約はまだありません。</div>`}
        ${r.news_headline ? `
          <div class="news-headline-original">
            原文: ${r.news_url ? `<a href="${r.news_url}" target="_blank" rel="noopener noreferrer">${r.news_headline}</a>` : r.news_headline}
          </div>
        ` : ""}
        <div class="recorded-at">記録日時: ${formatDateTime(r.recorded_at)}</div>
      </article>
    `;
  }).join("");
}

function renderTickerChanges() {
  const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
  const changes = [];

  for (const t of tickerRows) {
    const company = t.company_name_ja || t.company_name;
    if (t.added_at && new Date(t.added_at).getTime() >= cutoff && t.added_reason !== "初期セットアップ") {
      changes.push({ type: "added", symbol: t.ticker_symbol, company, reason: t.added_reason, date: t.added_at });
    }
    if (t.removed_at && new Date(t.removed_at).getTime() >= cutoff) {
      changes.push({ type: "removed", symbol: t.ticker_symbol, company, reason: t.removed_reason, date: t.removed_at });
    }
  }

  changes.sort((a, b) => new Date(b.date) - new Date(a.date));

  if (changes.length === 0) {
    els.tickerChanges.innerHTML = `<p class="empty-state">過去14日以内の追加・除外はありません。</p>`;
    return;
  }

  els.tickerChanges.innerHTML = changes.map((c) => `
    <div class="change-row">
      <span class="change-tag ${c.type}">${c.type === "added" ? "追加" : "除外"}</span>
      <strong>${c.symbol}</strong>
      <span>${c.company}</span>
      <span class="change-reason">${c.reason ?? ""}</span>
      <span class="change-reason">(${formatRelativeDays(c.date)})</span>
    </div>
  `).join("");
}

[els.searchInput, els.sectorFilter, els.sentimentFilter, els.sortSelect].forEach((el) => {
  el.addEventListener("input", renderCards);
  el.addEventListener("change", renderCards);
});

// ---------- タブ切り替え ----------
document.querySelectorAll(".tab-button").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-button").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add("active");
  });
});

// ---------- 価格推移（日次・週次・月次・年次） ----------
let trendChartInstance = null;
let currentPeriod = "daily";

function populateTrendTickerSelect() {
  const activeTickers = tickerRows
    .filter((t) => t.is_active)
    .map((t) => ({ symbol: t.ticker_symbol, name: t.company_name_ja || t.company_name }))
    .sort((a, b) => a.symbol.localeCompare(b.symbol));

  const previousValue = els.trendTickerSelect.value;
  els.trendTickerSelect.innerHTML = activeTickers
    .map((t) => `<option value="${t.symbol}">${t.name}（${t.symbol}）</option>`)
    .join("");

  if (previousValue && activeTickers.some((t) => t.symbol === previousValue)) {
    els.trendTickerSelect.value = previousValue;
  }
}

// 集計はすべて日本時間（JST）の暦日基準で行う。
// recorded_at はUTCで保存されているため、閲覧者のブラウザのタイムゾーンに関係なく
// 常にJSTの日付として扱う必要がある（さもないと06:00 JST実行分が前日扱いになる）。
function jstDateParts(input) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(input));
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return { year: Number(map.year), month: Number(map.month), day: Number(map.day) };
}

function jstDateKey(input) {
  const { year, month, day } = jstDateParts(input);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function startOfWeekJst(input) {
  const { year, month, day } = jstDateParts(input);
  const utcMidnight = new Date(Date.UTC(year, month - 1, day));
  const dow = utcMidnight.getUTCDay();
  const diff = (dow === 0 ? -6 : 1) - dow;
  utcMidnight.setUTCDate(utcMidnight.getUTCDate() + diff);
  return utcMidnight.toISOString().slice(0, 10);
}

function periodKey(recordedAt, period) {
  const { year, month } = jstDateParts(recordedAt);
  switch (period) {
    case "weekly":
      return startOfWeekJst(recordedAt);
    case "monthly":
      return `${year}-${String(month).padStart(2, "0")}`;
    case "yearly":
      return `${year}`;
    case "daily":
    default:
      return jstDateKey(recordedAt);
  }
}

function periodLabel(key, period) {
  switch (period) {
    case "weekly":
      return `${key}週`;
    case "monthly": {
      const [y, m] = key.split("-");
      return `${y}年${Number(m)}月`;
    }
    case "yearly":
      return `${key}年`;
    case "daily":
    default: {
      const [, m, d] = key.split("-");
      return `${Number(m)}/${Number(d)}`;
    }
  }
}

const PERIOD_LIMITS = { daily: 60, weekly: 52, monthly: 36, yearly: 15 };

function aggregateByPeriod(history, period) {
  const buckets = new Map();
  for (const row of history) {
    const key = periodKey(row.recorded_at, period);
    const existing = buckets.get(key);
    if (!existing || new Date(row.recorded_at) > new Date(existing.recorded_at)) {
      buckets.set(key, row);
    }
  }
  const sortedKeys = Array.from(buckets.keys()).sort();
  const limit = PERIOD_LIMITS[period] ?? 60;
  const limitedKeys = sortedKeys.slice(-limit);
  return limitedKeys.map((key) => ({ key, ...buckets.get(key) }));
}

async function fetchTickerHistory(symbol) {
  const { data, error } = await client
    .from("ai_stock_intelligence")
    .select("recorded_at, current_price, price_change_pct, market_sentiment")
    .eq("ticker_symbol", symbol)
    .order("recorded_at", { ascending: true });
  if (error) throw error;
  return data ?? [];
}

async function loadTrendChart() {
  const symbol = els.trendTickerSelect.value;
  if (!symbol) return;

  let history = [];
  try {
    history = await fetchTickerHistory(symbol);
  } catch (err) {
    els.trendEmptyState.style.display = "block";
    els.trendEmptyState.textContent = `データの取得に失敗しました: ${err.message}`;
    els.trendChart.style.display = "none";
    return;
  }

  if (history.length === 0) {
    els.trendEmptyState.style.display = "block";
    els.trendEmptyState.textContent = "この銘柄のデータがまだありません。";
    els.trendChart.style.display = "none";
    els.trendTableBody.innerHTML = "";
    return;
  }

  const points = aggregateByPeriod(history, currentPeriod);

  els.trendEmptyState.style.display = "none";
  els.trendChart.style.display = "block";

  const labels = points.map((p) => periodLabel(p.key, currentPeriod));
  const prices = points.map((p) => Number(p.current_price));

  if (trendChartInstance) {
    trendChartInstance.destroy();
  }

  trendChartInstance = new Chart(els.trendChart, {
    type: "line",
    data: {
      labels,
      datasets: [{
        label: "株価 (USD)",
        data: prices,
        borderColor: "#6c8cff",
        backgroundColor: "rgba(108, 140, 255, 0.15)",
        fill: true,
        tension: 0.25,
        pointRadius: 3,
      }],
    },
    options: {
      responsive: true,
      plugins: {
        legend: { labels: { color: "#e8ecf4" } },
      },
      scales: {
        x: { ticks: { color: "#9aa4b8" }, grid: { color: "#2a3247" } },
        y: { ticks: { color: "#9aa4b8" }, grid: { color: "#2a3247" } },
      },
    },
  });

  els.trendTableBody.innerHTML = points.slice().reverse().map((p) => {
    const changeClass = Number(p.price_change_pct) >= 0 ? "positive" : "negative";
    const changeSign = Number(p.price_change_pct) >= 0 ? "+" : "";
    const sentimentLabel = SENTIMENT_LABELS[p.market_sentiment] ?? "-";
    return `
      <tr>
        <td>${periodLabel(p.key, currentPeriod)}</td>
        <td>$${Number(p.current_price).toFixed(2)}</td>
        <td class="price-change ${changeClass}">${changeSign}${Number(p.price_change_pct ?? 0).toFixed(2)}%</td>
        <td>${sentimentLabel}</td>
      </tr>
    `;
  }).join("");
}

els.trendTickerSelect.addEventListener("change", loadTrendChart);

els.periodToggle.querySelectorAll(".period-button").forEach((btn) => {
  btn.addEventListener("click", () => {
    els.periodToggle.querySelectorAll(".period-button").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    currentPeriod = btn.dataset.period;
    loadTrendChart();
  });
});

loadData();
