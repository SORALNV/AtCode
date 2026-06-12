import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import * as monaco from "monaco-editor";
import { GroupManager, languageOf, type OpenDoc } from "./editorGroup";
import { FileTree } from "./fileTree";
import { TermPane } from "./termPane";
import { hydrateIcons } from "./icons";

interface CreatedFile {
  path: string;
  name: string;
  content: string;
  created: boolean;
}
interface CompileResult {
  success: boolean;
  output: string;
  compiler: string;
  run_cmd: string | null;
  snapshot_id: string | null;
}
interface SnapshotInfo {
  id: string;
  size: number;
}
interface ToolStatus {
  id: string;
  name: string;
  found: boolean;
  detail: string;
  install_cmd: string;
  note: string;
}
interface EnvReport {
  os: string;
  items: ToolStatus[];
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

hydrateIcons();

const workbench = $("workbench");
const browserView = $("browser-view");
const urlDisplay = $("url-display");
const genBtn = $<HTMLButtonElement>("btn-gen");
const langSel = $<HTMLSelectElement>("lang-select");
const bottomPanel = $("bottom-panel");
const termResizer = $("term-resizer");
const outputEl = $("output");
const termEl = $("term");
const statusFile = $("status-file");
const statusMsg = $("status-msg");
const statusWs = $("status-ws");
const backdrop = $("modal-backdrop");
const modalEl = $("modal");
const modalTitle = $("modal-title");
const modalBody = $("modal-body");
const toastEl = $("toast");

const groups = new GroupManager($("editor-groups"), $("editor-empty"), $("browser-panel"));
const termPane = new TermPane(termEl);
const tree = new FileTree($("file-tree"), openPath);

let wsDir = "";
let currentUrl = "";
let lastRunCmd: string | null = null;

/* ---------- settings ---------- */

interface AppSettings {
  editorFontSize: number;
  minimap: boolean;
  termFontSize: number;
  cppStd: string;
  cppOpt: string;
  cppExtra: string;
  cppTemplate: string;
  pyTemplate: string;
}

const DEFAULT_SETTINGS: AppSettings = {
  editorFontSize: 14,
  minimap: false,
  termFontSize: 13,
  cppStd: "gnu++20",
  cppOpt: "-O2",
  cppExtra: "",
  cppTemplate: "",
  pyTemplate: "",
};

let settings: AppSettings = {
  ...DEFAULT_SETTINGS,
  ...JSON.parse(localStorage.getItem("atcode.settings") ?? "{}"),
};

function applySettings() {
  groups.applyEditorOptions({
    fontSize: settings.editorFontSize,
    minimap: { enabled: settings.minimap },
  });
  termPane.setFontSize(settings.termFontSize);
}

function cppFlags(): string[] {
  return [
    `-std=${settings.cppStd}`,
    ...settings.cppOpt.split(/\s+/).filter(Boolean),
    "-Wall",
    "-Wextra",
    ...settings.cppExtra.split(/\s+/).filter(Boolean),
  ];
}

/* ---------- helpers ---------- */

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(msg: string) {
  toastEl.textContent = msg;
  toastEl.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.add("hidden"), 2800);
}

function setStatus(msg: string, kind: "ok" | "err" | "" = "") {
  statusMsg.textContent = msg;
  statusMsg.className = kind;
}

async function openPath(path: string, name: string) {
  try {
    const content = await invoke<string>("read_file", { path });
    groups.openFile(path, name, content);
  } catch (e) {
    toast(String(e));
  }
}

/* ---------- native browser webview sync ---------- */

function reportBounds() {
  if (!groups.browserShown) return;
  const r = browserView.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return;
  // floor origin, ceil extent — ensures the WebView covers the full element
  // even when CSS pixels don't land on exact device pixel boundaries.
  const x = Math.floor(r.x);
  const y = Math.floor(r.y);
  invoke("set_browser_bounds", {
    x,
    y,
    width:  Math.ceil(r.right)  - x,
    height: Math.ceil(r.bottom) - y,
  }).catch(() => {});
}

