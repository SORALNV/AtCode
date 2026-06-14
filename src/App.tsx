import {
  type ChangeEvent,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { open as openFileDialog } from '@tauri-apps/plugin-dialog'
import Editor, { type BeforeMount, type OnMount } from '@monaco-editor/react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import {
  basename,
  changeDirectoryCommand,
  commandJoiner,
  defaultWorkspacePath,
  isWindowsHost,
  joinPath,
  parentDirectory,
  shellQuote,
} from './utils/platform'
import { SettingsPanel } from './components/SettingsPanel'
import { TerminalPanel } from './components/TerminalPanel'
import {
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  ExternalLink,
  FileCode2,
  FilePlus2,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Globe2,
  Hammer,
  Play,
  Plus,
  RefreshCw,
  RotateCw,
  Search,
  Settings,
  SquareTerminal,
  X,
} from 'lucide-react'
import '@xterm/xterm/css/xterm.css'
import './App.css'

type Language = 'cpp' | 'python' | 'rust'
type WebTarget = 'atcoder' | 'problems'
type SidePanelMode = 'explorer' | 'search' | 'settings'
type WebSide = 'left' | 'right'
type PaneDragItem = { kind: 'code'; path: string } | { kind: 'web' }
type WebTab = {
  id: string
  target: WebTarget
  url: string
  draftUrl: string
}
type OpenFileTab = {
  path: string
  content: string
  language: Language
  group: WebSide
}
type MonacoInstance = Parameters<BeforeMount>[0]
type MonacoEditor = Parameters<OnMount>[0]

type EnvironmentPlan = {
  os: string
  package_manager: string
  commands: Array<{ label: string; command: string; check?: string; install?: string; verify?: string }>
  notes: string[]
}

type SolutionFile = {
  path: string
  content: string
  language: Language
}

type ExplorerNode = {
  name: string
  path: string
  isDir: boolean
  children: ExplorerNode[]
}

type CommandResult = {
  command: string
  status: number
  stdout: string
  stderr: string
}

type BuildResult = {
  file_path: string
  cwd: string
  command: string
  status: number
  stdout: string
  stderr: string
  diff: string
  executable_path?: string | null
}

type DiffEntry = {
  id: string
  source: 'compile' | 'run'
  filePath: string
  fileName: string
  cwd: string
  command: string
  status: number
  diff: string
  createdAt: string
}

type ContestWebviewRequest = {
  tabId: string
  url: string
  navigate?: boolean
  x: number
  y: number
  width: number
  height: number
}

type WebviewUrlEvent = {
  tabId: string
  url: string
}

type TerminalOutputEvent = {
  data: string
}

type ExplorerContextTarget = {
  kind: 'file' | 'folder' | 'open-file'
  path: string
  name: string
  isDir: boolean
}

type ExplorerContextMenu = {
  x: number
  y: number
  target: ExplorerContextTarget
}

type TaskFromUrl = {
  contest: string
  problem: string
}

const isTauri = () => '__TAURI_INTERNALS__' in window

const languageExtensions: Record<Language, string> = {
  cpp: 'cpp',
  python: 'py',
  rust: 'rs',
}


const monacoLanguageIds: Record<Language, string> = {
  cpp: 'cpp',
  python: 'python',
  rust: 'rust',
}

type CodeIssue = {
  lineNumber: number
  startColumn: number
  endColumn: number
  message: string
  severity: 'error' | 'warning'
}

const webTargets: Record<WebTarget, { label: string; url: string }> = {
  atcoder: { label: 'AtCoder', url: 'https://atcoder.jp/' },
  problems: { label: 'Problems', url: 'https://kenkoooo.com/atcoder/' },
}

const initialWebTab: WebTab = {
  id: 'web-1',
  target: 'problems',
  url: webTargets.problems.url,
  draftUrl: webTargets.problems.url,
}

const recentFoldersKey = 'accode.recentFolders'

const fallbackPlan: EnvironmentPlan = {
  os: navigator.platform.toLowerCase().includes('win') ? 'Windows' : 'macOS/Linux',
  package_manager: navigator.platform.toLowerCase().includes('win')
    ? 'winget + MSYS2'
    : 'Homebrew / apt',
  commands: navigator.platform.toLowerCase().includes('win')
    ? [
        {
          label: 'Python',
          command: 'winget install -e --id Python.Python.3.13',
          check: 'Get-Command py -ErrorAction SilentlyContinue',
          install: 'winget install -e --id Python.Python.3.13',
          verify: 'py -3 --version',
        },
        {
          label: 'C++',
          command:
            'winget install -e --id MSYS2.MSYS2 && C:\\msys64\\usr\\bin\\pacman -S --needed mingw-w64-ucrt-x86_64-gcc',
          check: 'Test-Path C:\\msys64\\ucrt64\\bin\\g++.exe',
          install:
            'winget install -e --id MSYS2.MSYS2; C:\\msys64\\usr\\bin\\bash.exe -lc "pacman -S --needed --noconfirm mingw-w64-ucrt-x86_64-gcc"',
          verify: 'C:\\msys64\\ucrt64\\bin\\g++.exe --version',
        },
        {
          label: 'Rust',
          command: 'winget install -e --id Rustlang.Rustup',
          check: 'Get-Command rustc -ErrorAction SilentlyContinue',
          install: 'winget install -e --id Rustlang.Rustup',
          verify: 'rustc --version',
        },
      ]
    : [
        {
          label: 'Xcode CLI',
          command: 'xcode-select --install',
          check: 'xcode-select -p',
          install: 'xcode-select --install',
          verify: 'xcode-select -p',
        },
        {
          label: 'Python',
          command: 'brew install python',
          check: 'command -v python3',
          install: 'brew install python',
          verify: 'python3 --version',
        },
        {
          label: 'C++',
          command: 'brew install gcc',
          check: 'command -v g++-15 || command -v g++-14 || command -v g++',
          install: 'brew install gcc',
          verify: 'g++ --version',
        },
        {
          label: 'Rust',
          command: 'brew install rustup && rustup-init',
          check: 'command -v rustc',
          install: 'brew install rustup && rustup-init',
          verify: 'rustc --version',
        },
      ],
  notes: [],
}

async function callBackend<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (isTauri()) return invoke<T>(command, args)

  await new Promise((resolve) => window.setTimeout(resolve, 120))
  if (command === 'get_environment_plan') return fallbackPlan as T

  if (command === 'create_solution_file') {
    const request = args?.request as { contest: string; problem: string; language: Language }
    const contest = (request.contest || 'abc423').toLowerCase()
    const problem = request.problem ? `_${request.problem.toLowerCase()}` : ''
    return {
      path: `/Users/sora/AtCode/${contest}/${contest}${problem}.${languageExtensions[request.language]}`,
      content: templateFor(request.language),
      language: request.language,
    } as T
  }

  if (command === 'build_solution') {
    const path = String((args?.request as { path: string }).path)
    const cwd = path.split('/').slice(0, -1).join('/') || '.'
    return {
      file_path: path,
      cwd,
      command: `cd ${cwd} && Preview build command runs inside Tauri.`,
      status: 0,
      stdout: 'Preview build completed.',
      stderr: '',
      diff: 'Preview mode does not persist build snapshots.',
      executable_path: null,
    } as T
  }

  if (command === 'run_solution') {
    const path = String((args?.request as { path: string }).path)
    const cwd = path.split('/').slice(0, -1).join('/') || '.'
    return {
      build: {
        file_path: path,
        cwd,
        command: `cd ${cwd} && Preview build command runs inside Tauri.`,
        status: 0,
        stdout: 'Preview build completed.',
        stderr: '',
        diff: 'Preview mode does not persist build snapshots.',
        executable_path: null,
      },
      run: {
        command: `cd ${cwd} && Preview run command runs inside Tauri.`,
        status: 0,
        stdout: 'Preview run completed.',
        stderr: '',
      },
    } as T
  }

  if (command === 'run_terminal_command') {
    return {
      command: String(args?.command ?? ''),
      status: 0,
      stdout: 'Preview terminal is read-only.',
      stderr: '',
    } as T
  }

  if (command === 'is_allowed_atcoder_url') {
    return isAllowedContestUrl(String(args?.url ?? '')) as T
  }

  return false as T
}

function normalizeWebUrl(value: string) {
  const trimmed = value.trim()
  if (!trimmed) return webTargets.atcoder.url
  if (
    trimmed.startsWith('atcoder.jp') ||
    trimmed.startsWith('atcoder-problems.com') ||
    trimmed.startsWith('kenkoooo.com/atcoder')
  ) {
    return `https://${trimmed}`
  }
  return trimmed
}

function isAllowedContestUrl(value: string) {
  try {
    const url = new URL(normalizeWebUrl(value))
    if (['atcoder.jp', 'www.atcoder.jp', 'atcoder-problems.com', 'www.atcoder-problems.com'].includes(url.hostname)) {
      return true
    }
    if (url.hostname === 'github.com' || url.hostname === 'www.github.com') {
      return isAllowedAuthPath(url.pathname)
    }
    return url.hostname === 'kenkoooo.com' && url.pathname.startsWith('/atcoder')
  } catch {
    return false
  }
}

function isAllowedAuthPath(pathname: string) {
  return (
    pathname === '/login' ||
    pathname === '/session' ||
    pathname.startsWith('/sessions') ||
    pathname.startsWith('/login/oauth') ||
    pathname.startsWith('/password_reset') ||
    pathname.startsWith('/account_verifications') ||
    pathname.startsWith('/webauthn') ||
    pathname.startsWith('/u2f')
  )
}

function targetFromWebUrl(value: string): WebTarget {
  try {
    const url = new URL(normalizeWebUrl(value))
    if (url.hostname === 'kenkoooo.com' || url.hostname.includes('atcoder-problems.com')) return 'problems'
  } catch {
    return 'atcoder'
  }
  return 'atcoder'
}

function taskFromAtcoderUrl(value: string): TaskFromUrl | null {
  try {
    const url = new URL(normalizeWebUrl(value))
    const atcoderMatch = url.pathname.match(/^\/contests\/([^/]+)\/tasks\/([^/]+)/)
    if (atcoderMatch) return taskFromTaskId(atcoderMatch[1], atcoderMatch[2])

    const hashContest = url.hash.match(/#\/contest\/show\/([^?]+)/)?.[1]
    const hashQuery = url.hash.includes('?') ? url.hash.slice(url.hash.indexOf('?') + 1) : ''
    const taskScreenName = new URLSearchParams(hashQuery).get('taskScreenName')
    if (taskScreenName) {
      const contest = hashContest || taskScreenName.split('_').slice(0, -1).join('_')
      return taskFromTaskId(contest, taskScreenName)
    }

    const genericTaskMatch = value.toLowerCase().match(/\b((?:abc|arc|agc|ahc)\d{3,4})_([a-z][a-z0-9]*)\b/)
    if (genericTaskMatch) {
      return { contest: genericTaskMatch[1], problem: genericTaskMatch[2] }
    }
  } catch {
    return null
  }
  return null
}

function taskFromTaskId(contestValue: string, taskIdValue: string): TaskFromUrl | null {
  const contest = contestValue.toLowerCase()
  const taskId = taskIdValue.toLowerCase()
  const prefix = `${contest}_`
  const problem = taskId.startsWith(prefix) ? taskId.slice(prefix.length) : taskId.split('_').pop() || taskId
  if (!contest || !problem) return null
  return { contest, problem }
}

function templateFor(language: Language) {
  if (language === 'python') {
    return `def main() -> None:
    pass


if __name__ == "__main__":
    main()
`
  }

  if (language === 'rust') {
    return `fn main() {
}
`
  }

  return `#if __has_include(<bits/stdc++.h>)
#include <bits/stdc++.h>
#else
#include <algorithm>
#include <array>
#include <bitset>
#include <cassert>
#include <cctype>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <deque>
#include <fstream>
#include <functional>
#include <iomanip>
#include <iostream>
#include <iterator>
#include <limits>
#include <map>
#include <memory>
#include <numeric>
#include <queue>
#include <set>
#include <sstream>
#include <string>
#include <tuple>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>
#endif
using namespace std;

int main() {
}
`
}

function languageFromPath(path: string): Language {
  const extension = path.split('.').pop()?.toLowerCase()
  if (extension === 'py') return 'python'
  if (extension === 'rs') return 'rust'
  return 'cpp'
}


function stripLineComment(line: string, language: Language) {
  let inString: string | null = null
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    const next = line[index + 1]
    const previous = line[index - 1]
    if (inString) {
      if (char === inString && previous !== '\\') inString = null
      continue
    }
    if (char === '"' || char === "'") {
      inString = char
      continue
    }
    if (language !== 'python' && char === '/' && next === '/') return line.slice(0, index)
    if (language === 'python' && char === '#') return line.slice(0, index)
  }
  return line
}

function firstNonSpaceColumn(line: string) {
  const match = line.match(/\S/)
  return match ? match.index! + 1 : 1
}


