# 次の作業プロンプト集（Sonnet依頼用）

ゴール: **MEMOをスマホで使えるようにする**。
各プロンプトは独立したセッションにそのままコピペで投げられる。上から順に実行するのが推奨（ただし各タスクは単独でも成立する）。

各タスク共通の前提はプロンプト内に埋め込んであるので、追加説明は不要。

---

## ① GitHub Pagesで公開（まずスマホから開けるように）

```
リポジトリ dr-sakamoto/memo を GitHub Pages で公開したい。

前提:
- ブランチ claude/personal-cns-diary-platform-exbv7x がデフォルトブランチ
- リポジトリ直下の index.html + css/ + js/ だけで動く依存ゼロの静的アプリ（ビルド不要、ES Modules使用）
- npm依存・ビルドツールは絶対に導入しないこと

やること:
1. .github/workflows/pages.yml を作成。デフォルトブランチへのpushで
   actions/upload-pages-artifact + actions/deploy-pages を使いリポジトリ直下を
   そのままデプロイするワークフローにする
2. コミット＆プッシュ
3. 私がやるべき残り手順（リポジトリのSettings → Pages で Source を
   GitHub Actions にする等）を箇条書きで教えて

注意点も教えて: Pagesは公開URLになるが、このアプリはデータを一切サーバーに
持たず全部localStorage保存なので、URLを知られても私の記録は漏れない、という
理解で合っているかの確認も含めて。
```

---

## ② モバイルUX最適化

```
リポジトリ memo（依存ゼロの静的Webアプリ、index.html + css/style.css + js/*.js、
ES Modules、ビルドなし、データはlocalStorage）をスマホで快適に使えるようにしたい。
これは自分専用の一人用SNS（タイムライン/時間軸/ブドウの木/レポート/設定 の5タブ構成、
上部に電光掲示板ティッカーがある）。

制約: フレームワーク・ビルドツール・npm依存を導入しない。既存の見た目の
世界観（ダーク×紫、ブドウ）は維持。

やること（CSS中心、必要ならindex.htmlとjs/app.jsも最小限修正）:
1. 480px以下でタブバーを画面下部固定（bottom navigation）にし、
   タップ領域を最低44pxにする。env(safe-area-inset-bottom) を考慮
2. iOSでtextarea/inputフォーカス時に画面がズームしないよう、
   フォーム要素のfont-sizeを16px以上にする
3. 引用モーダルをモバイルでは画面下からのシート風（全幅）にする
4. ポストのアクションボタン（再芽/接ぎ木/AIの目/削除）のタップ領域を広げる
5. 100vh問題（モバイルブラウザのアドレスバー）があれば100dvhで対処

確認方法: python3 -m http.server 8000 で起動し、Playwright等で
viewport 390x844（iPhone相当）のスクリーンショットを撮って確認してから
コミット＆プッシュ（ブランチ claude/personal-cns-diary-platform-exbv7x）。
```

---

## ③ PWA化 — ホーム画面に追加してアプリとして起動

```
リポジトリ memo（依存ゼロの静的Webアプリ、index.html + css/ + js/、ビルドなし）を
PWA化して、スマホの「ホーム画面に追加」でアプリのように起動できるようにしたい。

制約: npm依存・ビルドツール禁止。Service Workerはこのタスクではまだ作らない
（次のタスクで別途やる）。

やること:
1. manifest.webmanifest を作成:
   - name "MEMO — 自分だけのCNS" / short_name "MEMO"
   - display: standalone, 背景色 #14121a, テーマ色 #241d38
   - start_url は相対 "./"（GitHub Pagesのサブパス配信でも壊れないように）
2. アイコンを用意: 紫系背景にブドウ🍇モチーフの 192x192 と 512x512 のPNG
   （maskable対応）。SVGで描いてから手元のツール（rsvg-convert / ImageMagick /
   Playwrightのスクリーンショット等、環境にあるもの）でPNG化して icons/ に置く
3. index.htmlの<head>に manifest リンク、theme-color、
   apple-touch-icon（180x180 PNG）、apple-mobile-web-app-* メタを追加
4. ローカルサーバーで起動してmanifestが正しく読めることを確認し、
   コミット＆プッシュ（ブランチ claude/personal-cns-diary-platform-exbv7x）
```

---

## ④ Service Workerでオフライン対応

```
リポジトリ memo（依存ゼロの静的Webアプリ、PWA manifest導入済み）に
Service Workerを追加して、オフラインでも起動・記録できるようにしたい。
データは全部localStorageなので、キャッシュすべきはアプリシェル
（index.html, css/style.css, js/*.js, manifest, icons/）だけ。

制約: npm依存・ビルドツール禁止。Workbox等のライブラリも使わず素のSWで書く。

やること:
1. sw.js を作成。方針:
   - install時にアプリシェルを全部プリキャッシュ（キャッシュ名にバージョン文字列）
   - fetchはcache-first、ただしAPI呼び出し（api.anthropic.com /
     generativelanguage.googleapis.com）は絶対にキャッシュせず素通し
   - activate時に古いバージョンのキャッシュを削除
2. js/app.js の末尾でSW登録（GitHub Pagesのサブパス配信を壊さないよう相対パス、
   registration失敗は無視）
3. 更新の罠への対処: 新しいデプロイが反映されない事故を防ぐため、
   sw.js内のキャッシュバージョンを上げれば更新される構成にし、
   その運用ルールをREADMEに1段落追記
4. ローカルで動作確認（一度読み込み→サーバー停止→リロードでも動くこと）
   してからコミット＆プッシュ（ブランチ claude/personal-cns-diary-platform-exbv7x）
```

---

## ⑤ スマホ⇄PCのデータ移動を楽にする

```
リポジトリ memo（一人用SNS。データはlocalStorageのみ、js/store.jsに
exportJson/importJson実装済み、設定タブにファイルのエクスポート/インポートUIあり)。
スマホとPCでlocalStorageは共有されないので、端末間のデータ移動を楽にしたい。

制約: npm依存・サーバー・アカウント機能は導入しない。あくまでローカル完結。

やること（設定タブの「データ」カードに追加）:
1. モバイルでのエクスポート改善: navigator.share が使える環境では
   「共有でエクスポート」ボタンを出し、JSONファイルをWeb Share API
   （files付きshare）でAirDrop/Drive等に送れるようにする。
   使えない環境では従来のダウンロードにフォールバック
2. 「クリップボードにコピー」ボタン（JSON全文をnavigator.clipboardへ）と、
   「貼り付けてインポート」（textareaに貼ってインポート）を追加。
   ファイル扱いが面倒なスマホ向けの導線
3. インポート時は既存実装と同じく確認ダイアログを出してから置き換え
4. 動作確認してコミット＆プッシュ（ブランチ claude/personal-cns-diary-platform-exbv7x）
```

---

## 将来メモ（今はやらない）

- **クラウド同期（Supabase）**: 端末間の自動同期。アカウント・RLS設計が必要で
  「完全ローカル」思想とのトレードオフがあるため、手動移動（⑤）で不便を感じてから判断
- **通知**: 「先週のレポートが作れます」をPWAのバッジ/通知で。SWありきなので④の後