function syncBrowser(visible: boolean) {
  if (visible) {
    // Position first, then reveal — showing before the rect is fixed would
    // flash the webview at its previous (stale) bounds.
    reportBounds();
    invoke("set_browser_visible", { visible: true }).catch(() => {});
    requestAnimationFrame(reportBounds);
  } else {
    invoke("set_browser_visible", { visible: false }).catch(() => {});
  }
}

groups.onBrowserVisible = syncBrowser;
new ResizeObserver(() => requestAnimationFrame(reportBounds)).observe(browserView);
window.addEventListener("resize", reportBounds);

/* The native webview sits above this page and swallows mouse events, so hide
   it during splitter / tab drags and restore afterwards. */
function hideBrowserForDrag() {
  invoke("set_browser_visible", { visible: false }).catch(() => {});
}
function restoreBrowserAfterDrag() {
  syncBrowser(groups.browserShown);
}
groups.onDragStart = hideBrowserForDrag;
groups.onDragEnd = restoreBrowserAfterDrag;

function startDrag(e: MouseEvent, onMove: (ev: MouseEvent) => void) {
  e.preventDefault();
  hideBrowserForDrag();
  const up = () => {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", up);
    restoreBrowserAfterDrag();
  };
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", up);
}

$("sidebar-resizer").addEventListener("mousedown", (e) =>
  startDrag(e, (ev) => {
    const w = Math.min(Math.max(ev.clientX - 48, 160), 480);
    workbench.style.setProperty("--sidebar-w", `${w}px`);
  }),
);

termResizer.addEventListener("mousedown", (e) =>
  startDrag(e, (ev) => {
    const h = Math.min(Math.max(window.innerHeight - ev.clientY - 24, 80), window.innerHeight * 0.7);
    document.documentElement.style.setProperty("--term-h", `${h}px`);
  }),
);

// No native context menu (= no "Inspect Element"); Monaco and xterm bring
// their own menus / shortcuts where needed.
document.addEventListener("contextmenu", (e) => {
  if (!(e.target as HTMLElement).closest(".xterm")) e.preventDefault();
});

/* ---------- activity bar ---------- */

let activeView = "explorer";
const searchBox = $("search-box");
const sidebarTitle = $("sidebar-title");

document.querySelectorAll<HTMLButtonElement>("#activitybar .act").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (btn.dataset.action === "env") return openEnv();
    if (btn.dataset.action === "settings") return openSettings();
    selectView(btn.dataset.view!);
  });
});

function selectView(view: string) {
  const collapsed = workbench.classList.contains("sidebar-collapsed");
  if (view === activeView && !collapsed) {
    workbench.classList.add("sidebar-collapsed");
  } else {
    workbench.classList.remove("sidebar-collapsed");
    activeView = view;
    document
      .querySelectorAll<HTMLButtonElement>("#activitybar .act[data-view]")
      .forEach((b) => b.classList.toggle("active", b.dataset.view === view));
    const searching = view === "search";
    searchBox.classList.toggle("hidden", !searching);
    sidebarTitle.textContent = searching ? "検索" : "エクスプローラー";
    if (searching) ($("search-input") as HTMLInputElement).focus();
  }
  requestAnimationFrame(reportBounds);
}

$("tree-refresh").addEventListener("click", () => tree.refresh());
$<HTMLInputElement>("search-input").addEventListener("input", (e) =>
  tree.setFilter((e.target as HTMLInputElement).value),
);

/* ---------- browser navigation ---------- */

function problemNameFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    if (!/(^|\.)atcoder\.jp$/.test(u.hostname)) return null;
    const m = u.pathname.match(/\/contests\/([^/]+)(?:\/tasks\/([^/]+))?/);
    if (!m) return null;
    return (m[2] ?? m[1]).replace(/[^A-Za-z0-9_]/g, "_").toUpperCase();
  } catch {
    return null;
  }
}