function collectCodeIssues(source: string, language: Language): CodeIssue[] {
  const issues: CodeIssue[] = []
  const stack: Array<{ char: string; lineNumber: number; column: number }> = []
  const openToClose: Record<string, string> = { '(': ')', '[': ']', '{': '}' }
  const closeToOpen: Record<string, string> = { ')': '(', ']': '[', '}': '{' }
  const lines = source.split('\n')

  lines.forEach((line, index) => {
    const lineNumber = index + 1
    const withoutComment = stripLineComment(line, language)
    let inString: string | null = null
    let stringStart = 0

    for (let columnIndex = 0; columnIndex < withoutComment.length; columnIndex += 1) {
      const char = withoutComment[columnIndex]
      const previous = withoutComment[columnIndex - 1]
      if (inString) {
        if (char === inString && previous !== '\\') inString = null
        continue
      }
      if (char === '"' || char === "'") {
        inString = char
        stringStart = columnIndex + 1
        continue
      }
      if (openToClose[char]) {
        stack.push({ char, lineNumber, column: columnIndex + 1 })
        continue
      }
      if (closeToOpen[char]) {
        const last = stack.at(-1)
        if (!last || last.char !== closeToOpen[char]) {
          issues.push({
            lineNumber,
            startColumn: columnIndex + 1,
            endColumn: columnIndex + 2,
            message: `対応する ${closeToOpen[char]} がありません`,
            severity: 'error',
          })
        } else {
          stack.pop()
        }
      }
    }

    if (inString) {
      issues.push({
        lineNumber,
        startColumn: stringStart,
        endColumn: Math.max(stringStart + 1, withoutComment.length + 1),
        message: '文字列が閉じられていません',
        severity: 'error',
      })
    }

    const trimmed = withoutComment.trim()
    if (!trimmed) return

    if (language === 'python') {
      if (/^(if|elif|else|for|while|def|class|try|except|finally|with)\b/.test(trimmed) && !trimmed.endsWith(':')) {
        issues.push({
          lineNumber,
          startColumn: firstNonSpaceColumn(line),
          endColumn: withoutComment.length + 1,
          message: 'Python のブロック行は末尾に : が必要です',
          severity: 'error',
        })
      }
      if (/^\t+ +|^ +\t+/.test(line)) {
        issues.push({
          lineNumber,
          startColumn: 1,
          endColumn: Math.min(line.length + 1, 8),
          message: 'タブとスペースの混在は避けてください',
          severity: 'warning',
        })
      }
    }
  })

  for (const item of stack.slice(-8)) {
    issues.push({
      lineNumber: item.lineNumber,
      startColumn: item.column,
      endColumn: item.column + 1,
      message: `対応する ${openToClose[item.char]} がありません`,
      severity: 'error',
    })
  }

  return issues.slice(0, 80)
}


function collectCompilerIssues(output: string): CodeIssue[] {
  const issues: CodeIssue[] = []
  const lines = output.split('\n')
  let pendingRust: { message: string; severity: 'error' | 'warning' } | null = null
  let pendingPythonLine: number | null = null

  lines.forEach((line) => {
    const cppMatch = line.match(/:(\d+):(\d+):\s+(error|warning):\s+(.+)$/)
    if (cppMatch) {
      const lineNumber = Number(cppMatch[1])
      const column = Number(cppMatch[2])
      issues.push({
        lineNumber,
        startColumn: Math.max(1, column),
        endColumn: Math.max(2, column + 1),
        message: cppMatch[4],
        severity: cppMatch[3] === 'error' ? 'error' : 'warning',
      })
      return
    }

    const rustHeader = line.match(/^(error(?:\[[^\]]+\])?|warning):\s+(.+)$/)
    if (rustHeader) {
      pendingRust = {
        message: rustHeader[2],
        severity: rustHeader[1].startsWith('error') ? 'error' : 'warning',
      }
      return
    }

    const rustLocation = line.match(/-->\s+.*:(\d+):(\d+)/)
    if (rustLocation && pendingRust) {
      const lineNumber = Number(rustLocation[1])
      const column = Number(rustLocation[2])
      issues.push({
        lineNumber,
        startColumn: Math.max(1, column),
        endColumn: Math.max(2, column + 1),
        message: pendingRust.message,
        severity: pendingRust.severity,
      })
      pendingRust = null
      return
    }

    const pythonFile = line.match(/File ".+", line (\d+)/)
    if (pythonFile) {
      pendingPythonLine = Number(pythonFile[1])
      return
    }

    const pythonError = line.match(/^\s*(SyntaxError|IndentationError|NameError|TypeError|ValueError):\s+(.+)$/)
    if (pythonError && pendingPythonLine) {
      issues.push({
        lineNumber: pendingPythonLine,
        startColumn: 1,
        endColumn: 2,
        message: `${pythonError[1]}: ${pythonError[2]}`,
        severity: 'error',
      })
      pendingPythonLine = null
    }
  })

  return issues.slice(0, 80)
}

