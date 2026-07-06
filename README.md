# AI関連銘柄インテリジェンス ダッシュボード

AI関連銘柄の株価・ニュース・AIセンチメント分析を毎日自動収集し、GitHub Pages上で確認できる読み取り専用ダッシュボードです。

## 1. できること

| 機能 | 内容 |
|---|---|
| 銘柄一覧 | 追跡中銘柄の株価・前日比・センチメント・影響度・関連ニュース要約を表示 |
| 価格推移 | 日次・週次・月次・年次で株価推移をグラフ表示 |
| 用語解説 | 初心者向けに専門用語をⓘアイコンで解説 |
| ティッカー変更履歴 | 週次で自動追加・除外された銘柄を表示 |

---

## 2. データフロー

```
Supabase Edge Functions (Deno) — 毎日06:00 JST自動実行
  ├─ ai-stock-intelligence:  Finnhub(株価) + Google News RSS + Gemini(要約・感情分析)
  ├─ ai-stock-daily-digest:  Top3銘柄をLINEへ通知（毎日07:10 JST）
  └─ ai-stock-ticker-review: 週次で追跡銘柄を見直し（毎週月曜07:00 JST）
        ↓
Supabase Postgres (ai_stock_intelligence / ai_stock_tickers)
        ↓ 匿名読み取り専用 (RLS)
このダッシュボード (index.html / app.js / style.css)
```

---

## 3. 技術構成

- 素のHTML/CSS/JavaScript（ビルド不要、GitHub Pagesでそのまま公開）
- [@supabase/supabase-js](https://github.com/supabase/supabase-js) でSupabaseから直接データ取得
- [Chart.js](https://www.chartjs.org/) で価格推移グラフを描画

---

## まとめ

1. データ収集・分析はSupabase Edge Functions側で完結しており、このリポジトリは表示専用
2. RLSにより読み取りは匿名ユーザーにも公開、書き込みは認証済みユーザーのみ
3. ビルドステップがないため、GitHub Pagesの設定を有効にするだけで公開可能