function onUrlChange(url: string) {
  currentUrl = url;
  urlDisplay.textContent = url;
  urlDisplay.title = url;
  const name = problemNameFromUrl(url);
  genBtn.disabled = !name;
  // hydrateIcons() prepended an <svg>, so the trailing text node is the label.
  genBtn.lastChild!.textContent = name ? ` ${name}.${langSel.value}` : " 生成";
  // keep the toolbar site switcher in sync with where the tab actually is
  try {
    const problems = new URL(url).hostname.endsWith("kenkoooo.com");
    siteSel.selectedIndex = problems ? 1 : 0;
  } catch {
    /* empty / invalid url */
  }
}

listen<string>("browser:nav", (e) => onUrlChange(e.payload));
listen<string>("browser:blocked", () =>
  toast("AtCoder / AtCoder Problems 以外のページは開けません"),
);
// Compare the OS-reported webview bounds with the placeholder rect and
// re-apply on drift — self-heals the dark-gap / covered-nav-bar states.
async function healBounds() {
  if (!groups.browserShown) return;
  const r = browserView.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return;
  try {
    const [x, y, w, h] = await invoke<[number, number, number, number]>("get_browser_bounds");
    const drifted =
      Math.abs(x - r.x) > 1.5 ||
      Math.abs(y - r.y) > 1.5 ||
      Math.abs(w - r.width) > 1.5 ||
      Math.abs(h - r.height) > 1.5;
    if (drifted) reportBounds();
  } catch {
    reportBounds();
  }
}

// AtCoder Problems is an SPA, so history-API navigations don't fire page-load
// events — poll the URL as a fallback. The same tick verifies the native
// webview's bounds.
setInterval(async () => {
  healBounds();
  try {
    const url = await invoke<string>("get_browser_url");
    if (url !== currentUrl) onUrlChange(url);
  } catch {
    /* webview not ready */
  }
}, 1200);

$("nav-back").addEventListener("click", () => invoke("browser_back"));
$("nav-fwd").addEventListener("click", () => invoke("browser_forward"));
$("nav-reload").addEventListener("click", () => invoke("browser_reload"));
document.querySelectorAll<HTMLButtonElement>("#browser-bar .quick").forEach((b) =>
  b.addEventListener("click", () =>
    invoke("browser_navigate", { url: b.dataset.url }).catch((e) => toast(String(e))),
  ),
);

$("btn-browser").addEventListener("click", () => groups.openBrowser());

const siteSel = $<HTMLSelectElement>("site-select");
siteSel.addEventListener("change", () => {
  groups.openBrowser();
  invoke("browser_navigate", { url: siteSel.value }).catch((e) => toast(String(e)));
});

genBtn.addEventListener("click", async () => {
  try {
    const template = langSel.value === "py" ? settings.pyTemplate : settings.cppTemplate;
    const res = await invoke<CreatedFile>("create_problem_file", {
      url: currentUrl,
      lang: langSel.value,
      template: template || null,
    });
    groups.openFile(res.path, res.name, res.content);
    toast(res.created ? `${res.name} を作成しました` : `${res.name}（既存）を開きました`);
    tree.refresh();
  } catch (e) {
    toast(String(e));
  }
});

langSel.addEventListener("change", () => {
  localStorage.setItem("atcode.lang", langSel.value);
  onUrlChange(currentUrl);
});

/* ---------- editor / save / compile ---------- */

async function saveDoc(doc: OpenDoc) {
  await invoke("save_file", { path: doc.path, content: doc.model.getValue() });
  groups.markSaved(doc);
}

groups.onSave = (d) =>
  saveDoc(d)
    .then(() => setStatus("保存しました", "ok"))
    .catch((e) => toast(String(e)));
groups.onCompile = () => compile();
groups.onActiveChange = (d) => {
  statusFile.textContent = d ? d.path : "ファイルなし";
  lastRunCmd = null;
};

$("btn-split").addEventListener("click", () => groups.splitRight());

function renderOutput(fileName: string, res: CompileResult) {
  outputEl.replaceChildren();
  const head = document.createElement("span");
  head.className = res.success ? "ok" : "err";
  head.textContent = `[${fileName}] ${res.compiler} → ${res.success ? "✓ 成功" : "✗ 失敗"}\n`;
  const body = document.createElement("span");
  body.textContent = res.output.trim() ? res.output : "(出力なし)";
  outputEl.append(head, body);
}