function workspaceRootFromGeneratedPath(path: string, contest: string) {
  const marker = `/${contest.toLowerCase()}/`
  const index = path.indexOf(marker)
  if (index > 0) return path.slice(0, index)
  return parentDirectory(path)
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function initialWebPaneWidth() {
  const maxWidth = Math.max(360, window.innerWidth - 48 - 8 - 300 - 248)
  return clamp(Math.round(window.innerWidth * 0.47), 360, maxWidth)
}

function oppositeSide(side: WebSide): WebSide {
  return side === 'left' ? 'right' : 'left'
}

function codePaneKey(path: string) {
  return `code:${path}`
}

function webPaneKey(id: string) {
  return `web:${id}`
}

function App() {
  const [environmentPlan, setEnvironmentPlan] = useState<EnvironmentPlan | null>(null)
  const [contest] = useState('ABC423')
  const [problem] = useState('A')
  const [language, setLanguage] = useState<Language>('cpp')
  const [workspacePath, setWorkspacePath] = useState('')
  const [explorerTree, setExplorerTree] = useState<ExplorerNode | null>(null)
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set())
  const [recentFolders, setRecentFolders] = useState<string[]>(() => {
    try {
      const stored = localStorage.getItem(recentFoldersKey)
      return stored ? (JSON.parse(stored) as string[]) : []
    } catch {
      return []
    }
  })
  const [filePath, setFilePath] = useState('')
  const [code, setCode] = useState('')
  const [openFileTabs, setOpenFileTabs] = useState<OpenFileTab[]>([])
  const [terminalOpen, setTerminalOpen] = useState(false)
  const [terminalHeight, setTerminalHeight] = useState(220)
  const [terminalCwdOverride, setTerminalCwdOverride] = useState('')
  const [diffHistory, setDiffHistory] = useState<DiffEntry[]>([])
  const [activeDiffId, setActiveDiffId] = useState('')
  const [compilerIssues, setCompilerIssues] = useState<CodeIssue[]>([])
  const [diffOpen, setDiffOpen] = useState(false)
  const [explorerDiffHeight, setExplorerDiffHeight] = useState(220)
  const [sidePanelMode, setSidePanelMode] = useState<SidePanelMode>('explorer')
  const [searchQuery, setSearchQuery] = useState('')
  const [busyLabel, setBusyLabel] = useState('')
  const [webTabs, setWebTabs] = useState<WebTab[]>([initialWebTab])
  const [activeWebTabId, setActiveWebTabId] = useState(initialWebTab.id)
  const [webTabMenu, setWebTabMenu] = useState<{ x: number; y: number } | null>(null)
  const [explorerContextMenu, setExplorerContextMenu] = useState<ExplorerContextMenu | null>(null)
  const [webError, setWebError] = useState('')
  const [webSide, setWebSide] = useState<WebSide>('right')
  const [activePaneItems, setActivePaneItems] = useState<Record<WebSide, string>>({
    left: '',
    right: webPaneKey(initialWebTab.id),
  })
  const [paneDragItem, setPaneDragItem] = useState<PaneDragItem | null>(null)
  const [paneDragOverSide, setPaneDragOverSide] = useState<WebSide | null>(null)
  const [suppressPaneClick, setSuppressPaneClick] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState(248)
  const [webWidth, setWebWidth] = useState(initialWebPaneWidth)
  const dragStart = useRef<{ y: number; height: number; lastHeight: number } | null>(null)
  const explorerDiffDragStart = useRef<{ y: number; height: number } | null>(null)
  const sidebarWidthRef = useRef(sidebarWidth)
  const webWidthRef = useRef(webWidth)
  const lastSidebarWidthRef = useRef(248)
  const lastWebWidthRef = useRef(initialWebPaneWidth())
  const layoutDragRef = useRef<
    | {
        type: 'sidebar' | 'web'
        x: number
        sidebarWidth: number
        webWidth: number
      }
    | null
  >(null)
  const paneDragCandidateRef = useRef<{
    item: PaneDragItem
    startX: number
    startY: number
    pointerId: number
  } | null>(null)
  const paneDragActiveRef = useRef<PaneDragItem | null>(null)
  const folderInputRef = useRef<HTMLInputElement | null>(null)
  const browserFolderFilesRef = useRef<Map<string, File>>(new Map())
  const webFrameRef = useRef<HTMLDivElement | null>(null)
  const terminalElementRef = useRef<HTMLDivElement | null>(null)
  const terminalCwdRef = useRef('')
  const pendingTerminalInputsRef = useRef<string[]>([])
  const pendingTerminalWritesRef = useRef<string[]>([])
  const xtermRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const monacoRef = useRef<MonacoInstance | null>(null)
  const editorRef = useRef<MonacoEditor | null>(null)
  const webUrlRef = useRef(initialWebTab.url)
  const webviewUrlsRef = useRef<Map<string, string>>(new Map())
  const webTabCounterRef = useRef(2)
  const diffCounterRef = useRef(0)
  const activeWebTabIdRef = useRef(activeWebTabId)
  const webSideRef = useRef<WebSide>(webSide)
  const skipNextWebNavigateRef = useRef(false)
  const workspaceRestoredRef = useRef(false)

  const activeWebTab = useMemo(
    () => webTabs.find((tab) => tab.id === activeWebTabId) ?? webTabs[0] ?? initialWebTab,
    [activeWebTabId, webTabs],
  )
  const webTarget = activeWebTab.target
  const webDraftUrl = activeWebTab.draftUrl
  const webUrl = activeWebTab.url
  const sidebarHidden = sidebarWidth <= 0
  const webHidden = webWidth <= 0
  const currentTask = taskFromAtcoderUrl(webUrl)
  const currentContest = currentTask?.contest ?? contest
  const currentProblem = currentTask?.problem ?? problem
  const currentTaskLabel = currentTask ? `${currentTask.contest}_${currentTask.problem}` : '問題未検出'
  const currentGeneratedName = useMemo(
    () => `${currentContest}_${currentProblem}.${languageExtensions[language]}`,
    [currentContest, currentProblem, language],
  )
  const codeSide = oppositeSide(webSide)
  const paneItemsBySide = useMemo<Record<WebSide, string[]>>(() => {
    const leftCode = openFileTabs.filter((tab) => tab.group === 'left').map((tab) => codePaneKey(tab.path))
    const rightCode = openFileTabs.filter((tab) => tab.group === 'right').map((tab) => codePaneKey(tab.path))
    const webItems = webHidden ? [] : webTabs.map((tab) => webPaneKey(tab.id))
    return {
      left: webSide === 'left' ? [...webItems, ...leftCode] : leftCode,
      right: webSide === 'right' ? [...webItems, ...rightCode] : rightCode,
    }
  }, [openFileTabs, webHidden, webSide, webTabs])
  const activePaneKey = useCallback((side: WebSide) => {
    const items = paneItemsBySide[side]
    const active = activePaneItems[side]
    return items.includes(active) ? active : items[0] ?? ''
  }, [activePaneItems, paneItemsBySide])
  const activeWebVisible = !webHidden && activePaneKey(webSide).startsWith('web:')
  const setPaneByDrop = useCallback((item: PaneDragItem, side: WebSide) => {
    if (item.kind === 'web') {
      if (webWidth <= 0) setWebWidth(lastWebWidthRef.current || initialWebPaneWidth())
      setWebSide(side)
      setActivePaneItems((current) => ({ ...current, [side]: webPaneKey(activeWebTabId) }))
      return
    }

    setOpenFileTabs((current) =>
      current.map((tab) => (tab.path === item.path ? { ...tab, group: side } : tab)),
    )
    setActivePaneItems((current) => ({ ...current, [side]: codePaneKey(item.path) }))
    const moved = openFileTabs.find((tab) => tab.path === item.path)
    if (moved) activateFileTab({ ...moved, group: side })
  }, [activeWebTabId, openFileTabs, webWidth])

  const explorerFileName = filePath ? filePath.split('/').pop() || currentGeneratedName : ''
  const explorerRootName = useMemo(() => {
    if (!workspacePath) return 'NO FOLDER'
    const parts = workspacePath.split('/').filter(Boolean)
    return (parts.at(-1) || workspacePath).toUpperCase()
  }, [workspacePath])
  const editorIssues = useMemo(() => [...collectCodeIssues(code, language), ...compilerIssues], [code, compilerIssues, language])
  const errorCount = editorIssues.filter((issue) => issue.severity === 'error').length
  const warningCount = editorIssues.length - errorCount
  const selectedFileDiffs = useMemo(
    () => (filePath ? diffHistory.filter((entry) => entry.filePath === filePath) : []),
    [diffHistory, filePath],
  )
  const activeFileDiff = useMemo(
    () => selectedFileDiffs.find((entry) => entry.id === activeDiffId) ?? selectedFileDiffs[0] ?? null,
    [activeDiffId, selectedFileDiffs],
  )
  const terminalWorkingDirectory = terminalCwdOverride || (filePath
    ? parentDirectory(filePath)
    : workspacePath || defaultWorkspacePath())

  useEffect(() => {
    folderInputRef.current?.setAttribute('webkitdirectory', '')
  }, [])

  useEffect(() => {
    if (!isTauri() || workspaceRestoredRef.current || workspacePath || explorerTree || recentFolders.length === 0) return

    workspaceRestoredRef.current = true
    void (async () => {
      for (const path of recentFolders) {
        try {
          const tree = await callBackend<ExplorerNode>('read_folder_tree', { path })
          setWorkspacePath(path)
          setExplorerTree(tree)
          setExpandedPaths(new Set([tree.path]))
          return
        } catch {
          // A recent folder may have been moved or deleted; try the next one.
        }
      }
    })()
  }, [explorerTree, recentFolders, workspacePath])

  useEffect(() => {
    terminalCwdRef.current = terminalWorkingDirectory
  }, [terminalWorkingDirectory])

  useEffect(() => {
    if (!terminalOpen || !terminalElementRef.current) return

    let disposed = false
    let removeTerminalListener: (() => void) | undefined
    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: true,
      fontFamily: 'SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.25,
      theme: {
        background: '#0c0f12',
        foreground: '#d4d4d4',
        cursor: '#d4d4d4',
        selectionBackground: '#264f78',
        black: '#000000',
        red: '#f14c4c',
        green: '#23d18b',
        yellow: '#f5f543',
        blue: '#3b8eea',
        magenta: '#d670d6',
        cyan: '#29b8db',
        white: '#e5e5e5',
      },
    })
    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.open(terminalElementRef.current)
    fitAddon.fit()
    terminal.focus()
    xtermRef.current = terminal
    fitAddonRef.current = fitAddon
    pendingTerminalWritesRef.current.splice(0).forEach((value) => terminal.write(value))

    const dataDisposable = terminal.onData((data) => {
      if (isTauri()) {
        void callBackend<void>('terminal_write', { request: { data } }).catch((error) => {
          terminal.writeln(`\r\nterminal write failed: ${String(error)}`)
        })
      } else {
        terminal.write(data)
      }
    })

    const resizeTerminal = () => {
      if (disposed) return
      fitAddon.fit()
      if (!isTauri()) return
      void callBackend<void>('terminal_resize', {
        request: { cols: terminal.cols, rows: terminal.rows },
      }).catch(() => undefined)
    }

    const resizeObserver = new ResizeObserver(resizeTerminal)
    resizeObserver.observe(terminalElementRef.current)

    if (isTauri()) {
      void listen<TerminalOutputEvent>('terminal-output', (event) => {
        terminal.write(event.payload.data)
      }).then((unlisten) => {
        removeTerminalListener = unlisten
      })
      void callBackend<void>('terminal_start', {
        request: {
          cwd: terminalCwdRef.current,
          cols: terminal.cols,
          rows: terminal.rows,
        },
      }).then(() => {
        pendingTerminalInputsRef.current.splice(0).forEach((data) => {
          void callBackend<void>('terminal_write', { request: { data } }).catch((error) => {
            terminal.writeln(`\r\nterminal write failed: ${String(error)}`)
          })
        })
      }).catch((error) => {
        terminal.writeln(`terminal start failed: ${String(error)}`)
      })
    } else {
      terminal.writeln('Preview terminal is available in the Tauri app.')
    }

    return () => {
      disposed = true
      dataDisposable.dispose()
      resizeObserver.disconnect()
      removeTerminalListener?.()
      terminal.dispose()
      if (xtermRef.current === terminal) xtermRef.current = null
      if (fitAddonRef.current === fitAddon) fitAddonRef.current = null
    }
  }, [terminalOpen])

  useEffect(() => {
    webUrlRef.current = webUrl
  }, [webUrl])

  useEffect(() => {
    activeWebTabIdRef.current = activeWebTabId
  }, [activeWebTabId])

  useEffect(() => {
    if (!webTabMenu) return
    const closeMenu = () => setWebTabMenu(null)
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setWebTabMenu(null)
    }
    window.addEventListener('click', closeMenu)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      window.removeEventListener('click', closeMenu)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [webTabMenu])

  useEffect(() => {
    if (!explorerContextMenu) return
    const closeMenu = () => setExplorerContextMenu(null)
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setExplorerContextMenu(null)
    }
    window.addEventListener('click', closeMenu)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      window.removeEventListener('click', closeMenu)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [explorerContextMenu])

  useEffect(() => {
    webSideRef.current = webSide
  }, [webSide])

  useEffect(() => {
    sidebarWidthRef.current = sidebarWidth
    webWidthRef.current = webWidth
    if (sidebarWidth > 0) lastSidebarWidthRef.current = sidebarWidth
    if (webWidth > 0) lastWebWidthRef.current = webWidth
  }, [sidebarWidth, webWidth])

  const searchResults = useMemo(() => {
    if (!explorerTree || !searchQuery.trim()) return []
    const query = searchQuery.trim().toLowerCase()
    const results: ExplorerNode[] = []

    function visit(node: ExplorerNode) {
      if (node.name.toLowerCase().includes(query)) results.push(node)
      node.children.forEach(visit)
    }

    explorerTree.children.forEach(visit)
    return results.slice(0, 80)
  }, [explorerTree, searchQuery])

  const getWebviewRect = useCallback(() => {
    if (webWidth <= 0 || !activeWebVisible) return null
    const element = webFrameRef.current
    if (!element) return null
    const rect = element.getBoundingClientRect()
    const statusbarHeight = 24
    const bottomLimit = terminalOpen
      ? window.innerHeight - statusbarHeight - terminalHeight
      : window.innerHeight - statusbarHeight
    // Tauri child WebViews render above the React WebView slot on macOS by one editor tab row.
    // Keep the native web content below the VSCode-like tab strip.
    const childWebviewTopCorrection = 35
    const top = rect.top + childWebviewTopCorrection
    const bottom = Math.min(rect.bottom, bottomLimit)
    const height = Math.max(80, bottom - top)
    return {
      x: Math.round(rect.left),
      y: Math.round(top),
      width: Math.max(80, Math.round(rect.width)),
      height: Math.round(height),
    }
  }, [activeWebVisible, terminalHeight, terminalOpen, webWidth])

  useEffect(() => {
    callBackend<EnvironmentPlan>('get_environment_plan')
      .then(setEnvironmentPlan)
      .catch(() => setEnvironmentPlan(fallbackPlan))
  }, [])

  useEffect(() => {
    if (!isTauri()) return

    let unlisten: (() => void) | undefined
    void listen<WebviewUrlEvent>('contest-webview-url', (event) => {
      const { tabId, url: nextUrl } = event.payload
      if (!isAllowedContestUrl(nextUrl)) return
      const nextTarget = targetFromWebUrl(nextUrl)
      setWebTabs((current) =>
        current.map((tab) =>
          tab.id === tabId ? { ...tab, target: nextTarget, url: nextUrl, draftUrl: nextUrl } : tab,
        ),
      )
      webviewUrlsRef.current.set(tabId, nextUrl)
      if (tabId === activeWebTabIdRef.current && nextUrl !== webUrlRef.current) {
        skipNextWebNavigateRef.current = true
        webUrlRef.current = nextUrl
      }
      setWebError('')
    }).then((cleanup) => {
      unlisten = cleanup
    })

    return () => {
      unlisten?.()
    }
  }, [])

  useEffect(() => {
    if (!isTauri()) return

    let cancelled = false
    let cleanupResize: (() => void) | undefined

    async function mountWebview() {
      try {
        const rect = getWebviewRect()
        if (!rect || cancelled) return
        const knownWebviewUrl = webviewUrlsRef.current.get(activeWebTabId)
        const shouldNavigate = knownWebviewUrl !== webUrl

        const request: ContestWebviewRequest = {
          tabId: activeWebTabId,
          url: webUrl,
          navigate: shouldNavigate,
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        }
        if (skipNextWebNavigateRef.current) {
          skipNextWebNavigateRef.current = false
          await callBackend<void>('set_contest_webview_bounds', { request })
        } else {
          await callBackend<void>('open_contest_webview', { request })
        }
        webviewUrlsRef.current.set(activeWebTabId, webUrl)

        const updateBounds = () => {
          const nextRect = getWebviewRect()
          if (!nextRect) return
          const boundsRequest: ContestWebviewRequest = {
            ...nextRect,
            tabId: activeWebTabIdRef.current,
            url: webUrlRef.current,
            navigate: false,
          }
          void callBackend<void>('set_contest_webview_bounds', { request: boundsRequest }).catch(() => undefined)
        }

        const resizeObserver = new ResizeObserver(updateBounds)
        if (webFrameRef.current) resizeObserver.observe(webFrameRef.current)
        window.addEventListener('resize', updateBounds)
        cleanupResize = () => {
          resizeObserver.disconnect()
          window.removeEventListener('resize', updateBounds)
        }
      } catch (error) {
        setWebError(`WebView を開けませんでした: ${String(error)}`)
      }
    }

    void mountWebview()

    return () => {
      cancelled = true
      cleanupResize?.()
    }
  }, [activeWebTabId, getWebviewRect, webSide, webUrl])

  useEffect(() => {
    if (!isTauri() || webWidth > 0) return
    void callBackend<void>('hide_contest_webviews').catch(() => undefined)
  }, [webWidth])

  useEffect(() => {
    if (!isTauri() || activeWebVisible) return
    void callBackend<void>('hide_contest_webviews').catch(() => undefined)
  }, [activeWebVisible])

  useEffect(() => {
    if (!isTauri()) return
    return () => {
      void callBackend<void>('close_contest_webview', { tabId: null }).catch(() => undefined)
    }
  }, [])

  useEffect(() => {
    const dragThreshold = 4

    const findDropSide = (x: number, y: number): WebSide | null => {
      const element = document.elementFromPoint(x, y)
      const dropTarget = element?.closest<HTMLElement>('[data-open-editor-side]')
      const side = dropTarget?.dataset.openEditorSide
      return side === 'left' || side === 'right' ? side : null
    }

    const finishDrag = (x: number, y: number) => {
      const item = paneDragActiveRef.current
      if (!item) return
      const side = findDropSide(x, y)
      if (side) setPaneByDrop(item, side)
    }

    const clearDrag = () => {
      paneDragCandidateRef.current = null
      paneDragActiveRef.current = null
      setPaneDragItem(null)
      setPaneDragOverSide(null)
      document.body.classList.remove('is-dragging-pane')
    }

    const handlePointerMove = (event: PointerEvent) => {
      const candidate = paneDragCandidateRef.current
      if (!candidate) return

      const distance = Math.hypot(event.clientX - candidate.startX, event.clientY - candidate.startY)
      if (!paneDragActiveRef.current && distance >= dragThreshold) {
        paneDragActiveRef.current = candidate.item
        setSuppressPaneClick(true)
        setPaneDragItem(candidate.item)
        document.body.classList.add('is-dragging-pane')
      }

      if (paneDragActiveRef.current) {
        event.preventDefault()
        setPaneDragOverSide(findDropSide(event.clientX, event.clientY))
      }
    }

    const handlePointerUp = (event: PointerEvent) => {
      if (paneDragActiveRef.current) {
        event.preventDefault()
        finishDrag(event.clientX, event.clientY)
      }
      clearDrag()
    }

    const handlePointerCancel = () => clearDrag()

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    window.addEventListener('pointercancel', handlePointerCancel)
    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', handlePointerCancel)
      clearDrag()
    }
  }, [setPaneByDrop])

  useEffect(() => {
    const handleMove = (event: MouseEvent) => {
      if (!dragStart.current) return
      const nextHeight = dragStart.current.height - (event.clientY - dragStart.current.y)
      dragStart.current.lastHeight = nextHeight
      if (nextHeight <= 72) {
        setTerminalOpen(false)
        setTerminalHeight(220)
        dragStart.current = null
        return
      }
      setTerminalHeight(Math.min(420, Math.max(96, nextHeight)))
    }
    const handleUp = () => {
      if (dragStart.current?.lastHeight && dragStart.current.lastHeight < 110) {
        setTerminalOpen(false)
        setTerminalHeight(220)
      }
      dragStart.current = null
    }
    window.addEventListener('mousemove', handleMove)
    window.addEventListener('mouseup', handleUp)
    return () => {
      window.removeEventListener('mousemove', handleMove)
      window.removeEventListener('mouseup', handleUp)
    }
  }, [])

  useEffect(() => {
    const minHeight = 96
    const maxHeight = 520

    const handleMove = (event: MouseEvent) => {
      if (!explorerDiffDragStart.current) return
      const nextHeight = explorerDiffDragStart.current.height - (event.clientY - explorerDiffDragStart.current.y)
      setExplorerDiffHeight(clamp(nextHeight, minHeight, maxHeight))
    }

    const handleUp = () => {
      explorerDiffDragStart.current = null
      document.body.classList.remove('is-resizing-vertical')
    }

    window.addEventListener('mousemove', handleMove)
    window.addEventListener('mouseup', handleUp)
    return () => {
      window.removeEventListener('mousemove', handleMove)
      window.removeEventListener('mouseup', handleUp)
      document.body.classList.remove('is-resizing-vertical')
    }
  }, [])

  useEffect(() => {
    const minSidebar = 120
    const maxSidebar = 620
    const minEditor = 300
    const minWeb = 360
    const fixedWidth = 48 + 12
    const sidebarCloseThreshold = 56
    const webCloseThreshold = 120

    const maxSidebarForWindow = (web: number) =>
      Math.max(minSidebar, window.innerWidth - fixedWidth - minEditor - web)
    const maxWebForWindow = (sidebar: number) =>
      Math.max(minWeb, window.innerWidth - fixedWidth - minEditor - sidebar)
    const normalizeSidebarWidth = (value: number, max: number) =>
      value < sidebarCloseThreshold ? 0 : clamp(value, minSidebar, max)
    const normalizeWebWidth = (value: number, max: number) =>
      value < webCloseThreshold ? 0 : clamp(value, minWeb, max)

    const handleMove = (event: MouseEvent) => {
      const drag = layoutDragRef.current
      if (!drag) return
      const deltaX = event.clientX - drag.x

      if (drag.type === 'sidebar') {
        setSidebarWidth(
          normalizeSidebarWidth(
            drag.sidebarWidth + deltaX,
            Math.min(maxSidebar, maxSidebarForWindow(drag.webWidth)),
          ),
        )
        return
      }

      const nextWebWidth =
        webSideRef.current === 'left' ? drag.webWidth + deltaX : drag.webWidth - deltaX
      setWebWidth(normalizeWebWidth(nextWebWidth, maxWebForWindow(drag.sidebarWidth)))
    }

    const handleUp = () => {
      layoutDragRef.current = null
      document.body.classList.remove('is-resizing-layout')
    }

    const handleResize = () => {
      const nextSidebar = clamp(
        sidebarWidthRef.current,
        0,
        Math.min(maxSidebar, maxSidebarForWindow(webWidthRef.current)),
      )
      const nextWeb = clamp(webWidthRef.current, 0, maxWebForWindow(nextSidebar))
      setSidebarWidth(nextSidebar)
      setWebWidth(nextWeb)
    }

    window.addEventListener('mousemove', handleMove)
    window.addEventListener('mouseup', handleUp)
    window.addEventListener('resize', handleResize)
    return () => {
      window.removeEventListener('mousemove', handleMove)
      window.removeEventListener('mouseup', handleUp)
      window.removeEventListener('resize', handleResize)
      document.body.classList.remove('is-resizing-layout')
    }
  }, [])

  async function createSolution() {
    setBusyLabel('creating')
    try {
      const targetWorkspacePath = workspacePath || defaultWorkspacePath()
      const task = taskFromAtcoderUrl(webUrl)
      const targetContest = task?.contest ?? contest
      const targetProblem = task?.problem ?? problem
      const result = await callBackend<SolutionFile>('create_solution_file', {
        request: { contest: targetContest, problem: targetProblem, language, workspace_path: targetWorkspacePath },
      })
      const generatedRoot = workspaceRootFromGeneratedPath(result.path, targetContest)
      openFileTab({ path: result.path, content: result.content, language: result.language, group: codeSide })
      if (generatedRoot) {
        await loadWorkspaceFolder(generatedRoot)
        setExpandedPaths((current) => {
          const next = new Set(current)
          next.add(`${generatedRoot}/${targetContest.toLowerCase()}`)
          return next
        })
      }
      appendTerminal(`created ${result.path}`)
    } catch (error) {
      appendTerminal(`create failed: ${String(error)}`)
      setTerminalOpen(true)
    } finally {
      setBusyLabel('')
    }
  }

  async function createWorkspaceFile() {
    if (!workspacePath) {
      await chooseWorkspaceFolder()
      return
    }

    const input = window.prompt('作成するファイル名', currentGeneratedName)
    const fileName = input?.trim()
    if (!fileName) return

    const nextPath = joinPath(workspacePath, fileName)
    const nextLanguage = languageFromPath(nextPath)
    setBusyLabel('creating')
    try {
      await callBackend<void>('save_file', {
        request: { path: nextPath, content: templateFor(nextLanguage) },
      })
      await loadWorkspaceFolder(workspacePath)
      await openExplorerFile(nextPath)
    } catch (error) {
      appendTerminal(`create file failed: ${String(error)}`)
    } finally {
      setBusyLabel('')
    }
  }

  async function createWorkspaceFolder() {
    if (!workspacePath) {
      await chooseWorkspaceFolder()
      return
    }

    const input = window.prompt('作成するフォルダ名', 'new_folder')
    const folderName = input?.trim()
    if (!folderName) return

    setBusyLabel('creating')
    try {
      await callBackend<void>('create_folder', {
        path: `${workspacePath.replace(/\/+$/, '')}/${folderName}`,
      })
      await loadWorkspaceFolder(workspacePath)
    } catch (error) {
      appendTerminal(`create folder failed: ${String(error)}`)
    } finally {
      setBusyLabel('')
    }
  }

  async function refreshWorkspaceFolder() {
    if (!workspacePath) {
      await chooseWorkspaceFolder()
      return
    }
    await loadWorkspaceFolder(workspacePath)
  }

  async function chooseWorkspaceFolder() {
    if (!isTauri()) {
      folderInputRef.current?.click()
      return
    }

    setBusyLabel('opening')
    try {
      const selected = await openFileDialog({
        directory: true,
        multiple: false,
        title: 'Open Folder',
      })
      const path = Array.isArray(selected) ? selected[0] : selected
      if (!path) return
      await loadWorkspaceFolder(path)
    } catch (error) {
      appendTerminal(`open folder failed: ${String(error)}`)
    } finally {
      setBusyLabel('')
    }
  }

  async function loadWorkspaceFolder(path: string) {
    const tree = await callBackend<ExplorerNode>('read_folder_tree', { path })
    setWorkspacePath(path)
    setExplorerTree(tree)
    setExpandedPaths(new Set([tree.path]))
    rememberWorkspaceFolder(path)
    appendTerminal(`opened folder ${path}`)
  }

  function rememberWorkspaceFolder(path: string) {
    setRecentFolders((current) => {
      const next = [path, ...current.filter((item) => item !== path)].slice(0, 6)
      localStorage.setItem(recentFoldersKey, JSON.stringify(next))
      return next
    })
  }

  function activateFileTab(tab: OpenFileTab) {
    setFilePath(tab.path)
    setCode(tab.content)
    setLanguage(tab.language)
    setCompilerIssues([])
    setActivePaneItems((current) => ({ ...current, [tab.group]: codePaneKey(tab.path) }))
  }

  function openFileTab(tab: OpenFileTab) {
    const nextTab = { ...tab, group: openFileTabs.find((item) => item.path === tab.path)?.group ?? tab.group }
    setOpenFileTabs((current) => {
      const existing = current.find((item) => item.path === tab.path)
      const nextTab = { ...tab, group: existing?.group ?? tab.group }
      const next = current.filter((item) => item.path !== tab.path)
      return [...next, nextTab]
    })
    activateFileTab(nextTab)
  }

  function switchFileTab(path: string) {
    const tab = openFileTabs.find((item) => item.path === path)
    if (tab) activateFileTab(tab)
  }

  async function openExplorerFile(path: string) {
    const browserFile = browserFolderFilesRef.current.get(path)
    if (browserFile) {
      const content = await browserFile.text()
      const nextLanguage = languageFromPath(browserFile.name)
      openFileTab({ path, content, language: nextLanguage, group: codeSide })
      appendTerminal(`opened ${path}`)
      return
    }

    setBusyLabel('opening')
    try {
      const result = await callBackend<SolutionFile>('read_source_file', { path })
      openFileTab({ path: result.path, content: result.content, language: result.language, group: codeSide })
      appendTerminal(`opened ${result.path}`)
    } catch (error) {
      appendTerminal(`open failed: ${String(error)}`)
    } finally {
      setBusyLabel('')
    }
  }

  async function handleBrowserFolderSelect(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.currentTarget.files ?? [])
    event.currentTarget.value = ''
    if (files.length === 0) return

    const { root, fileMap } = buildBrowserFolderTree(files)
    browserFolderFilesRef.current = fileMap
    setWorkspacePath(root.path)
    setExplorerTree(root)
    setExpandedPaths(new Set([root.path]))
    rememberWorkspaceFolder(root.path)
    appendTerminal(`opened folder ${root.name}`)
  }

  function toggleExplorerFolder(path: string) {
    setExpandedPaths((current) => {
      const next = new Set(current)
      if (next.has(path)) {
        next.delete(path)
      } else {
        next.add(path)
      }
      return next
    })
  }

  function openExplorerItem(path: string, isDir: boolean) {
    if (isDir) {
      toggleExplorerFolder(path)
      return
    }
    void openExplorerFile(path)
  }

  function showExplorerContextMenu(event: ReactMouseEvent, target: ExplorerContextTarget) {
    event.preventDefault()
    event.stopPropagation()
    setWebTabMenu(null)
    setExplorerContextMenu({ x: event.clientX, y: event.clientY, target })
  }

  async function readSourceForPath(path: string): Promise<SolutionFile> {
    if (path === filePath) {
      return { path: filePath, content: code, language }
    }

    const tab = openFileTabs.find((item) => item.path === path)
    if (tab) {
      return { path: tab.path, content: tab.content, language: tab.language }
    }

    const browserFile = browserFolderFilesRef.current.get(path)
    if (browserFile) {
      return {
        path,
        content: await browserFile.text(),
        language: languageFromPath(browserFile.name),
      }
    }

    return callBackend<SolutionFile>('read_source_file', { path })
  }

  async function buildPath(path: string) {
    setTerminalOpen(true)
    setTerminalCwdOverride(parentDirectory(path))
    setBusyLabel('building')
    try {
      const source = await readSourceForPath(path)
      openFileTab({ path: source.path, content: source.content, language: source.language, group: codeSide })
      const result = await callBackend<BuildResult>('build_solution', {
        request: { path: source.path, content: source.content, language: source.language },
      })
      rememberDiff(result, 'compile')
      setCompilerIssues(collectCompilerIssues(`${result.stderr}
${result.stdout}`))
      appendTerminal(`saved ${result.file_path}`)
      appendTerminal(`$ ${result.command}`)
      appendTerminal(commandOutput(result))
    } catch (error) {
      appendTerminal(`build failed: ${String(error)}`)
    } finally {
      setBusyLabel('')
    }
  }

  async function runPath(path: string) {
    setTerminalOpen(true)
    setTerminalCwdOverride(parentDirectory(path))
    setBusyLabel('running')
    try {
      const source = await readSourceForPath(path)
      openFileTab({ path: source.path, content: source.content, language: source.language, group: codeSide })
      const result = await callBackend<BuildResult>('build_solution', {
        request: { path: source.path, content: source.content, language: source.language },
      })
      rememberDiff(result, 'run')
      setCompilerIssues(collectCompilerIssues(`${result.stderr}
${result.stdout}`))
      appendTerminal(`saved ${result.file_path}`)
      appendTerminal(`$ ${result.command}`)
      appendTerminal(commandOutput(result))
      if (result.status !== 0) return
      await writeTerminalInput(runCommandForBuild(result, source.path, source.language))
    } catch (error) {
      appendTerminal(`run failed: ${String(error)}`)
    } finally {
      setBusyLabel('')
    }
  }

  async function deleteContextTarget(target: ExplorerContextTarget) {
    const label = target.isDir ? 'フォルダ' : 'ファイル'
    if (!window.confirm(`${label}を削除しますか？\n${target.path}`)) return
    try {
      await callBackend<void>('delete_path', { path: target.path })
      const nextTabs = openFileTabs.filter(
        (tab) => tab.path !== target.path && !(target.isDir && tab.path.startsWith(`${target.path}/`)),
      )
      setOpenFileTabs(nextTabs)
      if (filePath === target.path || (target.isDir && filePath.startsWith(`${target.path}/`))) {
        const fallback = nextTabs[0]
        if (fallback) {
          activateFileTab(fallback)
        } else {
          setFilePath('')
          setCode('')
          setCompilerIssues([])
          setDiffOpen(false)
        }
      }
      setDiffHistory((current) => current.filter((entry) => entry.filePath !== target.path))
      if (workspacePath) await loadWorkspaceFolder(workspacePath)
      appendTerminal(`deleted ${target.path}`)
    } catch (error) {
      appendTerminal(`delete failed: ${String(error)}`)
      setTerminalOpen(true)
    }
  }

  async function renameContextTarget(target: ExplorerContextTarget) {
    const nextName = window.prompt('新しい名前', target.name)?.trim()
    if (!nextName || nextName === target.name) return
    if (nextName.includes('/') || nextName.includes('\\')) {
      appendTerminal('rename failed: name must not include path separators')
      setTerminalOpen(true)
      return
    }

    const nextPath = joinPath(parentDirectory(target.path), nextName)
    try {
      await callBackend<void>('rename_path', { path: target.path, newPath: nextPath })
      const renamedOpenFile =
        filePath === target.path
          ? nextPath
          : target.isDir && filePath.startsWith(`${target.path}/`)
            ? `${nextPath}${filePath.slice(target.path.length)}`
            : ''
      setOpenFileTabs((current) =>
        current.map((tab) =>
          tab.path === target.path
            ? { ...tab, path: nextPath }
            : target.isDir && tab.path.startsWith(`${target.path}/`)
              ? { ...tab, path: `${nextPath}${tab.path.slice(target.path.length)}` }
              : tab,
        ),
      )
      setDiffHistory((current) =>
        current.map((entry) =>
          entry.filePath === target.path
            ? { ...entry, filePath: nextPath, fileName: basename(nextPath) }
            : target.isDir && entry.filePath.startsWith(`${target.path}/`)
              ? {
                  ...entry,
                  filePath: `${nextPath}${entry.filePath.slice(target.path.length)}`,
                  fileName: basename(entry.filePath),
                }
              : entry,
        ),
      )
      if (workspacePath) await loadWorkspaceFolder(workspacePath)
      if (renamedOpenFile) await openExplorerFile(renamedOpenFile)
      appendTerminal(`renamed ${target.path} -> ${nextPath}`)
    } catch (error) {
      appendTerminal(`rename failed: ${String(error)}`)
      setTerminalOpen(true)
    }
  }

  function openTerminalAtTarget(target: ExplorerContextTarget) {
    const cwd = target.isDir ? target.path : parentDirectory(target.path)
    setTerminalCwdOverride(cwd)
    setTerminalOpen(true)
    if (xtermRef.current) {
      void callBackend<void>('terminal_write', {
        request: { data: changeDirectoryCommand(cwd) },
      }).catch((error) => appendTerminal(`terminal cd failed: ${String(error)}`))
    }
  }

  async function createSiblingLanguageFile(target: ExplorerContextTarget, nextLanguage: Language) {
    if (target.isDir) return
    const dotIndex = target.name.lastIndexOf('.')
    const stem = dotIndex > 0 ? target.name.slice(0, dotIndex) : target.name
    const nextPath = joinPath(parentDirectory(target.path), `${stem}.${languageExtensions[nextLanguage]}`)
    if (nextPath === target.path) {
      await openExplorerFile(target.path)
      return
    }

    const exists = await readSourceForPath(nextPath).then(
      () => true,
      () => false,
    )
    if (exists && !window.confirm(`${basename(nextPath)} は既にあります。上書きしますか？`)) return

    try {
      await callBackend<void>('save_file', {
        request: { path: nextPath, content: templateFor(nextLanguage) },
      })
      if (workspacePath) await loadWorkspaceFolder(workspacePath)
      await openExplorerFile(nextPath)
      appendTerminal(`created ${nextPath}`)
    } catch (error) {
      appendTerminal(`create file failed: ${String(error)}`)
      setTerminalOpen(true)
    }
  }

  async function handleContextAction(action: string, target: ExplorerContextTarget) {
    setExplorerContextMenu(null)
    if (action === 'delete') {
      await deleteContextTarget(target)
    } else if (action === 'rename') {
      await renameContextTarget(target)
    } else if (action === 'reveal') {
      await callBackend<void>('reveal_path', { path: target.path }).catch((error) => {
        appendTerminal(`reveal failed: ${String(error)}`)
        setTerminalOpen(true)
      })
    } else if (action === 'copy-path') {
      void navigator.clipboard?.writeText(target.path)
      appendTerminal(`copied path ${target.path}`)
    } else if (action === 'terminal') {
      openTerminalAtTarget(target)
    } else if (action === 'compile' && !target.isDir) {
      await buildPath(target.path)
    } else if (action === 'run' && !target.isDir) {
      await runPath(target.path)
    } else if (action === 'diff' && !target.isDir) {
      await openExplorerFile(target.path)
      setDiffOpen(true)
      showSidePanel('explorer')
    } else if (action.startsWith('lang:') && !target.isDir) {
      await createSiblingLanguageFile(target, action.slice(5) as Language)
    }
  }

  function renderExplorerNode(node: ExplorerNode, depth: number): ReactNode {
    if (node.isDir) {
      const expanded = expandedPaths.has(node.path)
      return (
        <div key={node.path}>
          <button
            className="explorer-row folder-row"
            style={{ '--depth': depth } as CSSProperties}
            type="button"
            onClick={() => toggleExplorerFolder(node.path)}
            onContextMenu={(event) =>
              showExplorerContextMenu(event, {
                kind: 'folder',
                path: node.path,
                name: node.name,
                isDir: true,
              })
            }
          >
            <ChevronDown className={expanded ? '' : 'collapsed'} size={15} />
            <Folder size={15} />
            <span>{node.name}</span>
          </button>
          {expanded && node.children.map((child) => renderExplorerNode(child, depth + 1))}
        </div>
      )
    }

    return (
      <button
        key={node.path}
        className={`explorer-row file-row ${node.path === filePath ? 'active' : ''}`}
        style={{ '--depth': depth } as CSSProperties}
        type="button"
        onClick={() => void openExplorerFile(node.path)}
        onContextMenu={(event) =>
          showExplorerContextMenu(event, {
            kind: 'file',
            path: node.path,
            name: node.name,
            isDir: false,
          })
        }
      >
        <FileCode2 size={15} />
        <span>{node.name}</span>
      </button>
    )
  }

  async function saveCurrentFile() {
    if (!filePath) return
    await callBackend<void>('save_file', { request: { path: filePath, content: code } })
    appendTerminal(`saved ${filePath}`)
  }

  async function buildSolution() {
    if (!filePath) {
      await createSolution()
      return
    }
    setTerminalOpen(true)
    setBusyLabel('building')
    try {
      const result = await callBackend<BuildResult>('build_solution', {
        request: { path: filePath, content: code, language },
      })
      rememberDiff(result, 'compile')
      setCompilerIssues(collectCompilerIssues(`${result.stderr}
${result.stdout}`))
      appendTerminal(`saved ${result.file_path}`)
      appendTerminal(`$ ${result.command}`)
      appendTerminal(commandOutput(result))
    } catch (error) {
      appendTerminal(`build failed: ${String(error)}`)
    } finally {
      setBusyLabel('')
    }
  }

  async function runSolution() {
    if (!filePath) {
      await createSolution()
      return
    }
    setTerminalOpen(true)
    setBusyLabel('running')
    try {
      const result = await callBackend<BuildResult>('build_solution', {
        request: { path: filePath, content: code, language },
      })
      rememberDiff(result, 'run')
      setCompilerIssues(collectCompilerIssues(`${result.stderr}
${result.stdout}`))
      appendTerminal(`saved ${result.file_path}`)
      appendTerminal(`$ ${result.command}`)
      appendTerminal(commandOutput(result))
      if (result.status !== 0) return
      await writeTerminalInput(runCommandForBuild(result, filePath, language))
    } catch (error) {
      appendTerminal(`run failed: ${String(error)}`)
    } finally {
      setBusyLabel('')
    }
  }

  async function writeTerminalInput(data: string) {
    setTerminalOpen(true)
    if (!isTauri()) {
      xtermRef.current?.write(data)
      return
    }
    if (!xtermRef.current) {
      pendingTerminalInputsRef.current.push(data)
      return
    }
    await callBackend<void>('terminal_write', { request: { data } })
  }

  function appendTerminal(value: string) {
    const output = `\r\n${value.replace(/\n/g, '\r\n')}\r\n`
    const terminal = xtermRef.current
    if (!terminal) {
      pendingTerminalWritesRef.current.push(output)
      return
    }
    terminal.write(output)
  }

  function runCommandForBuild(result: BuildResult, sourcePath: string, sourceLanguage: Language) {
    const commandPrefix = changeDirectoryCommand(result.cwd).trimEnd()
    if (sourceLanguage === 'python') {
      const pythonCommand = isWindowsHost()
        ? `py -3 ${shellQuote(basename(sourcePath))}`
        : `python3 ${shellQuote(basename(sourcePath))}`
      return `${commandPrefix}${commandJoiner()}${pythonCommand}\r`
    }
    const executableName = result.executable_path ? basename(result.executable_path) : basename(sourcePath)
    const executableCommand = isWindowsHost()
      ? `& ${shellQuote(`.\\.accode\\bin\\${executableName}`)}`
      : shellQuote(`./.accode/bin/${executableName}`)
    return `${commandPrefix}${commandJoiner()}${executableCommand}\r`
  }

  function commandOutput(result: Pick<CommandResult, 'stdout' | 'stderr' | 'status'>) {
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
    if (output) return result.status === 0 ? output : `${output}\nexit ${result.status}`
    return `exit ${result.status}`
  }

  function rememberDiff(result: BuildResult, source: DiffEntry['source']) {
    diffCounterRef.current += 1
    const id = `diff-${diffCounterRef.current}`
    const entry: DiffEntry = {
      id,
      source,
      filePath: result.file_path,
      fileName: basename(result.file_path),
      cwd: result.cwd,
      command: result.command,
      status: result.status,
      diff: result.diff || 'No diff data.',
      createdAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    }
    setDiffHistory((current) => [entry, ...current].slice(0, 50))
    setActiveDiffId(id)
    setDiffOpen(true)
  }

  function copyCommand(value: string) {
    void navigator.clipboard?.writeText(value)
  }

  function setupCommandsForLanguage() {
    const commands = environmentPlan?.commands ?? []
    if (language === 'python') {
      return commands.filter((item) => item.label.toLowerCase().includes('python'))
    }
    if (language === 'rust') {
      return commands.filter((item) => item.label.toLowerCase().includes('rust'))
    }
    return commands.filter((item) => {
      const label = item.label.toLowerCase()
      return label.includes('c++') || label.includes('xcode')
    })
  }

  async function runLanguageSetup() {
    const commands = setupCommandsForLanguage()
    if (commands.length === 0) {
      appendTerminal(`setup command not found for ${language}`)
      setTerminalOpen(true)
      return
    }
    const preview = commands.flatMap(setupCommandsForStep).join('\n')
    if (!window.confirm(`選択中の言語環境をセットアップします。\n\n実行されるコマンド:\n${preview}`)) return
    setTerminalOpen(true)
    appendTerminal(`setup ${language} environment`)
    for (const item of commands) {
      for (const command of setupCommandsForStep(item)) {
        appendTerminal(`$ ${command}`)
        await writeTerminalInput(`${command}\r`)
      }
    }
  }

  function setupCommandsForStep(item: EnvironmentPlan['commands'][number]) {
    const check = item.check?.trim()
    const install = item.install?.trim() || item.command
    const verify = item.verify?.trim()
    const setup = check
      ? isWindowsHost()
        ? `if (-not (${check})) { ${install} }`
        : `(${check}) >/dev/null 2>&1 || ${install}`
      : install
    return [setup, verify].filter((command): command is string => Boolean(command?.trim())).map(setupCommandForShell)
  }

  function setupCommandForShell(command: string) {
    if (!isWindowsHost()) return command
    return command.replace(/\s+&&\s+/g, '; ')
  }

  async function terminateTerminal() {
    if (!window.confirm('実行中のターミナルプロセスを終了しますか？')) return
    await callBackend<void>('terminal_stop').catch((error) => appendTerminal(`terminal stop failed: ${String(error)}`))
    xtermRef.current?.clear()
    setTerminalOpen(false)
  }

  function updateActiveWebTab(patch: Partial<WebTab>) {
    setWebTabs((current) =>
      current.map((tab) => (tab.id === activeWebTabId ? { ...tab, ...patch } : tab)),
    )
  }

  function activateWebTab(id: string) {
    const tab = webTabs.find((item) => item.id === id)
    setActiveWebTabId(id)
    if (tab) webUrlRef.current = tab.url
    setActivePaneItems((current) => ({ ...current, [webSide]: webPaneKey(id) }))
    if (webWidth <= 0) setWebWidth(lastWebWidthRef.current || initialWebPaneWidth())
  }

  function openNewWebTab(tab: Omit<WebTab, 'id'>) {
    const id = `web-${webTabCounterRef.current}`
    webTabCounterRef.current += 1
    const nextTab: WebTab = { id, ...tab }
    setWebTabs((current) => [...current, nextTab])
    setActiveWebTabId(id)
    setActivePaneItems((current) => ({ ...current, [webSide]: webPaneKey(id) }))
    webUrlRef.current = nextTab.url
    if (webWidth <= 0) setWebWidth(lastWebWidthRef.current || initialWebPaneWidth())
  }

  function addWebTab() {
    openNewWebTab({
      target: webTarget,
      url: webTargets[webTarget].url,
      draftUrl: webTargets[webTarget].url,
    })
  }

  function addWebTabForTarget(target: WebTarget) {
    openNewWebTab({
      target,
      url: webTargets[target].url,
      draftUrl: webTargets[target].url,
    })
    setWebTabMenu(null)
  }

  function duplicateLeftWebTab() {
    const source = webTabs.at(-1) ?? activeWebTab
    openNewWebTab({
      target: source.target,
      url: source.url,
      draftUrl: source.draftUrl,
    })
    setWebTabMenu(null)
  }

  function closeWebTab(id: string) {
    if (isTauri()) {
      void callBackend<void>('close_contest_webview', { tabId: id }).catch(() => undefined)
      webviewUrlsRef.current.delete(id)
    }
    setWebTabs((current) => {
      if (current.length <= 1) {
        toggleWebPane()
        return current
      }
      const index = current.findIndex((tab) => tab.id === id)
      const next = current.filter((tab) => tab.id !== id)
      if (id === activeWebTabId) {
        const fallback = next[Math.max(0, index - 1)] ?? next[0]
        setActiveWebTabId(fallback.id)
        setActivePaneItems((current) => ({ ...current, [webSide]: webPaneKey(fallback.id) }))
        webUrlRef.current = fallback.url
      }
      return next
    })
  }

  async function openWebUrl(nextUrl = webDraftUrl) {
    const normalized = normalizeWebUrl(nextUrl)
    const allowed = await callBackend<boolean>('is_allowed_atcoder_url', { url: normalized })
    if (!allowed) {
      setWebError('AtCoder または AtCoder Problems の URL だけ開けます。')
      return
    }
    setWebError('')
    const nextTarget = targetFromWebUrl(normalized)
    updateActiveWebTab({ url: normalized, draftUrl: normalized, target: nextTarget })
    webUrlRef.current = normalized
    webviewUrlsRef.current.delete(activeWebTabId)
  }

  function refreshWebPane() {
    if (!isTauri()) {
      void openWebUrl(webUrl)
      return
    }
    const rect = getWebviewRect()
    if (!rect) return
    const request: ContestWebviewRequest = {
      ...rect,
      tabId: activeWebTabId,
      url: webUrl,
      navigate: true,
    }
    webviewUrlsRef.current.delete(activeWebTabId)
    void callBackend<void>('open_contest_webview', { request })
      .then(() => {
        webviewUrlsRef.current.set(activeWebTabId, webUrl)
      })
      .catch((error) => appendTerminal(`refresh failed: ${String(error)}`))
  }

  async function navigateWebHistory(direction: 'back' | 'forward') {
    if (webWidth <= 0) setWebWidth(lastWebWidthRef.current || initialWebPaneWidth())
    try {
      await callBackend<void>(direction === 'back' ? 'contest_webview_back' : 'contest_webview_forward', {
        tabId: activeWebTabId,
      })
    } catch (error) {
      appendTerminal(`web ${direction} failed: ${String(error)}`)
    }
  }

  function switchWebTarget(nextTarget: WebTarget) {
    updateActiveWebTab({
      target: nextTarget,
      draftUrl: webTargets[nextTarget].url,
      url: webTargets[nextTarget].url,
    })
    webUrlRef.current = webTargets[nextTarget].url
    void openWebUrl(webTargets[nextTarget].url)
    if (webWidth <= 0) setWebWidth(lastWebWidthRef.current || initialWebPaneWidth())
  }

  function startLayoutResize(type: 'sidebar' | 'web', event: ReactMouseEvent<HTMLDivElement>) {
    event.preventDefault()
    layoutDragRef.current = {
      type,
      x: event.clientX,
      sidebarWidth,
      webWidth,
    }
    document.body.classList.add('is-resizing-layout')
  }

  function startExplorerDiffResize(event: ReactMouseEvent<HTMLDivElement>) {
    event.preventDefault()
    explorerDiffDragStart.current = {
      y: event.clientY,
      height: explorerDiffHeight,
    }
    if (!diffOpen) setDiffOpen(true)
    document.body.classList.add('is-resizing-vertical')
  }

  function toggleSidebar() {
    setSidebarWidth((current) => {
      if (current <= 0) return lastSidebarWidthRef.current || 248
      lastSidebarWidthRef.current = current
      return 0
    })
  }

  function toggleExplorerPanel() {
    if (sidePanelMode !== 'explorer') {
      showSidePanel('explorer')
      return
    }
    toggleSidebar()
  }

  function toggleSearchPanel() {
    if (sidePanelMode !== 'search') {
      showSidePanel('search')
      return
    }
    toggleSidebar()
  }

  function showSidePanel(mode: SidePanelMode) {
    setSidePanelMode(mode)
    if (sidebarWidth <= 0) setSidebarWidth(lastSidebarWidthRef.current || 248)
  }

  function closeFileTab(path = filePath) {
    const index = openFileTabs.findIndex((tab) => tab.path === path)
    const next = openFileTabs.filter((tab) => tab.path !== path)
    setOpenFileTabs(next)
    if (path === filePath) {
      const fallback = next[Math.max(0, index - 1)] ?? next[0]
      if (fallback) {
        activateFileTab(fallback)
      } else {
        setFilePath('')
        setCode('')
        setCompilerIssues([])
        setDiffOpen(false)
      }
    }
  }

  function handleOpenEditorPointerDown(event: ReactPointerEvent, item: PaneDragItem) {
    if (event.button !== 0) return
    const target = event.target as HTMLElement
    if (target.closest('[data-no-pane-drag]')) return
    paneDragCandidateRef.current = {
      item,
      startX: event.clientX,
      startY: event.clientY,
      pointerId: event.pointerId,
    }
  }

  function consumeSuppressedPaneClick() {
    if (!suppressPaneClick) return false
    setSuppressPaneClick(false)
    return true
  }

  function handleOpenEditorDragStart(event: ReactDragEvent, item: PaneDragItem) {
    const payload = JSON.stringify(item)
    event.dataTransfer.setData('application/accode-editor-pane', payload)
    event.dataTransfer.setData('text/plain', payload)
    event.dataTransfer.effectAllowed = 'move'
    setPaneDragItem(item)
    document.body.classList.add('is-dragging-pane')
  }

  function handleOpenEditorDrop(event: ReactDragEvent, side: WebSide) {
    event.preventDefault()
    const raw = event.dataTransfer.getData('application/accode-editor-pane') || event.dataTransfer.getData('text/plain')
    try {
      const item = JSON.parse(raw) as PaneDragItem
      if (item.kind === 'web' || item.kind === 'code') setPaneByDrop(item, side)
    } catch {
      // Ignore external drops.
    }
    setPaneDragItem(null)
    setPaneDragOverSide(null)
    document.body.classList.remove('is-dragging-pane')
  }

  function handleOpenEditorDragEnd() {
    setPaneDragItem(null)
    setPaneDragOverSide(null)
    document.body.classList.remove('is-dragging-pane')
  }

  function allowOpenEditorDrop(event: ReactDragEvent) {
    if (event.dataTransfer.types.includes('application/accode-editor-pane') || event.dataTransfer.types.includes('text/plain')) {
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
    }
  }

  function renderOpenFileEntry(side: WebSide) {
    const tabs = openFileTabs.filter((tab) => tab.group === side)
    if (tabs.length > 0) {
      return (
        <>
          {tabs.map((tab) => {
            const tabName = basename(tab.path)
            const tabPathText = workspacePath && tab.path.startsWith(workspacePath)
              ? tab.path.slice(workspacePath.length).replace(/^\/+/, '')
              : tab.path.split('/').slice(-3).join('/')
            return (
              <button
                key={tab.path}
                className={`open-editor-row ${tab.path === filePath ? 'active' : ''}`}
                type="button"
                draggable
                onPointerDown={(event) => handleOpenEditorPointerDown(event, { kind: 'code', path: tab.path })}
                onDragStart={(event) => handleOpenEditorDragStart(event, { kind: 'code', path: tab.path })}
                onDragEnd={handleOpenEditorDragEnd}
                onClick={() => {
                  if (consumeSuppressedPaneClick()) return
                  switchFileTab(tab.path)
                }}
                onContextMenu={(event) =>
                  showExplorerContextMenu(event, {
                    kind: 'open-file',
                    path: tab.path,
                    name: tabName,
                    isDir: false,
                  })
                }
                title={basename(tab.path)}
              >
                <X
                  data-no-pane-drag
                  size={15}
                  onClick={(event) => {
                    event.stopPropagation()
                    closeFileTab(tab.path)
                  }}
                />
                <FileCode2 size={15} />
                <span className="open-editor-name">{tabName}</span>
                {tabPathText && <span className="open-editor-path">{tabPathText}</span>}
              </button>
            )
          })}
        </>
      )
    }

    if (openFileTabs.length > 0) return null

    if (workspacePath) {
      return (
        <button className="open-editor-row muted" type="button" onClick={chooseWorkspaceFolder} title={workspacePath}>
          <FolderOpen size={15} />
          <span className="open-editor-name">ファイル未選択</span>
          <span className="open-editor-path">{explorerRootName}</span>
        </button>
      )
    }

    return (
      <button className="open-editor-row muted" type="button" onClick={chooseWorkspaceFolder}>
        <FolderOpen size={15} />
        <span className="open-editor-name">フォルダ未選択</span>
      </button>
    )
  }

  function renderOpenWebEntry() {
    if (webHidden) {
      return (
        <button
          className="open-editor-row muted"
          type="button"
          draggable
          onPointerDown={(event) => handleOpenEditorPointerDown(event, { kind: 'web' })}
          onDragStart={(event) => handleOpenEditorDragStart(event, { kind: 'web' })}
          onDragEnd={handleOpenEditorDragEnd}
          onClick={() => {
            if (consumeSuppressedPaneClick()) return
            toggleWebPane()
          }}
          title="Webを表示"
        >
          <Globe2 size={15} />
          <span className="open-editor-name">{webTargets[webTarget].label}</span>
          <span className="open-editor-path">hide</span>
        </button>
      )
    }

    return (
      <button
        className="open-editor-row active"
        type="button"
        draggable
        onPointerDown={(event) => handleOpenEditorPointerDown(event, { kind: 'web' })}
        onDragStart={(event) => handleOpenEditorDragStart(event, { kind: 'web' })}
        onDragEnd={handleOpenEditorDragEnd}
        onClick={() => {
          if (consumeSuppressedPaneClick()) return
          toggleWebPane()
        }}
        title="Webを隠す"
      >
        <X size={15} />
        <Globe2 size={15} />
        <span className="open-editor-name">{webTargets[webTarget].label}</span>
        <span className="open-editor-path">{currentTaskLabel}</span>
      </button>
    )
  }

  function toggleWebPane() {
    setWebWidth((current) => {
      if (current <= 0) return lastWebWidthRef.current || initialWebPaneWidth()
      lastWebWidthRef.current = current
      return 0
    })
  }

  function handleCodeChange(value: string | undefined) {
    const nextCode = value ?? ''
    setCode(nextCode)
    if (filePath) {
      setOpenFileTabs((current) =>
        current.map((tab) => (tab.path === filePath ? { ...tab, content: nextCode, language } : tab)),
      )
    }
    setCompilerIssues([])
  }

  function handlePaneCodeChange(path: string, value: string | undefined) {
    if (path === filePath) {
      handleCodeChange(value)
      return
    }
    const nextCode = value ?? ''
    setOpenFileTabs((current) =>
      current.map((tab) => (tab.path === path ? { ...tab, content: nextCode } : tab)),
    )
  }

  function handleLanguageChange(nextLanguage: Language) {
    setLanguage(nextLanguage)
    if (filePath) {
      setOpenFileTabs((current) =>
        current.map((tab) => (tab.path === filePath ? { ...tab, language: nextLanguage } : tab)),
      )
    }
  }

  function renderDiffLine(line: string, index: number) {
    const className = line.startsWith('+')
      ? 'added'
      : line.startsWith('-')
        ? 'removed'
        : line.startsWith('Initial') || line.startsWith('No changes')
          ? 'muted'
          : ''
    return (
      <div className={`diff-line ${className}`} key={`${index}-${line}`}>
        {line || ' '}
      </div>
    )
  }

  function renderEmptyEditor() {
    return (
      <div className="empty-editor">
        <p>{workspacePath ? 'ファイルを選択するか、問題ファイルを生成してください。' : '作業フォルダを開いてください。'}</p>
        <div className="empty-editor-actions">
          <button type="button" onClick={chooseWorkspaceFolder}>
            <FolderOpen size={16} />
            {workspacePath ? 'フォルダを変更' : 'フォルダを開く'}
          </button>
          <button type="button" onClick={createSolution}>
            <FilePlus2 size={16} />
            {currentGeneratedName} を生成
          </button>
        </div>
        {recentFolders.length > 0 && (
          <div className="empty-editor-recents">
            {recentFolders.slice(0, 3).map((path) => (
              <button key={path} type="button" onClick={() => void loadWorkspaceFolder(path)}>
                {path}
              </button>
            ))}
          </div>
        )}
        <p>コンパイル: Cmd/Ctrl+Enter ・ 保存: Cmd/Ctrl+S</p>
      </div>
    )
  }

  function renderCodeEditor(path: string) {
    const tab = openFileTabs.find((item) => item.path === path)
    const tabLanguage = path === filePath ? language : tab?.language ?? languageFromPath(path)
    const tabCode = path === filePath ? code : tab?.content ?? ''
    return (
      <Editor
        className="code-editor"
        path={path}
        language={monacoLanguageIds[tabLanguage]}
        theme="accode-dark"
        value={tabCode}
        beforeMount={configureMonaco}
        onMount={(editor, monaco) => {
          if (path === filePath) handleEditorMount(editor, monaco)
        }}
        onChange={(value) => handlePaneCodeChange(path, value)}
        options={{
          acceptSuggestionOnCommitCharacter: false,
          acceptSuggestionOnEnter: 'off',
          autoClosingBrackets: 'always',
          autoClosingDelete: 'always',
          autoClosingOvertype: 'always',
          autoClosingQuotes: 'always',
          automaticLayout: true,
          bracketPairColorization: { enabled: true },
          cursorBlinking: 'smooth',
          cursorSmoothCaretAnimation: 'on',
          detectIndentation: false,
          fontFamily: 'Menlo, Monaco, Consolas, "Liberation Mono", monospace',
          fontLigatures: false,
          fontSize: 14,
          formatOnPaste: true,
          formatOnType: true,
          glyphMargin: true,
          lineHeight: 22,
          minimap: { enabled: false },
          occurrencesHighlight: 'singleFile',
          inlineSuggest: { enabled: false },
          parameterHints: { enabled: false },
          quickSuggestions: false,
          renderLineHighlight: 'all',
          scrollBeyondLastLine: false,
          smoothScrolling: true,
          suggest: {
            preview: false,
            selectionMode: 'always',
            showSnippets: false,
            snippetsPreventQuickSuggestions: true,
          },
          tabCompletion: 'on',
          tabSize: 4,
          wordBasedSuggestions: 'currentDocument',
          wordBasedSuggestionsOnlySameLanguage: true,
        }}
      />
    )
  }

  function renderPaneTabItems(activeKey: string, codeTabs: OpenFileTab[], showWebTabs: boolean) {
    return (
      <>
        {showWebTabs && webTabs.map((tab) => {
          const label = webTargets[targetFromWebUrl(tab.url)].label
          const key = webPaneKey(tab.id)
          return (
            <div
              key={tab.id}
              className={`workbench-tab browser-tab ${activeKey === key ? 'active' : ''}`}
              role="tab"
              tabIndex={0}
              draggable
              aria-selected={activeKey === key}
              title={tab.url}
              onPointerDown={(event) => handleOpenEditorPointerDown(event, { kind: 'web' })}
              onDragStart={(event) => handleOpenEditorDragStart(event, { kind: 'web' })}
              onDragEnd={handleOpenEditorDragEnd}
              onClick={() => {
                if (consumeSuppressedPaneClick()) return
                activateWebTab(tab.id)
              }}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return
                event.preventDefault()
                activateWebTab(tab.id)
              }}
            >
              <Globe2 size={17} />
              <span>{label}</span>
              <button
                className="tab-close"
                data-no-pane-drag
                type="button"
                title="Webタブを閉じる"
                onClick={(event) => {
                  event.stopPropagation()
                  closeWebTab(tab.id)
                }}
              >
                <X size={14} />
              </button>
            </div>
          )
        })}
        {codeTabs.map((tab) => {
          const key = codePaneKey(tab.path)
          return (
            <div
              key={tab.path}
              className={`workbench-tab ${activeKey === key ? 'active' : ''}`}
              role="tab"
              tabIndex={0}
              draggable
              aria-selected={activeKey === key}
              title={basename(tab.path)}
              onPointerDown={(event) => handleOpenEditorPointerDown(event, { kind: 'code', path: tab.path })}
              onDragStart={(event) => handleOpenEditorDragStart(event, { kind: 'code', path: tab.path })}
              onDragEnd={handleOpenEditorDragEnd}
              onClick={() => {
                if (consumeSuppressedPaneClick()) return
                switchFileTab(tab.path)
              }}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return
                event.preventDefault()
                switchFileTab(tab.path)
              }}
            >
              <FileCode2 size={16} />
              <span>{basename(tab.path)}</span>
              <button
                data-no-pane-drag
                type="button"
                onClick={(event) => {
                  event.stopPropagation()
                  closeFileTab(tab.path)
                }}
                title="閉じる"
              >
                <X size={14} />
              </button>
            </div>
          )
        })}
        {showWebTabs && (
          <button
            className="web-tab-add"
            type="button"
            onClick={addWebTab}
            onContextMenu={(event) => {
              event.preventDefault()
              event.stopPropagation()
              setWebTabMenu({ x: event.clientX, y: event.clientY })
            }}
            title="Webタブを追加"
          >
            <Plus size={15} />
          </button>
        )}
        {!showWebTabs && codeTabs.length === 0 && <div className="tab-spacer" />}
      </>
    )
  }

  function renderWebContent() {
    return (
      <div className="web-frame" ref={webFrameRef}>
        {!isTauri() && (
          <iframe
            title="Contest web"
            src={webUrl}
            sandbox="allow-scripts allow-forms allow-same-origin"
          />
        )}
        {isTauri() && <div className="native-webview-slot" />}
        {webError && <div className="web-error">{webError}</div>}
      </div>
    )
  }

  function renderWorkspacePane(side: WebSide) {
    const activeKey = activePaneKey(side)
    const codeTabs = openFileTabs.filter((tab) => tab.group === side)
    const showWebTabs = webSide === side || activeKey.startsWith('web:')
    return (
      <section
        className={`workspace-pane ${side} ${paneDragOverSide === side ? 'drag-over' : ''}`}
        data-open-editor-side={side}
        onDragOver={allowOpenEditorDrop}
        onDragEnter={() => setPaneDragOverSide(side)}
        onDragLeave={() => setPaneDragOverSide(null)}
        onDrop={(event) => handleOpenEditorDrop(event, side)}
      >
        <div className="pane-tabbar" aria-label={`${side} editor tabs`}>
          {renderPaneTabItems(activeKey, codeTabs, showWebTabs)}
        </div>
        <div className="pane-stage">
          {activeKey.startsWith('web:')
            ? renderWebContent()
            : activeKey.startsWith('code:')
              ? renderCodeEditor(activeKey.slice('code:'.length))
              : renderEmptyEditor()}
        </div>
      </section>
    )
  }


  function configureMonaco(monaco: MonacoInstance) {
    monacoRef.current = monaco
    monaco.editor.defineTheme('accode-dark', {
      base: 'vs-dark',
      inherit: true,
      rules: [
        { token: 'string', foreground: 'ce9178' },
        { token: 'number', foreground: 'b5cea8' },
        { token: 'keyword', foreground: '569cd6' },
        { token: 'comment', foreground: '6a9955' },
        { token: 'type', foreground: '4ec9b0' },
      ],
      colors: {
        'editor.background': '#1e1e1e',
        'editor.foreground': '#d4d4d4',
        'editorLineNumber.foreground': '#858585',
        'editorLineNumber.activeForeground': '#c6c6c6',
        'editorCursor.foreground': '#aeafad',
        'editor.selectionBackground': '#264f78',
        'editorSuggestWidget.background': '#252526',
        'editorSuggestWidget.border': '#454545',
        'editorSuggestWidget.selectedBackground': '#04395e',
      },
    })

  }

  function updateEditorDiagnostics(nextCode = code) {
    const monaco = monacoRef.current
    const editor = editorRef.current
    const model = editor?.getModel()
    if (!monaco || !model) return

    const issues = nextCode === code ? editorIssues : collectCodeIssues(nextCode, language)
    const markers = issues.map((issue) => ({
      startLineNumber: issue.lineNumber,
      startColumn: issue.startColumn,
      endLineNumber: issue.lineNumber,
      endColumn: issue.endColumn,
      message: issue.message,
      severity:
        issue.severity === 'error' ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning,
      source: 'AtCode',
    }))
    monaco.editor.setModelMarkers(model, 'accode', markers)
  }

  function handleEditorMount(editor: MonacoEditor, monaco: MonacoInstance) {
    editorRef.current = editor
    monacoRef.current = monaco
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => void buildSolution())
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void saveCurrentFile())
    updateEditorDiagnostics(editor.getValue())
  }

  useEffect(() => {
    updateEditorDiagnostics()
  })

  useEffect(() => {
    const handleKeydown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault()
        void buildSolution()
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        void saveCurrentFile()
      }
    }
    window.addEventListener('keydown', handleKeydown)
    return () => window.removeEventListener('keydown', handleKeydown)
  })

  return (
    <main className="ide-shell" onContextMenu={(event) => event.preventDefault()}>
      <header className="titlebar">
        <div className="title-left">
          <strong className="app-mark">AtCode</strong>
          <span className="title-separator" />
          <button type="button" onClick={buildSolution} disabled={busyLabel === 'building'}>
            <Hammer size={20} />
            コンパイル
          </button>
          <button type="button" onClick={runSolution} disabled={busyLabel === 'running'}>
            <Play size={20} fill="currentColor" />
            実行
          </button>
        </div>
        <div className="title-center">
          <select
            className="title-language-select"
            value={language}
            onChange={(event) => handleLanguageChange(event.target.value as Language)}
            title="言語"
          >
            <option value="cpp">C++</option>
            <option value="python">Python</option>
            <option value="rust">Rust</option>
          </select>
          <div className="title-web-switch" aria-label="Web target">
            <button
              className={webTarget === 'atcoder' ? 'active' : ''}
              type="button"
              onClick={() => switchWebTarget('atcoder')}
              title="AtCoderを開く"
            >
              AtCoder
            </button>
            <button
              className={webTarget === 'problems' ? 'active' : ''}
              type="button"
              onClick={() => switchWebTarget('problems')}
              title="Problemsを開く"
            >
              Problems
            </button>
          </div>
          <div className="title-browser-tools">
            <button type="button" onClick={() => void navigateWebHistory('back')} title="戻る">
              <ArrowLeft size={14} />
            </button>
            <button type="button" onClick={() => void navigateWebHistory('forward')} title="進む">
              <ArrowRight size={14} />
            </button>
            <button
              type="button"
              onClick={createSolution}
              disabled={!currentTask || busyLabel === 'creating'}
              title={currentTask ? `${currentGeneratedName} を生成` : '問題URLを開くと使えます'}
            >
              <FilePlus2 size={14} />
            </button>
            <button type="button" onClick={refreshWebPane} title="Reload">
              <RotateCw size={14} />
            </button>
          </div>
          <div className="title-url-bar">
            <input
              value={webDraftUrl}
              onChange={(event) => updateActiveWebTab({ draftUrl: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void openWebUrl()
              }}
              aria-label="current web url"
            />
            <button type="button" onClick={() => void openWebUrl()} title="URLを開く">
              <ExternalLink size={14} />
            </button>
          </div>
        </div>
        <div className="title-right">
          <button
            className="icon-tool"
            type="button"
            onClick={() => setTerminalOpen((current) => !current)}
            title="ターミナル"
          >
            <SquareTerminal size={20} />
          </button>
        </div>
      </header>

      <div
        className={`workbench ${webSide === 'left' ? 'web-left' : 'web-right'}`}
        style={
          {
            '--sidebar-width': `${sidebarWidth}px`,
            '--web-width': `${webWidth}px`,
          } as CSSProperties
        }
      >
        <nav className="activitybar" aria-label="Activity">
          <div className="activity-top">
            <button
              className={sidePanelMode === 'explorer' && !sidebarHidden ? 'active' : ''}
              type="button"
              onClick={toggleExplorerPanel}
              title={sidePanelMode === 'explorer' && !sidebarHidden ? 'Explorerを隠す' : 'Explorerを表示'}
            >
              <FileText size={28} />
            </button>
            <button
              className={sidePanelMode === 'search' && !sidebarHidden ? 'active' : ''}
              type="button"
              onClick={toggleSearchPanel}
              title={sidePanelMode === 'search' && !sidebarHidden ? '検索を隠す' : '検索'}
            >
              <Search size={30} />
            </button>
          </div>
          <div className="activity-bottom">
            <button
              className={sidePanelMode === 'settings' && !sidebarHidden ? 'active' : ''}
              type="button"
              onClick={() => showSidePanel('settings')}
              title="設定"
            >
              <Settings size={28} />
            </button>
          </div>
        </nav>

        <aside className="explorer-panel" aria-label="Explorer">
          <section className={`open-editors ${paneDragItem ? 'dragging' : ''}`} aria-label="Open editors">
            <div
              className={`open-editor-group ${paneDragOverSide === 'left' ? 'drag-over' : ''}`}
              data-open-editor-side="left"
              onDragOver={allowOpenEditorDrop}
              onDragEnter={() => setPaneDragOverSide('left')}
              onDragLeave={() => setPaneDragOverSide(null)}
              onDrop={(event) => handleOpenEditorDrop(event, 'left')}
            >
              left{webSide === 'left' && webHidden ? ' hide' : ''}
            </div>
            <div
              className={`open-editor-drop ${paneDragOverSide === 'left' ? 'drag-over' : ''}`}
              data-open-editor-side="left"
              onDragOver={allowOpenEditorDrop}
              onDragEnter={() => setPaneDragOverSide('left')}
              onDragLeave={() => setPaneDragOverSide(null)}
              onDrop={(event) => handleOpenEditorDrop(event, 'left')}
            >
              {webSide === 'left' && renderOpenWebEntry()}
              {renderOpenFileEntry('left')}
            </div>
            <div
              className={`open-editor-group ${paneDragOverSide === 'right' ? 'drag-over' : ''}`}
              data-open-editor-side="right"
              onDragOver={allowOpenEditorDrop}
              onDragEnter={() => setPaneDragOverSide('right')}
              onDragLeave={() => setPaneDragOverSide(null)}
              onDrop={(event) => handleOpenEditorDrop(event, 'right')}
            >
              right{webSide === 'right' && webHidden ? ' hide' : ''}
            </div>
            <div
              className={`open-editor-drop ${paneDragOverSide === 'right' ? 'drag-over' : ''}`}
              data-open-editor-side="right"
              onDragOver={allowOpenEditorDrop}
              onDragEnter={() => setPaneDragOverSide('right')}
              onDragLeave={() => setPaneDragOverSide(null)}
              onDrop={(event) => handleOpenEditorDrop(event, 'right')}
            >
              {webSide === 'right' && renderOpenWebEntry()}
              {renderOpenFileEntry('right')}
            </div>
          </section>
          {sidePanelMode === 'explorer' && (
            <>
              <div className="explorer-header">
                <button
                  className="explorer-root"
                  type="button"
                  onContextMenu={(event) => {
                    if (!workspacePath) return
                    showExplorerContextMenu(event, {
                      kind: 'folder',
                      path: workspacePath,
                      name: explorerRootName,
                      isDir: true,
                    })
                  }}
                >
                  <ChevronDown size={16} />
                  <span>{explorerRootName}</span>
                </button>
                <div className="explorer-actions">
                  <button type="button" onClick={createWorkspaceFile} title="New file">
                    <FilePlus2 size={16} />
                  </button>
                  <button type="button" onClick={chooseWorkspaceFolder} title="Open folder">
                    <FolderOpen size={16} />
                  </button>
                  <button type="button" onClick={createWorkspaceFolder} title="New folder">
                    <FolderPlus size={16} />
                  </button>
                  <button type="button" onClick={refreshWorkspaceFolder} title="Refresh">
                    <RefreshCw size={16} />
                  </button>
                </div>
              </div>
              <div className="explorer-tree">
                {explorerTree ? (
                  explorerTree.children.map((child) => renderExplorerNode(child, 0))
                ) : filePath ? (
                  <button className="explorer-row file-row active" type="button" onClick={chooseWorkspaceFolder}>
                    <FileCode2 size={15} />
                    <span>{explorerFileName}</span>
                  </button>
                ) : (
                  <div className="explorer-empty">
                    <button type="button" onClick={chooseWorkspaceFolder}>
                      <FolderOpen size={16} />
                      フォルダを開く
                    </button>
                    {recentFolders.length > 0 && (
                      <div className="recent-folders">
                        <span>RECENT</span>
                        {recentFolders.map((path) => (
                          <button key={path} type="button" onClick={() => void loadWorkspaceFolder(path)}>
                            {path.split('/').filter(Boolean).at(-1) || path}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
              <section
                className={`explorer-diff ${diffOpen ? '' : 'collapsed'}`}
                style={{ '--explorer-diff-height': `${explorerDiffHeight}px` } as CSSProperties}
                aria-label="履歴Diff"
              >
                <div
                  className="explorer-diff-resizer"
                  onMouseDown={startExplorerDiffResize}
                  title="履歴Diffの高さを変更"
                />
                <div className="explorer-diff-header">
                  <button type="button" onClick={() => setDiffOpen((current) => !current)}>
                    <ChevronDown className={diffOpen ? '' : 'collapsed'} size={15} />
                    <span>履歴Diff</span>
                  </button>
                  <span>{selectedFileDiffs.length > 0 ? selectedFileDiffs.length : ''}</span>
                </div>
                {diffOpen &&
                  (filePath ? (
                    selectedFileDiffs.length > 0 && activeFileDiff ? (
                      <>
                        <div className="explorer-diff-list">
                          {selectedFileDiffs.map((entry) => (
                            <button
                              key={entry.id}
                              className={entry.id === activeFileDiff.id ? 'active' : ''}
                              type="button"
                              onClick={() => setActiveDiffId(entry.id)}
                              title={`${entry.command}\n${entry.filePath}`}
                            >
                              <span>{entry.createdAt}</span>
                              <strong>{entry.source === 'compile' ? 'compile' : 'run'} / exit {entry.status}</strong>
                            </button>
                          ))}
                        </div>
                        <div className="explorer-diff-viewer">
                          <div className="explorer-diff-meta">
                            <strong>{activeFileDiff.fileName}</strong>
                            <span>{activeFileDiff.command}</span>
                          </div>
                          <pre>{activeFileDiff.diff.split('\n').map(renderDiffLine)}</pre>
                        </div>
                      </>
                    ) : (
                      <div className="explorer-diff-empty">このファイルはまだ履歴Diffがありません。</div>
                    )
                  ) : (
                    <div className="explorer-diff-empty">ファイルを選択すると履歴Diffを表示します。</div>
                  ))}
              </section>
            </>
          )}

          {sidePanelMode === 'search' && (
            <section className="side-panel-section" aria-label="Search files">
              <div className="side-panel-title">検索</div>
              <input
                className="side-search-input"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="ファイル名を検索"
              />
              <div className="side-list">
                {!workspacePath ? (
                  <button className="side-action-button" type="button" onClick={chooseWorkspaceFolder}>
                    <FolderOpen size={15} />
                    フォルダを開く
                  </button>
                ) : searchResults.length > 0 ? (
                  searchResults.map((node) => (
                    <button
                      key={node.path}
                      className="side-list-row"
                      type="button"
                      onClick={() => openExplorerItem(node.path, node.isDir)}
                    >
                      {node.isDir ? <Folder size={15} /> : <FileCode2 size={15} />}
                      <span>{node.name}</span>
                    </button>
                  ))
                ) : (
                  <div className="side-muted">{searchQuery.trim() ? '該当なし' : '検索語を入力してください'}</div>
                )}
              </div>
            </section>
          )}

          {sidePanelMode === 'settings' && (
            <SettingsPanel
              environmentPlan={environmentPlan}
              language={language}
              onCopyCommand={copyCommand}
              onRunLanguageSetup={() => void runLanguageSetup()}
              onToggleTerminal={() => setTerminalOpen((current) => !current)}
              onResetLayout={() => {
                setSidebarWidth(248)
                setWebWidth(initialWebPaneWidth())
                setWebSide('right')
              }}
              onClearDiffHistory={() => {
                setDiffHistory([])
                setActiveDiffId('')
                setDiffOpen(false)
              }}
            />
          )}
        </aside>

        <div
          className="vertical-resizer sidebar-resizer"
          role="separator"
          aria-label="サイドバー幅"
          aria-orientation="vertical"
          onMouseDown={(event) => startLayoutResize('sidebar', event)}
        />

        {renderWorkspacePane('left')}

        <div
          className="vertical-resizer web-resizer"
          role="separator"
          aria-label="コードとWebの幅"
          aria-orientation="vertical"
          onMouseDown={(event) => startLayoutResize('web', event)}
        />

        {renderWorkspacePane('right')}
      </div>

      {webTabMenu && (
        <div
          className="web-tab-menu"
          style={{ left: webTabMenu.x, top: webTabMenu.y } as CSSProperties}
          onClick={(event) => event.stopPropagation()}
          role="menu"
        >
          <button type="button" onClick={duplicateLeftWebTab} role="menuitem">
            左のタブを複製
          </button>
          <button type="button" onClick={() => addWebTabForTarget('problems')} role="menuitem">
            Problemsを開く
          </button>
          <button type="button" onClick={() => addWebTabForTarget('atcoder')} role="menuitem">
            AtCoderを開く
          </button>
        </div>
      )}

      {explorerContextMenu && (
        <div
          className="context-menu"
          style={{ left: explorerContextMenu.x, top: explorerContextMenu.y } as CSSProperties}
          onClick={(event) => event.stopPropagation()}
          role="menu"
        >
          <button type="button" onClick={() => void handleContextAction('delete', explorerContextMenu.target)} role="menuitem">
            削除
          </button>
          <button type="button" onClick={() => void handleContextAction('rename', explorerContextMenu.target)} role="menuitem">
            名前を変更
          </button>
          <button type="button" onClick={() => void handleContextAction('reveal', explorerContextMenu.target)} role="menuitem">
            Finderで表示
          </button>
          <button type="button" onClick={() => void handleContextAction('copy-path', explorerContextMenu.target)} role="menuitem">
            パスをコピー
          </button>
          <button type="button" onClick={() => void handleContextAction('terminal', explorerContextMenu.target)} role="menuitem">
            このディレクトリでターミナルを開く
          </button>
          {!explorerContextMenu.target.isDir && (
            <>
              <div className="context-menu-separator" role="separator" />
              <button type="button" onClick={() => void handleContextAction('compile', explorerContextMenu.target)} role="menuitem">
                コンパイル
              </button>
              <button type="button" onClick={() => void handleContextAction('run', explorerContextMenu.target)} role="menuitem">
                実行
              </button>
              <button type="button" onClick={() => void handleContextAction('diff', explorerContextMenu.target)} role="menuitem">
                履歴Diffを表示
              </button>
              <div className="context-menu-separator" role="separator" />
              <div className="context-menu-label">同じ問題の別言語ファイルを作成</div>
              <button type="button" onClick={() => void handleContextAction('lang:cpp', explorerContextMenu.target)} role="menuitem">
                C++ (.cpp)
              </button>
              <button type="button" onClick={() => void handleContextAction('lang:python', explorerContextMenu.target)} role="menuitem">
                Python (.py)
              </button>
              <button type="button" onClick={() => void handleContextAction('lang:rust', explorerContextMenu.target)} role="menuitem">
                Rust (.rs)
              </button>
            </>
          )}
        </div>
      )}

      {terminalOpen && (
        <TerminalPanel
          height={terminalHeight}
          left={48 + sidebarWidth + 6}
          workingDirectory={terminalWorkingDirectory}
          terminalRef={terminalElementRef}
          onResizeStart={(event) => {
            dragStart.current = { y: event.clientY, height: terminalHeight, lastHeight: terminalHeight }
          }}
          onTerminate={() => void terminateTerminal()}
          onClose={() => setTerminalOpen(false)}
        />
      )}

      <footer className="statusbar">
        <span>{filePath ? filePath.split('/').pop() : 'ファイルなし'}</span>
        <span className="status-diagnostics" title="エディタ診断">
          <span className={errorCount > 0 ? 'has-error' : ''}>Errors {errorCount}</span>
          <span className={warningCount > 0 ? 'has-warning' : ''}>Warnings {warningCount}</span>
        </span>
        <span>{workspacePath || 'フォルダなし'}</span>
      </footer>

      <input
        ref={folderInputRef}
        className="hidden-file-input"
        type="file"
        multiple
        onChange={handleBrowserFolderSelect}
      />
    </main>
  )
}

function buildBrowserFolderTree(files: File[]) {
  const firstRelativePath =
    (files[0] as File & { webkitRelativePath?: string }).webkitRelativePath || files[0].name
  const rootName = firstRelativePath.split('/')[0] || 'Folder'
  const root: ExplorerNode = {
    name: rootName,
    path: rootName,
    isDir: true,
    children: [],
  }
  const directoryMap = new Map<string, ExplorerNode>([[root.path, root]])
  const fileMap = new Map<string, File>()

  for (const file of files) {
    const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name
    const parts = relativePath.split('/').filter(Boolean)
    const fileName = parts.pop()
    if (!fileName) continue

    let parent = root
    let currentPath = root.path
    const directoryParts = parts[0] === rootName ? parts.slice(1) : parts
    for (const part of directoryParts) {
      currentPath = `${currentPath}/${part}`
      let child = directoryMap.get(currentPath)
      if (!child) {
        child = { name: part, path: currentPath, isDir: true, children: [] }
        directoryMap.set(currentPath, child)
        parent.children.push(child)
      }
      parent = child
    }

    const filePath = `${currentPath}/${fileName}`
    fileMap.set(filePath, file)
    parent.children.push({
      name: fileName,
      path: filePath,
      isDir: false,
      children: [],
    })
  }

  sortExplorerTree(root)
  return { root, fileMap }
}

function sortExplorerTree(node: ExplorerNode) {
  node.children.sort((left, right) => {
    if (left.isDir !== right.isDir) return left.isDir ? -1 : 1
    return left.name.localeCompare(right.name)
  })
  node.children.forEach(sortExplorerTree)
}

export default App
