import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import { icon, fileIconName } from "./icons";

(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker: () => new editorWorker(),
};

export interface OpenDoc {
  path: string;
  name: string;
  model: monaco.editor.ITextModel;
  dirty: boolean;
}

export function languageOf(name: string): string {
  if (name.endsWith(".py")) return "python";
  if (/\.(cpp|cc|cxx|h|hpp)$/.test(name)) return "cpp";
  if (name.endsWith(".rs")) return "rust";
  if (name.endsWith(".java")) return "java";
  return "plaintext";
}

const DRAG_MIME = "text/atcode-path";

/**
 * One tabbed editor view. Several groups can coexist side by side; they share
 * the document models held by {@link GroupManager}, so edits sync everywhere
 * a file is open (just like VSCode editor groups).
 */
class EditorGroup {
  readonly el = document.createElement("div");
  readonly tabbar = document.createElement("div");
  readonly editorEl = document.createElement("div");
  readonly editor: monaco.editor.IStandaloneCodeEditor;
  tabs: string[] = [];
  active: string | null = null;

  constructor(private mgr: GroupManager) {
    this.el.className = "editor-group";
    this.tabbar.className = "egroup-tabs";
    this.editorEl.className = "egroup-editor";
    this.el.append(this.tabbar, this.editorEl);

    this.editor = monaco.editor.create(this.editorEl, {
      model: null,
      theme: "vs-dark",
      automaticLayout: true,
      fontSize: 14,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      padding: { top: 8 },
    });
    this.editor.onDidFocusEditorText(() => this.mgr.setActiveGroup(this));
    this.editor.addAction({
      id: "atcode.save",
      label: "保存",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
      run: () => {
        const d = this.activeDoc();
        if (d) this.mgr.onSave?.(d);
      },
    });
    this.editor.addAction({
      id: "atcode.compile",
      label: "コンパイル",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
      run: () => this.mgr.onCompile?.(),
    });

    this.el.addEventListener("mousedown", () => this.mgr.setActiveGroup(this), true);

    this.tabbar.addEventListener("dragover", (e) => {
      if (!e.dataTransfer?.types.includes(DRAG_MIME)) return;
      e.preventDefault();
      this.tabbar.classList.add("drop");
    });
    this.tabbar.addEventListener("dragleave", () => this.tabbar.classList.remove("drop"));
    this.tabbar.addEventListener("drop", (e) => {
      e.preventDefault();
      this.tabbar.classList.remove("drop");
      const path = e.dataTransfer?.getData(DRAG_MIME);
      if (path) this.mgr.moveTab(path, this, this.dropIndex(e.clientX));
    });
  }

  activeDoc(): OpenDoc | null {
    return this.active ? this.mgr.docs.get(this.active) ?? null : null;
  }

  has(path: string): boolean {
    return this.tabs.includes(path);
  }

  open(path: string): void {
    if (!this.tabs.includes(path)) this.tabs.push(path);
    this.activate(path);
  }

  activate(path: string): void {
    const doc = this.mgr.docs.get(path);
    if (!doc) return;
    this.active = path;
    this.editor.setModel(doc.model);
    this.renderTabs();
    this.mgr.setActiveGroup(this);
  }

  setModelForActive(): void {
    this.editor.setModel(this.active ? this.mgr.docs.get(this.active)!.model : null);
  }

  close(path: string): void {
    const idx = this.tabs.indexOf(path);
    if (idx < 0) return;
    this.tabs.splice(idx, 1);
    if (this.active === path) {
      this.active = this.tabs[idx] ?? this.tabs[idx - 1] ?? null;
      this.setModelForActive();
    }
    this.renderTabs();
    this.mgr.afterClose(path);
  }

  private dropIndex(clientX: number): number {
    const tabs = [...this.tabbar.querySelectorAll<HTMLElement>(".etab")];
    for (let i = 0; i < tabs.length; i++) {
      const r = tabs[i].getBoundingClientRect();
      if (clientX < r.left + r.width / 2) return i;
    }
    return tabs.length;
  }

  renderTabs(): void {
    this.tabbar.replaceChildren(
      ...this.tabs.map((path) => {
        const doc = this.mgr.docs.get(path)!;
        const tab = document.createElement("div");
        tab.className =
          "etab" + (path === this.active ? " active" : "") + (doc.dirty ? " dirty" : "");
        tab.draggable = true;
        tab.innerHTML =
          `<span class="etab-icon">${icon(fileIconName(doc.name), 15)}</span>` +
          `<span class="etab-name">${doc.name}</span>`;

        const close = document.createElement("button");
        close.className = "etab-close";
        close.title = "閉じる";
        close.innerHTML = `<span class="dirty-dot">●</span>${icon("close", 13)}`;
        close.addEventListener("click", (e) => {
          e.stopPropagation();
          this.close(path);
        });
        tab.append(close);

        tab.addEventListener("click", () => this.activate(path));
        tab.addEventListener("dragstart", (e) => {
          e.dataTransfer!.setData(DRAG_MIME, path);
          e.dataTransfer!.effectAllowed = "move";
          this.mgr.onDragStart?.();
        });
        tab.addEventListener("dragend", () => this.mgr.onDragEnd?.());
        return tab;
      }),
    );
  }
}