async function compile() {
  const doc = groups.activeDoc();
  if (!doc) {
    toast("先にファイルを開いてください（「生成」やエクスプローラーから）");
    return;
  }
  try {
    await saveDoc(doc);
    setStatus("コンパイル中…");
    const res = await invoke<CompileResult>("compile_file", {
      path: doc.path,
      flags: doc.name.endsWith(".cpp") ? cppFlags() : null,
    });
    lastRunCmd = res.run_cmd;
    renderOutput(doc.name, res);
    showPanel("output");
    setStatus(
      res.success ? `✓ コンパイル成功 (${res.compiler})` : "✗ コンパイル失敗",
      res.success ? "ok" : "err",
    );
  } catch (e) {
    setStatus(String(e), "err");
    toast(String(e));
  }
}

$("btn-compile").addEventListener("click", compile);

$("btn-run").addEventListener("click", async () => {
  if (!lastRunCmd) {
    toast("先にコンパイルしてください");
    return;
  }
  showPanel("term");
  try {
    await termPane.send(`cd '${wsDir}' && ${lastRunCmd}\n`);
    termPane.focus();
  } catch (e) {
    toast(String(e));
  }
});

/* ---------- bottom panel (terminal / output) ---------- */

function selectBottomTab(tab: "term" | "output") {
  document
    .querySelectorAll<HTMLButtonElement>("#bottom-tabs button[data-tab]")
    .forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  termEl.classList.toggle("hidden", tab !== "term");
  outputEl.classList.toggle("hidden", tab !== "output");
  if (tab === "term") {
    termPane
      .ensure()
      .then(() => {
        termPane.refit();
        termPane.focus();
      })
      .catch((e) => toast(String(e)));
  }
}

function showPanel(tab: "term" | "output") {
  bottomPanel.classList.remove("hidden");
  termResizer.classList.remove("hidden");
  selectBottomTab(tab);
}

function hidePanel() {
  bottomPanel.classList.add("hidden");
  termResizer.classList.add("hidden");
}

$("btn-term").addEventListener("click", () => {
  if (bottomPanel.classList.contains("hidden")) showPanel("term");
  else hidePanel();
});
$("btn-panel-close").addEventListener("click", hidePanel);
document
  .querySelectorAll<HTMLButtonElement>("#bottom-tabs button[data-tab]")
  .forEach((b) =>
    b.addEventListener("click", () => selectBottomTab(b.dataset.tab as "term" | "output")),
  );

/* ---------- modal ---------- */

let modalCleanup: (() => void) | null = null;

function openModal(
  title: string,
  content: HTMLElement,
  opts: { wide?: boolean; onClose?: () => void } = {},
) {
  modalTitle.textContent = title;
  modalBody.replaceChildren(content);
  modalEl.classList.toggle("wide", !!opts.wide);
  backdrop.classList.remove("hidden");
  modalCleanup = opts.onClose ?? null;
  hideBrowserForDrag();
}

function closeModal() {
  backdrop.classList.add("hidden");
  modalBody.replaceChildren();
  modalCleanup?.();
  modalCleanup = null;
  restoreBrowserAfterDrag();
}

$("modal-close").addEventListener("click", closeModal);
backdrop.addEventListener("click", (e) => {
  if (e.target === backdrop) closeModal();
});

/* ---------- settings modal ---------- */

