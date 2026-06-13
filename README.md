# AcCode X

Tauri + Rust で作る AtCoder 向け軽量 IDE プロトタイプです。

## 機能

- OS 判定に応じた C++ / Python / Rust 環境構築コマンドの提示
- AtCoder URL のみ許可する Web ペイン
- 左右入れ替え可能な Web / Editor 分割画面
- `ABC423_A.cpp` のような解答ファイル生成
- C++20 / Python / Rust のワンボタンビルド
- ビルドごとの差分スナップショット保存
- 下部ターミナルの表示、非表示、ドラッグリサイズ

## 開発

```sh
npm install
npm run tauri:dev
```

ブラウザだけで UI を確認する場合:

```sh
npm run dev
```

本番ビルド:

```sh
npm run tauri:build
```

macOS では現在 `.app` の生成に絞っています。DMG まで作る場合は `src-tauri/tauri.conf.json`
の `bundle.targets` を調整してください。

## 注意

Tauri 標準の WebView は Chrome 拡張 API と VSCode 拡張 host をそのまま提供しません。完全互換が必須なら、Chrome 拡張は CEF または外部 Chrome 連携、VSCode 拡張は Monaco + VSCode extension host 相当の別プロセス設計が必要です。