export class GroupManager {
  readonly docs = new Map<string, OpenDoc>();
  groups: EditorGroup[] = [];
  active!: EditorGroup;

  onSave?: (doc: OpenDoc) => void;
  onCompile?: () => void;
  onActiveChange?: (doc: OpenDoc | null) => void;
  onDragStart?: () => void;
  onDragEnd?: () => void;

  constructor(
    private container: HTMLElement,
    private emptyEl: HTMLElement,
  ) {
    this.addGroup();
  }

  private addGroup(): EditorGroup {
    const g = new EditorGroup(this);
    this.groups.push(g);
    this.active = g;
    this.relayout();
    return g;
  }

  setActiveGroup(g: EditorGroup): void {
    const changed = this.active !== g;
    this.active = g;
    this.updateFocusClass();
    if (changed) this.onActiveChange?.(g.activeDoc());
  }

  private updateFocusClass(): void {
    const multi = this.groups.length > 1;
    this.groups.forEach((g) => g.el.classList.toggle("focused", multi && g === this.active));
  }

  activeDoc(): OpenDoc | null {
    return this.active.activeDoc();
  }

  private ensureDoc(path: string, name: string, content: string): OpenDoc {
    let doc = this.docs.get(path);
    if (!doc) {
      const uri = monaco.Uri.file(path);
      const model =
        monaco.editor.getModel(uri) ?? monaco.editor.createModel(content, languageOf(name), uri);
      doc = { path, name, model, dirty: false };
      const created = doc;
      model.onDidChangeContent(() => {
        if (!created.dirty) {
          created.dirty = true;
          this.renderAll();
        }
      });
      this.docs.set(path, doc);
    }
    return doc;
  }

  /** Open a file in the active group (creating its model if needed). */
  openFile(path: string, name: string, content: string): void {
    this.ensureDoc(path, name, content);
    this.active.open(path);
    this.emptyEl.classList.add("hidden");
    this.onActiveChange?.(this.active.activeDoc());
    this.active.editor.focus();
  }

  markSaved(doc: OpenDoc): void {
    doc.dirty = false;
    this.renderAll();
  }

  /** Split the active file into a second group to the right (max 2 groups). */
  splitRight(): void {
    const doc = this.active.activeDoc();
    if (!doc || this.groups.length >= 2) return;
    const g = this.addGroup();
    g.open(doc.path);
    this.updateFocusClass();
    this.onActiveChange?.(g.activeDoc());
  }

  /** Move a tab to `toGroup` at `index` (reorders if it's the same group). */
  moveTab(path: string, toGroup: EditorGroup, index: number): void {
    const from = this.groups.find((g) => g.has(path));
    if (!from) return;

    if (from === toGroup) {
      const cur = toGroup.tabs.indexOf(path);
      toGroup.tabs.splice(cur, 1);
      toGroup.tabs.splice(cur < index ? index - 1 : index, 0, path);
      toGroup.activate(path);
      return;
    }

    from.tabs.splice(from.tabs.indexOf(path), 1);
    if (from.active === path) {
      from.active = from.tabs[from.tabs.length - 1] ?? null;
      from.setModelForActive();
    }
    from.renderTabs();
    toGroup.tabs.splice(index, 0, path);
    toGroup.activate(path);
    this.collapseEmpty();
  }

  afterClose(path: string): void {
    if (!this.groups.some((g) => g.has(path))) {
      this.docs.get(path)?.model.dispose();
      this.docs.delete(path);
    }
    this.collapseEmpty();
    if (this.docs.size === 0) this.emptyEl.classList.remove("hidden");
    this.onActiveChange?.(this.active.activeDoc());
  }

  private collapseEmpty(): void {
    if (this.groups.length > 1) {
      for (const g of this.groups.filter((g) => g.tabs.length === 0)) {
        g.editor.dispose();
        this.groups = this.groups.filter((x) => x !== g);
      }
      if (!this.groups.includes(this.active)) this.active = this.groups[0];
      this.relayout();
    }
    this.updateFocusClass();
  }

  private relayout(): void {
    const children: HTMLElement[] = [];
    this.groups.forEach((g, i) => {
      g.el.style.flex = "1";
      if (i > 0) {
        const rs = document.createElement("div");
        rs.className = "egroup-resizer";
        rs.addEventListener("mousedown", (e) => this.startGroupResize(e));
        children.push(rs);
      }
      children.push(g.el);
    });
    this.container.replaceChildren(...children);
    this.groups.forEach((g) => g.renderTabs());
  }

  private startGroupResize(e: MouseEvent): void {
    e.preventDefault();
    this.onDragStart?.();
    const rect = this.container.getBoundingClientRect();
    const move = (ev: MouseEvent) => {
      const ratio = Math.min(Math.max((ev.clientX - rect.left) / rect.width, 0.2), 0.8);
      this.groups[0].el.style.flex = `${ratio}`;
      this.groups[1].el.style.flex = `${1 - ratio}`;
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      this.onDragEnd?.();
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  }

  private renderAll(): void {
    this.groups.forEach((g) => g.renderTabs());
  }
}