function openSettings() {
  const wrap = document.createElement("div");
  wrap.className = "settings-form";
  wrap.innerHTML = `
    <fieldset>
      <legend>エディタ</legend>
      <div class="settings-row">
        <label for="set-editor-font">フォントサイズ</label>
        <input id="set-editor-font" type="number" min="10" max="28" value="${settings.editorFontSize}" />
      </div>
      <div class="settings-row">
        <label for="set-minimap">ミニマップを表示</label>
        <input id="set-minimap" type="checkbox" ${settings.minimap ? "checked" : ""} />
      </div>
      <div class="settings-row">
        <label for="set-term-font">ターミナルのフォントサイズ</label>
        <input id="set-term-font" type="number" min="10" max="24" value="${settings.termFontSize}" />
      </div>
    </fieldset>
    <fieldset>
      <legend>C++ コンパイル</legend>
      <div class="settings-row">
        <label for="set-cpp-std">標準規格</label>
        <select id="set-cpp-std">
          ${["gnu++17", "gnu++20", "gnu++23"]
            .map((s) => `<option value="${s}" ${s === settings.cppStd ? "selected" : ""}>${s}</option>`)
            .join("")}
        </select>
      </div>
      <div class="settings-row">
        <label for="set-cpp-opt">最適化</label>
        <select id="set-cpp-opt">
          ${["-O2", "-O0 -g", "-O3"]
            .map((s) => `<option value="${s}" ${s === settings.cppOpt ? "selected" : ""}>${s}</option>`)
            .join("")}
        </select>
      </div>
      <div class="settings-row">
        <label for="set-cpp-extra">追加フラグ</label>
        <input id="set-cpp-extra" type="text" placeholder="-fsanitize=undefined など" value="${settings.cppExtra}" />
      </div>
    </fieldset>
    <fieldset>
      <legend>生成テンプレート（空欄で既定のテンプレート）</legend>
      <div class="settings-row"><label>C++</label></div>
      <textarea id="set-cpp-tpl" spellcheck="false" placeholder="#include <bits/stdc++.h> …">${settings.cppTemplate}</textarea>
      <div class="settings-row"><label>Python</label></div>
      <textarea id="set-py-tpl" spellcheck="false" placeholder="import sys …">${settings.pyTemplate}</textarea>
    </fieldset>
    <div class="settings-actions">
      <button id="set-reset">既定に戻す</button>
      <button id="set-save" class="accent">保存</button>
    </div>
  `;

  wrap.querySelector("#set-reset")!.addEventListener("click", () => {
    settings = { ...DEFAULT_SETTINGS };
    localStorage.setItem("atcode.settings", JSON.stringify(settings));
    applySettings();
    closeModal();
    toast("設定を既定に戻しました");
  });
  wrap.querySelector("#set-save")!.addEventListener("click", () => {
    const num = (id: string, fallback: number) => {
      const v = Number((wrap.querySelector(`#${id}`) as HTMLInputElement).value);
      return Number.isFinite(v) && v > 0 ? v : fallback;
    };
    const val = (id: string) => (wrap.querySelector(`#${id}`) as HTMLInputElement).value;
    settings = {
      editorFontSize: num("set-editor-font", DEFAULT_SETTINGS.editorFontSize),
      minimap: (wrap.querySelector("#set-minimap") as HTMLInputElement).checked,
      termFontSize: num("set-term-font", DEFAULT_SETTINGS.termFontSize),
      cppStd: val("set-cpp-std"),
      cppOpt: val("set-cpp-opt"),
      cppExtra: val("set-cpp-extra").trim(),
      cppTemplate: (wrap.querySelector("#set-cpp-tpl") as HTMLTextAreaElement).value,
      pyTemplate: (wrap.querySelector("#set-py-tpl") as HTMLTextAreaElement).value,
    };
    localStorage.setItem("atcode.settings", JSON.stringify(settings));
    applySettings();
    closeModal();
    toast("設定を保存しました");
  });

  openModal("設定", wrap);
}

/* ---------- env setup modal ---------- */

const OS_LABELS: Record<string, string> = { macos: "macOS", windows: "Windows", linux: "Linux" };

