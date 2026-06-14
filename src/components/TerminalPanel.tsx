import type { CSSProperties, RefObject } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import { SquareTerminal, X } from 'lucide-react'

type TerminalPanelProps = {
  height: number
  left: number
  workingDirectory: string
  terminalRef: RefObject<HTMLDivElement | null>
  onResizeStart: (event: ReactMouseEvent<HTMLDivElement>) => void
  onTerminate: () => void
  onClose: () => void
}

export function TerminalPanel({
  height,
  left,
  workingDirectory,
  terminalRef,
  onResizeStart,
  onTerminate,
  onClose,
}: TerminalPanelProps) {
  return (
    <section className="terminal-panel" style={{ height, left } as CSSProperties}>
      <div className="terminal-resizer" onMouseDown={onResizeStart} />
      <div className="terminal-header">
        <div className="terminal-title">
          <SquareTerminal size={15} />
          <span>TERMINAL</span>
        </div>
        <span className="terminal-cwd" title={workingDirectory}>
          {workingDirectory}
        </span>
        <button type="button" onClick={onTerminate} title="ターミナルを終了">
          終了
        </button>
        <button type="button" onClick={onClose} title="ターミナルを閉じる">
          <X size={14} />
        </button>
      </div>
      <div className="terminal-body">
        <div ref={terminalRef} className="terminal-xterm" />
      </div>
    </section>
  )
}
