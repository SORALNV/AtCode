import { Copy, History, Play, RefreshCw, SquareTerminal } from 'lucide-react'

type Language = 'cpp' | 'python' | 'rust'

type EnvironmentPlan = {
  os: string
  package_manager: string
  commands: Array<{ label: string; command: string; check?: string; install?: string; verify?: string }>
}

type SetupCommand = EnvironmentPlan['commands'][number]

type SettingsPanelProps = {
  environmentPlan: EnvironmentPlan | null
  language: Language
  onCopyCommand: (command: string) => void
  onRunSetupCommand: (command: SetupCommand) => void
  onRunLanguageSetup: () => void
  onToggleTerminal: () => void
  onResetLayout: () => void
  onClearDiffHistory: () => void
}

export function SettingsPanel({
  environmentPlan,
  language,
  onCopyCommand,
  onRunSetupCommand,
  onRunLanguageSetup,
  onToggleTerminal,
  onResetLayout,
  onClearDiffHistory,
}: SettingsPanelProps) {
  const languageLabel = language === 'cpp' ? 'C++' : language === 'python' ? 'Python' : 'Rust'

  return (
    <section className="side-panel-section" aria-label="Settings">
      <div className="side-panel-title">設定</div>
      <div className="side-settings-group">
        <div className="side-panel-title compact">環境構築</div>
        <div className="side-panel-meta">
          <strong>{environmentPlan?.os ?? 'OS'}</strong>
          <span>{environmentPlan?.package_manager ?? 'setup'}</span>
        </div>
        <button className="side-action-button primary" type="button" onClick={onRunLanguageSetup}>
          <SquareTerminal size={15} />
          {languageLabel}環境を構築
        </button>
        <div className="side-list">
          {environmentPlan?.commands.map((item) => (
            <div key={item.command} className="side-list-row command-row">
              <button className="command-run-button" type="button" onClick={() => onRunSetupCommand(item)}>
                <Play size={13} />
                <span>{item.label}</span>
              </button>
              <button className="command-copy-button" type="button" onClick={() => onCopyCommand(item.command)} title="コマンドをコピー">
                <Copy size={13} />
              </button>
            </div>
          ))}
        </div>
      </div>
      <button className="side-action-button" type="button" onClick={onToggleTerminal}>
        <SquareTerminal size={15} />
        ターミナルを切替
      </button>
      <button className="side-action-button" type="button" onClick={onResetLayout}>
        <RefreshCw size={15} />
        レイアウトをリセット
      </button>
      <button className="side-action-button" type="button" onClick={onClearDiffHistory}>
        <History size={15} />
        履歴Diffをクリア
      </button>
    </section>
  )
}