async function openEnv() {
  setStatus("環境をチェック中…");
  const report = await invoke<EnvReport>("env_check");
  setStatus("");
  const wrap = document.createElement("div");
  for (const item of report.items) {
    const box = document.createElement("div");
    box.className = "env-item";

    const h = document.createElement("h3");
    h.textContent = `${item.found ? "✓" : "✗"} ${item.name}`;
    const detail = document.createElement("div");
    detail.className = "detail";
    detail.textContent = item.detail;

    const row = document.createElement("div");
    row.className = "cmd-row";
    const code = document.createElement("code");
    code.textContent = item.install_cmd;
    const copyBtn = document.createElement("button");
    copyBtn.textContent = "コピー";
    copyBtn.addEventListener("click", () => {
      navigator.clipboard.writeText(item.install_cmd);
      toast("コマンドをコピーしました");
    });
    const runBtn = document.createElement("button");
    runBtn.className = "accent";
    runBtn.textContent = "ターミナルで実行";
    runBtn.addEventListener("click", async () => {
      closeModal();
      showPanel("term");
      await termPane.send(item.install_cmd + "\n");
      termPane.focus();
    });
    row.append(code, copyBtn, runBtn);

    const note = document.createElement("div");
    note.className = "note";
    note.textContent = item.note;

    box.append(h, detail, row, note);
    wrap.append(box);
  }
  openModal(`環境構築 — ${OS_LABELS[report.os] ?? report.os}`, wrap);
}

/* ---------- diff modal ---------- */

$("btn-diff").addEventListener("click", async () => {
  const doc = groups.activeDoc();
  if (!doc) {
    toast("先にファイルを開いてください");
    return;
  }
  const snaps = await invoke<SnapshotInfo[]>("list_snapshots", { path: doc.path });
  if (snaps.length === 0) {
    toast("スナップショットがまだありません。コンパイルすると自動保存されます。");
    return;
  }

  const wrap = document.createElement("div");
  wrap.className = "diff-wrap";
  const list = document.createElement("div");
  list.className = "diff-list";
  const editorEl = document.createElement("div");
  editorEl.className = "diff-editor";
  wrap.append(list, editorEl);

  const diffEditor = monaco.editor.createDiffEditor(editorEl, {
    automaticLayout: true,
    originalEditable: false,
    renderSideBySide: true,
    theme: "vs-dark",
  });
  let originalModel: monaco.editor.ITextModel | null = null;

  async function select(snap: SnapshotInfo, btn: HTMLButtonElement) {
    list.querySelectorAll("button").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    const content = await invoke<string>("read_snapshot", { path: doc!.path, id: snap.id });
    originalModel?.dispose();
    originalModel = monaco.editor.createModel(content, languageOf(doc!.name));
    diffEditor.setModel({ original: originalModel, modified: doc!.model });
  }

  const buttons = snaps.map((snap) => {
    const btn = document.createElement("button");
    btn.textContent = new Date(Number(snap.id)).toLocaleString("ja-JP", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    btn.addEventListener("click", () => select(snap, btn));
    list.append(btn);
    return btn;
  });

  openModal(`履歴Diff — ${doc.name}（左: コンパイル時 / 右: 現在）`, wrap, {
    wide: true,
    onClose: () => {
      diffEditor.dispose();
      originalModel?.dispose();
    },
  });
  select(snaps[0], buttons[0]);
});

/* ---------- boot ---------- */

/* ---------- session restore ---------- */

let layoutTimer: ReturnType<typeof setTimeout> | undefined;
groups.onLayoutChange = () => {
  clearTimeout(layoutTimer);
  layoutTimer = setTimeout(() => {
    localStorage.setItem("atcode.layout", JSON.stringify(groups.serialize()));
  }, 300);
  requestAnimationFrame(reportBounds);
};

/* ---------- boot ---------- */

(async () => {
  const savedLang = localStorage.getItem("atcode.lang");
  if (savedLang) langSel.value = savedLang;
  applySettings();
  onUrlChange("");

  // Reopen the tabs from the previous session; fall back to the AtCoder tab.
  let restored = false;
  try {
    const layout = JSON.parse(localStorage.getItem("atcode.layout") ?? "null");
    restored = await groups.restore(layout, async (path) => {
      try {
        return await invoke<string>("read_file", { path });
      } catch {
        return null;
      }
    });
  } catch {
    /* corrupt layout — start fresh */
  }
  if (!restored) groups.openBrowser();

  try {
    wsDir = await invoke<string>("workspace_dir");
    statusWs.textContent = wsDir;
    await tree.init(wsDir);
  } catch (e) {
    toast(String(e));
  }
})();
