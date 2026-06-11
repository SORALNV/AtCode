# AtCode

AtCoder 専用の軽量 IDE(Tauri + Rust 製)。

## 機能

- **AtCoder 専用ブラウザ(右ペイン)** — atcoder.jp と kenkoooo.com(AtCoder Problems)のみ閲覧可能。他のサイトへのナビゲーションはブロックされます。
- **📄 ワンボタンでファイル生成** — 問題ページを開いて「生成」を押すと `ABC423_A.cpp` のようなファイルがテンプレート付きで `~/AtCode/` に作られ、エディタに開きます(C++ / Python 切替可)。
- **⚒ ワンボタンコンパイル** — `Cmd/Ctrl+Enter` でも可。C++ は AtCoder と同系の GCC(`-std=gnu++20 -O2 -Wall -Wextra`)、Python は構文チェック。
- **🕘 コンパイルごとの diff 管理** — コンパイルするたびにスナップショットを自動保存(`~/AtCode/.atcode/snapshots/`)。「履歴Diff」で過去のコンパイル時点と現在のコードを Monaco の diff ビューで比較できます。
- **💻 ターミナル** — 本物のシェル(PTY)。ターミナルアイコンで下からスライド表示、境界をマウスでドラッグしてリサイズできます。
- **🛠 ワンボタン環境構築** — OS(macOS / Windows / Linux)を判定して GCC / Python の有無をチェック。インストールコマンドを表示し、ボタン一つでターミナル実行もできます。
- **▶ 実行** — コンパイル済みバイナリをターミナルで実行(標準入力を直接打てます)。

## 開発

```sh
npm install
npm run tauri dev      # 開発起動
npm run tauri build    # 配布用ビルド (.app / .dmg)
```

要件: Node.js, Rust (rustup), macOS は Xcode Command Line Tools。

## 構成

| パス | 内容 |
| --- | --- |
| `src/` | フロントエンド (TypeScript + Monaco + xterm.js) |
| `src-tauri/src/lib.rs` | ウィンドウ+2枚のWebView(UI / AtCoderブラウザ)構築 |
| `src-tauri/src/browser.rs` | ブラウザWebViewの移動・表示制御とナビゲーション制限 |
| `src-tauri/src/files.rs` | ワークスペース(`~/AtCode`)・問題ファイル生成 |
| `src-tauri/src/compile.rs` | コンパイル・スナップショット保存/読み出し |
| `src-tauri/src/env_setup.rs` | OS判定と開発環境チェック |
| `src-tauri/src/pty.rs` | portable-pty によるターミナル |

## 設計メモ

- ブラウザ部分は Tauri の子 WebView(ネイティブビュー)で、HTML の上に重なって描画されます。フロントエンドがプレースホルダ要素の位置を `set_browser_bounds` で通知して位置を同期しています。スプリッタのドラッグ中とモーダル表示中は一時的に非表示になります。
- AtCoder ブラウザ側の WebView には IPC 権限を与えていません(capabilities は `ui` のみ)。
- Chrome 拡張 / VSCode 拡張は WebView ベース(macOS は WKWebView)のため非対応です。よく使う拡張(ac-predictor 等)相当の機能は今後本体に内蔵する方針。
