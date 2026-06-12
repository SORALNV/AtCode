import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export class TermPane {
  private term: Terminal | null = null;
  private fit = new FitAddon();
  private started = false;
  private fontSize = 13;

  constructor(private el: HTMLElement) {}

  setFontSize(size: number) {
    this.fontSize = size;
    if (this.term) {
      this.term.options.fontSize = size;
      this.refit();
    }
  }

  /** Create xterm on first use and (re)start the PTY if needed. */
  async ensure() {
    if (!this.term) {
      this.term = new Terminal({
        fontSize: this.fontSize,
        fontFamily: "Menlo, Consolas, monospace",
        cursorBlink: true,
        theme: { background: "#1e1e1e" },
      });
      this.term.loadAddon(this.fit);
      this.term.open(this.el);
      this.term.onData((data) => {
        invoke("term_write", { data }).catch(() => {});
      });
      await listen<string>("term:data", (e) => this.term?.write(e.payload));
      await listen("term:exit", () => {
        this.started = false;
        this.term?.write(
          "\r\n\x1b[90m[シェルが終了しました。ターミナルを開き直すと再起動します]\x1b[0m\r\n",
        );
      });
      new ResizeObserver(() => this.refit()).observe(this.el);
    }
    if (!this.started) {
      this.fit.fit();
      await invoke("term_start", {
        cols: this.term.cols,
        rows: this.term.rows,
      });
      this.started = true;
    }
  }

  refit() {
    if (!this.term || this.el.clientWidth === 0) return;
    this.fit.fit();
    if (this.started) {
      invoke("term_resize", {
        cols: this.term.cols,
        rows: this.term.rows,
      }).catch(() => {});
    }
  }

  /** Send a command line to the shell (used by ▶実行 / 環境構築). */
  async send(data: string) {
    await this.ensure();
    await invoke("term_write", { data });
  }

  focus() {
    this.term?.focus();
  }
}
