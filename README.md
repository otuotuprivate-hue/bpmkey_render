# Tempo & Key — BPM・キー判定ツール

音楽ファイル（またはYouTube）のBPMとキーを判定する静的Webサイトです。
解析はすべてブラウザ内で行うため、サーバーは不要です。Render・Cloudflare Pages・Netlify・GitHub Pages などの無料の静的ホスティングにそのまま置けます（ビルド不要）。

## ファイル構成

```
index.html        ツール本体
css/style.css     デザイン（ライト／ダーク自動切替）
js/app.js         画面・波形シークバー・再生・YouTube取り込み
js/worker.js      解析をバックグラウンドで実行
js/analyzer.js    BPM・キー判定エンジン（依存ライブラリなし）
robots.txt
```

## Renderでの公開設定

| 項目 | 値 |
|---|---|
| サービスの種類 | Static Site |
| Build Command | 空欄（必須と表示されたら `echo done`） |
| Publish Directory | `.` |

ローカルで確認するときは `python3 -m http.server` などで開いてください（`file://` で直接開くとWorkerが動きません）。

## YouTube について

YouTubeの音声はダウンロードせず、公式の埋め込みプレーヤーで再生しながら、ユーザーが許可した「このタブの音声」をブラウザ内で取り込んで解析します。PC版の Chrome / Edge のみ対応です。
