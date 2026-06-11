import { invoke } from "@tauri-apps/api/core";
import { icon, fileIconName } from "./icons";

interface DirEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

/** Lazy-loading file explorer rooted at the workspace directory. */
export class FileTree {
  private expanded = new Set<string>();
  private rootPath = "";
  private filter = "";

  constructor(
    private container: HTMLElement,
    private onOpen: (path: string, name: string) => void,
  ) {}

  async init(rootPath: string): Promise<void> {
    this.rootPath = rootPath;
    await this.refresh();
  }

  async refresh(): Promise<void> {
    this.container.replaceChildren(await this.renderDir(this.rootPath, 0));
    this.applyFilter();
  }

  setFilter(query: string): void {
    this.filter = query.trim().toLowerCase();
    this.applyFilter();
  }

  private applyFilter(): void {
    this.container.querySelectorAll<HTMLElement>(".tree-row").forEach((row) => {
      if (row.dataset.dir === "true") {
        row.style.display = "";
        return;
      }
      const match = !this.filter || (row.dataset.name ?? "").includes(this.filter);
      row.style.display = match ? "" : "none";
    });
  }

  private async renderDir(path: string, depth: number): Promise<DocumentFragment> {
    const frag = document.createDocumentFragment();
    let entries: DirEntry[] = [];
    try {
      entries = await invoke<DirEntry[]>("read_dir", { path });
    } catch {
      return frag;
    }

    for (const entry of entries) {
      const row = document.createElement("div");
      row.className = "tree-row";
      row.dataset.dir = String(entry.is_dir);
      row.dataset.name = entry.name.toLowerCase();
      row.style.paddingLeft = `${8 + depth * 14}px`;

      if (entry.is_dir) {
        const isOpen = this.expanded.has(entry.path);
        row.innerHTML =
          `<span class="tw">${icon(isOpen ? "chevron-down" : "chevron-right", 14)}</span>` +
          `<span class="ti">${icon(isOpen ? "folder-open" : "folder", 16)}</span>` +
          `<span class="tn">${entry.name}</span>`;

        const childrenWrap = document.createElement("div");
        childrenWrap.className = "tree-children";

        row.addEventListener("click", async () => {
          if (this.expanded.has(entry.path)) {
            this.expanded.delete(entry.path);
            childrenWrap.replaceChildren();
            row.querySelector(".tw")!.innerHTML = icon("chevron-right", 14);
            row.querySelector(".ti")!.innerHTML = icon("folder", 16);
          } else {
            this.expanded.add(entry.path);
            childrenWrap.replaceChildren(await this.renderDir(entry.path, depth + 1));
            row.querySelector(".tw")!.innerHTML = icon("chevron-down", 14);
            row.querySelector(".ti")!.innerHTML = icon("folder-open", 16);
            this.applyFilter();
          }
        });

        frag.append(row, childrenWrap);
        if (isOpen) {
          childrenWrap.replaceChildren(await this.renderDir(entry.path, depth + 1));
        }
      } else {
        row.innerHTML =
          `<span class="tw"></span>` +
          `<span class="ti">${icon(fileIconName(entry.name), 16)}</span>` +
          `<span class="tn">${entry.name}</span>`;
        row.addEventListener("click", () => {
          this.onOpen(entry.path, entry.name);
          this.select(row);
        });
        frag.append(row);
      }
    }
    return frag;
  }

  private select(row: HTMLElement): void {
    this.container.querySelectorAll(".tree-row.sel").forEach((r) => r.classList.remove("sel"));
    row.classList.add("sel");
  }
}
