# 足跡ジャーナル (Ashiato)

PC での作業を**ローカルで自動記録**し、Claude が「作業ブロックへの整理」「日報の下書き」「過去の作業への質問応答」をしてくれるデスクトップアプリです（Electron）。

![スクリーンショット（デモデータ）](docs/screenshot.png)

## できること

| 機能 | 内容 |
|---|---|
| 自動記録 | アクティブウィンドウ（アプリ名・タイトル）、離席（無操作・画面ロック）、登録フォルダ内のファイル編集、自分の git コミット |
| クイックメモ | `Ctrl+Alt+J` でどこからでも一言メモ。日報の重要な手がかりになります |
| タイムライン | 1 日を横軸に、作業ブロック / アプリ / ファイル / コミット・メモの 4 レーンで表示 |
| ✦ AI で作業を整理 | 数分おきのアプリ往復を、意味のある「作業ブロック」（実装・レビュー・会議…）にまとめます |
| ✦ 日報を生成 | テンプレートに沿った日報の Markdown 下書きをストリーミングで生成。思考の要約も見られます |
| ✦ 足跡に聞く | 「昨日の午後は何してた？」「今週やったことをまとめて」に、Claude が記録を検索して答えます |

## 使っている Claude API の機能

- **Claude Opus 5.5**（既定。設定で Sonnet 5.5 / Haiku 5.5 に変更可）
- **構造化出力**（`output_config.format` + Zod）で作業ブロックを型付き JSON として受け取る
- **Tool Runner + ストリーミング**：`list_days` / `get_day` / `search_events` の 3 ツールを Claude が自律的に使って質問に答える
- **Adaptive thinking**（`display: "summarized"`）で思考の要約を UI に表示
- **effort** を用途別に調整（整理 = medium、日報 = high、質問 = medium）
- **プロンプトキャッシュ**（システムプロンプトに `cache_control`）
- **サーバーサイドフォールバック**（`fallbacks: "default"`）で安全性判定による辞退時も自動で適切なモデルに切り替え

## プライバシー

- 記録データはすべてこの PC（`%APPDATA%/Ashiato/journal/` の JSONL）にだけ保存されます
- Claude に送られるのは、**AI ボタンを押したとき**の要約済みタイムラインだけです。送信内容は「送信内容を確認」でそのまま見られます
- 除外キーワード（既定: password, 1Password, InPrivate など）を含むウィンドウはタイトルを記録しません
- API キーは OS の暗号化ストレージ（Electron `safeStorage`）で保存します
- ウィンドウタイトル中の文章はデータとして扱い、指示として従わないようモデルに伝えています

## 使い方

```bash
npm install
npm start
```

初回起動時に設定画面が開きます。

1. **Claude API キー**を入力して保存（環境変数 `ANTHROPIC_API_KEY` があればそれを使います）
2. **記録するフォルダ**（普段コードやドキュメントを置いている場所）を追加すると、ファイル編集と git コミットも記録されます
3. あとはタスクトレイに常駐して自動で記録します。ウィンドウを閉じても記録は続き、終了はトレイメニューから

### 配布用ビルド

```bash
npm run dist -- --win portable   # release/Ashiato-0.1.0-portable.exe
npm run dist -- --win nsis       # インストーラー
```

### デモデータで試す

実データを使わずに画面を見たいとき（架空の 1 日を生成します）:

```bash
node scripts/seed-demo.mjs .demo-profile 2026-11-05
```

```bash
ASHIATO_USER_DATA=.demo-profile npx electron .
```

## 仕組み

```
src/
  main/
    activeWindow.ts  前面ウィンドウの取得（Windows: 常駐 PowerShell + Win32 API / macOS: osascript / Linux: xdotool）
    recorder.ts      ウィンドウ区間・離席・ファイル監視・git ポーリング。15 秒ごとのチェックポイントで強制終了にも耐える
    store.ts         日ごとの JSONL と AI 結果、設定、暗号化 API キー
    compress.ts      生イベントを Claude が読みやすい時系列テキストに圧縮
    ai.ts            Claude 連携（整理・日報・質問応答）
    index.ts         ウィンドウ、トレイ、グローバルショートカット、IPC
  preload.ts         contextIsolation 下で renderer に API を公開
  renderer/          UI（依存は marked + DOMPurify のみ）
```

ネイティブアドオンを使わないので、Electron のバージョンを上げても再ビルドは不要です。

## 動作環境

Windows 10/11 で動作確認しています。macOS は「アクセシビリティ」権限、Linux は `xdotool` があればウィンドウタイトルを取得できます（未検証）。

## ライセンス

MIT
