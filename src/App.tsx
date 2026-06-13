import {
  type ChangeEvent,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
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
import {
  ArrowLeft,
  ArrowLeftRight,
  ArrowRight,
  ChevronDown,
  Copy,
  ExternalLink,
  FileCode2,
  FilePlus2,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Globe2,
  Hammer,
  History,
  Play,
  RefreshCw,
  RotateCw,
  Search,
  Settings,
  SquareTerminal,
  Wrench,
  X,
} from 'lucide-react'
import './App.css'

type Language = 'cpp' | 'python' | 'rust'
type WebTarget = 'atcoder' | 'problems'
type SidePanelMode = 'explorer' | 'search' | 'setup' | 'settings'
type WebSide = 'left' | 'right'

type EnvironmentPlan = {
  os: string
  package_manager: string
  commands: Array<{ label: string; command: string }>
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
  command: string
  status: number
  stdout: string
  stderr: string
  diff: string
}

type ContestWebviewRequest = {
  url: string
  x: number
  y: number
  width: number
  height: number
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

const webTargets: Record<WebTarget, { label: string; url: string }> = {
  atcoder: { label: 'AtCoder', url: 'https://atcoder.jp/' },
  problems: { label: 'Problems', url: 'https://kenkoooo.com/atcoder/' },
}

const recentFoldersKey = 'accode.recentFolders'

const fallbackPlan: EnvironmentPlan = {
  os: navigator.platform.toLowerCase().includes('win') ? 'Windows' : 'macOS/Linux',
  package_manager: navigator.platform.toLowerCase().includes('win')
    ? 'winget + MSYS2'
    : 'Homebrew / apt',
  commands: navigator.platform.toLowerCase().includes('win')
    ? [
        { label: 'Python', command: 'winget install -e --id Python.Python.3.13' },
        {
          label: 'C++',
          command:
            'winget install -e --id MSYS2.MSYS2 && C:\\msys64\\usr\\bin\\pacman -S --needed mingw-w64-ucrt-x86_64-gcc',
        },
        { label: 'Rust', command: 'winget install -e --id Rustlang.Rustup' },
      ]
    : [
        { label: 'Xcode CLI', command: 'xcode-select --install' },
        { label: 'Python', command: 'brew install python' },
        { label: 'C++', command: 'brew install gcc' },
        { label: 'Rust', command: 'brew install rustup && rustup-init' },
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
      path: `/Users/sora/AtCode/contests/${contest}/${contest}${problem}.${languageExtensions[request.language]}`,
      content: templateFor(request.language),
      language: request.language,
    } as T
  }

  if (command === 'build_solution') {
    return {
      file_path: String((args?.request as { path: string }).path),
      command: 'Preview mode: build command runs inside Tauri.',
      status: 0,
      stdout: 'Preview build completed.',
      stderr: '',
      diff: 'Preview mode does not persist build snapshots.',
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
    const match = url.pathname.match(/^\/contests\/([^/]+)\/tasks\/([^/]+)/)
    if (!match) return null

    const contest = match[1].toLowerCase()
    const taskId = match[2]
    const suffix = taskId.split('_').pop() || taskId
    return {
      contest,
      problem: suffix.toLowerCase(),
    }
  } catch {
    return null
  }
}

function templateFor(language: Language) {
  if (language === 'python') {
    return `import sys


def main() -> None:
    input = sys.stdin.readline
    n = input().strip()
    print(n)


if __name__ == "__main__":
    main()
`
  }

  if (language === 'rust') {
    return `use std::io::{self, Read};

fn main() {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input).unwrap();
    println!("{}", input.trim());
}
`
  }

  return `#include <bits/stdc++.h>
using namespace std;

int main() {
    ios::sync_with_stdio(false);
    cin.tie(nullptr);

    string s;
    cin >> s;
    cout << s << '\\n';
    return 0;
}
`
}

function languageFromPath(path: string): Language {
  const extension = path.split('.').pop()?.toLowerCase()
  if (extension === 'py') return 'python'
  if (extension === 'rs') return 'rust'
  return 'cpp'
}

function defaultWorkspacePath() {
  const user = navigator.userAgent.toLowerCase()
  if (user.includes('windows')) return ''
  return '/Users/sora/AtCode'
}

function workspaceRootFromGeneratedPath(path: string, contest: string) {
  const marker = `/contests/${contest.toLowerCase()}/`
  const index = path.indexOf(marker)
  if (index > 0) return path.slice(0, index)
  return path.split('/').slice(0, -1).join('/')
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function initialWebPaneWidth() {
  const maxWidth = Math.max(360, window.innerWidth - 48 - 8 - 300 - 248)
  return clamp(Math.round(window.innerWidth * 0.47), 360, maxWidth)
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
  const [terminalOpen, setTerminalOpen] = useState(false)
  const [terminalHeight, setTerminalHeight] = useState(220)
  const [terminalCommand, setTerminalCommand] = useState('pwd')
  const [terminalLog, setTerminalLog] = useState('$ terminal ready')
  const [buildResult, setBuildResult] = useState<BuildResult | null>(null)
  const [diffOpen, setDiffOpen] = useState(false)
  const [sidePanelMode, setSidePanelMode] = useState<SidePanelMode>('explorer')
  const [searchQuery, setSearchQuery] = useState('')
  const [busyLabel, setBusyLabel] = useState('')
  const [webTarget, setWebTarget] = useState<WebTarget>('problems')
  const [webDraftUrl, setWebDraftUrl] = useState(webTargets.problems.url)
  const [webUrl, setWebUrl] = useState(webTargets.problems.url)
  const [webError, setWebError] = useState('')
  const [webSide, setWebSide] = useState<WebSide>('right')
  const [sidebarWidth, setSidebarWidth] = useState(248)
  const [webWidth, setWebWidth] = useState(initialWebPaneWidth)
  const dragStart = useRef<{ y: number; height: number; lastHeight: number } | null>(null)
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
  const folderInputRef = useRef<HTMLInputElement | null>(null)
  const browserFolderFilesRef = useRef<Map<string, File>>(new Map())
  const webFrameRef = useRef<HTMLDivElement | null>(null)
  const webUrlRef = useRef(webUrl)
  const webSideRef = useRef<WebSide>(webSide)
  const skipNextWebNavigateRef = useRef(false)

  const currentTask = taskFromAtcoderUrl(webUrl)
  const currentContest = currentTask?.contest ?? contest
  const currentProblem = currentTask?.problem ?? problem
  const currentGeneratedName = useMemo(
    () => `${currentContest}_${currentProblem}.${languageExtensions[language]}`,
    [currentContest, currentProblem, language],
  )

  const explorerFileName = filePath ? filePath.split('/').pop() || currentGeneratedName : ''
  const explorerFilePathText = useMemo(() => {
    if (!filePath) return ''
    if (workspacePath && filePath.startsWith(workspacePath)) {
      return filePath.slice(workspacePath.length).replace(/^\/+/, '')
    }
    return filePath.split('/').slice(-3).join('/')
  }, [filePath, workspacePath])
  const explorerRootName = useMemo(() => {
    if (!workspacePath) return 'NO FOLDER'
    const parts = workspacePath.split('/').filter(Boolean)
    return (parts.at(-1) || workspacePath).toUpperCase()
  }, [workspacePath])
  const visibleWebTarget = targetFromWebUrl(webUrl)
  const activeWebLabel = webTargets[visibleWebTarget].label

  useEffect(() => {
    folderInputRef.current?.setAttribute('webkitdirectory', '')
  }, [])

  useEffect(() => {
    webUrlRef.current = webUrl
  }, [webUrl])

  useEffect(() => {
    webSideRef.current = webSide
  }, [webSide])

  useEffect(() => {
    sidebarWidthRef.current = sidebarWidth
    webWidthRef.current = webWidth
    if (sidebarWidth > 0) lastSidebarWidthRef.current = sidebarWidth
    if (webWidth > 0) lastWebWidthRef.current = webWidth
  }, [sidebarWidth, webWidth])

  const sidebarHidden = sidebarWidth <= 0
  const webHidden = webWidth <= 0
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
    if (webWidth <= 0) return null
    const element = webFrameRef.current
    if (!element) return null
    const rect = element.getBoundingClientRect()
    const statusbarHeight = 24
    const bottomLimit = terminalOpen
      ? window.innerHeight - statusbarHeight - terminalHeight
      : window.innerHeight - statusbarHeight
    const height = Math.max(80, Math.min(rect.height, bottomLimit - rect.top))
    return {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.max(80, Math.round(rect.width)),
      height: Math.round(height),
    }
  }, [terminalHeight, terminalOpen, webWidth])

  useEffect(() => {
    callBackend<EnvironmentPlan>('get_environment_plan')
      .then(setEnvironmentPlan)
      .catch(() => setEnvironmentPlan(fallbackPlan))
  }, [])

  useEffect(() => {
    if (!isTauri()) return

    let unlisten: (() => void) | undefined
    void listen<string>('contest-webview-url', (event) => {
      const nextUrl = event.payload
      if (!isAllowedContestUrl(nextUrl)) return
      const nextTarget = targetFromWebUrl(nextUrl)
      setWebTarget(nextTarget)
      setWebDraftUrl(nextUrl)
      if (nextUrl !== webUrlRef.current) {
        skipNextWebNavigateRef.current = true
        webUrlRef.current = nextUrl
        setWebUrl(nextUrl)
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

        const request: ContestWebviewRequest = {
          url: webUrl,
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

        const updateBounds = () => {
          const nextRect = getWebviewRect()
          if (!nextRect) return
          void callBackend<void>('set_contest_webview_bounds', { request: nextRect }).catch(() => undefined)
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
  }, [getWebviewRect, webUrl])

  useEffect(() => {
    if (!isTauri() || webWidth > 0) return
    void callBackend<void>('close_contest_webview').catch(() => undefined)
  }, [webWidth])

  useEffect(() => {
    if (!isTauri()) return
    return () => {
      void callBackend<void>('close_contest_webview').catch(() => undefined)
    }
  }, [])

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
      setFilePath(result.path)
      setCode(result.content)
      setLanguage(result.language)
      if (generatedRoot) {
        await loadWorkspaceFolder(generatedRoot)
        setExpandedPaths((current) => {
          const next = new Set(current)
          next.add(`${generatedRoot}/contests`)
          next.add(`${generatedRoot}/contests/${targetContest.toLowerCase()}`)
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

    const nextPath = `${workspacePath.replace(/\/+$/, '')}/${fileName}`
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

  async function openExplorerFile(path: string) {
    const browserFile = browserFolderFilesRef.current.get(path)
    if (browserFile) {
      const content = await browserFile.text()
      const nextLanguage = languageFromPath(browserFile.name)
      setFilePath(path)
      setCode(content)
      setLanguage(nextLanguage)
      appendTerminal(`opened ${path}`)
      return
    }

    setBusyLabel('opening')
    try {
      const result = await callBackend<SolutionFile>('read_source_file', { path })
      setFilePath(result.path)
      setCode(result.content)
      setLanguage(result.language)
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
    setBusyLabel('building')
    try {
      const result = await callBackend<BuildResult>('build_solution', {
        request: { path: filePath, content: code, language },
      })
      setBuildResult(result)
      setDiffOpen(true)
      appendTerminal(`$ ${result.command}`)
      appendTerminal(result.stdout || result.stderr || `exit ${result.status}`)
    } catch (error) {
      appendTerminal(`build failed: ${String(error)}`)
    } finally {
      setBusyLabel('')
    }
  }

  async function runSolution() {
    setTerminalOpen(true)
    setBusyLabel('running')
    try {
      const result = await callBackend<CommandResult>('run_terminal_command', {
        command: terminalCommand,
      })
      appendTerminal(`$ ${result.command}`)
      appendTerminal(result.stdout || result.stderr || `exit ${result.status}`)
    } catch (error) {
      appendTerminal(`run failed: ${String(error)}`)
    } finally {
      setBusyLabel('')
    }
  }

  function appendTerminal(value: string) {
    setTerminalLog((current) => `${current}\n${value}`.trim())
  }

  function copyCommand(value: string) {
    void navigator.clipboard?.writeText(value)
  }

  async function openWebUrl(nextUrl = webDraftUrl) {
    const normalized = normalizeWebUrl(nextUrl)
    const allowed = await callBackend<boolean>('is_allowed_atcoder_url', { url: normalized })
    if (!allowed) {
      setWebError('AtCoder または AtCoder Problems の URL だけ開けます。')
      return
    }
    setWebError('')
    setWebDraftUrl(normalized)
    webUrlRef.current = normalized
    setWebUrl(normalized)
  }

  function refreshWebPane() {
    void openWebUrl(webUrl)
  }

  async function navigateWebHistory(direction: 'back' | 'forward') {
    if (webWidth <= 0) setWebWidth(lastWebWidthRef.current || initialWebPaneWidth())
    try {
      await callBackend<void>(direction === 'back' ? 'contest_webview_back' : 'contest_webview_forward')
    } catch (error) {
      appendTerminal(`web ${direction} failed: ${String(error)}`)
    }
  }

  function switchWebTarget(nextTarget: WebTarget) {
    setWebTarget(nextTarget)
    setWebDraftUrl(webTargets[nextTarget].url)
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

  function closeCurrentFile() {
    setFilePath('')
    setCode('')
    setBuildResult(null)
    setDiffOpen(false)
  }

  function renderOpenFileEntry() {
    if (filePath) {
      return (
        <button className="open-editor-row" type="button" onClick={closeCurrentFile} title="ファイルを閉じる">
          <X size={15} />
          <FileCode2 size={15} />
          <span className="open-editor-name">{explorerFileName}</span>
          {explorerFilePathText && <span className="open-editor-path">{explorerFilePathText}</span>}
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
        <button className="open-editor-row muted" type="button" onClick={toggleWebPane} title="Webを表示">
          <Globe2 size={15} />
          <span className="open-editor-name">ブラウザー</span>
          <span className="open-editor-path">hide</span>
        </button>
      )
    }

    return (
      <button className="open-editor-row active" type="button" onClick={toggleWebPane} title="Webを隠す">
        <X size={15} />
        <Globe2 size={15} />
        <span className="open-editor-name">ブラウザー</span>
        <span className="open-editor-path">{webTargets[webTarget].label}</span>
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

  function toggleDiff() {
    if (!buildResult) {
      appendTerminal('diff is empty: compile once to create a snapshot')
      return
    }
    setDiffOpen((current) => !current)
  }

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
          <button type="button" onClick={toggleDiff}>
            <History size={20} />
            履歴Diff
          </button>
        </div>
        <div className="title-right">
          <select
            className="language-select"
            value={language}
            onChange={(event) => setLanguage(event.target.value as Language)}
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
            <button
              type="button"
              onClick={() => setWebSide((current) => (current === 'right' ? 'left' : 'right'))}
              title={webSide === 'right' ? 'Webを左に移動' : 'Webを右に移動'}
            >
              <ArrowLeftRight size={14} />
            </button>
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
          </div>
          <div className="title-url-bar">
            <input
              value={webDraftUrl}
              onChange={(event) => setWebDraftUrl(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void openWebUrl()
              }}
              aria-label="current web url"
            />
            <button type="button" onClick={() => void openWebUrl()} title="URLを開く">
              <ExternalLink size={14} />
            </button>
          </div>
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
              className={sidePanelMode === 'setup' && !sidebarHidden ? 'active' : ''}
              type="button"
              onClick={() => showSidePanel('setup')}
              title="環境構築"
            >
              <Wrench size={28} />
            </button>
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
          <section className="open-editors" aria-label="Open editors">
            <div className="open-editor-group">left{webSide === 'left' && webHidden ? ' hide' : ''}</div>
            {webSide === 'left' ? renderOpenWebEntry() : renderOpenFileEntry()}
            <div className="open-editor-group">right{webSide === 'right' && webHidden ? ' hide' : ''}</div>
            {webSide === 'left' ? renderOpenFileEntry() : renderOpenWebEntry()}
          </section>
          {sidePanelMode === 'explorer' && (
            <>
              <div className="explorer-header">
                <button className="explorer-root" type="button">
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

          {sidePanelMode === 'setup' && (
            <section className="side-panel-section" aria-label="Environment setup">
              <div className="side-panel-title">環境構築</div>
              <div className="side-panel-meta">
                <strong>{environmentPlan?.os ?? 'OS'}</strong>
                <span>{environmentPlan?.package_manager ?? 'setup'}</span>
              </div>
              <div className="side-list">
                {environmentPlan?.commands.map((item) => (
                  <button key={item.command} className="side-list-row command-row" type="button" onClick={() => copyCommand(item.command)}>
                    <Copy size={14} />
                    <span>{item.label}</span>
                  </button>
                ))}
              </div>
              {environmentPlan?.notes.map((note) => (
                <p className="side-note" key={note}>
                  {note}
                </p>
              ))}
            </section>
          )}

          {sidePanelMode === 'settings' && (
            <section className="side-panel-section" aria-label="Settings">
              <div className="side-panel-title">設定</div>
              <button className="side-action-button" type="button" onClick={() => setTerminalOpen((current) => !current)}>
                <SquareTerminal size={15} />
                ターミナルを切替
              </button>
              <button
                className="side-action-button"
                type="button"
                onClick={() => {
                  setSidebarWidth(248)
                  setWebWidth(initialWebPaneWidth())
                  setWebSide('right')
                }}
              >
                <RefreshCw size={15} />
                レイアウトをリセット
              </button>
              <button
                className="side-action-button"
                type="button"
                onClick={() => {
                  setBuildResult(null)
                  setDiffOpen(false)
                }}
              >
                <History size={15} />
                履歴Diffをクリア
              </button>
            </section>
          )}
        </aside>

        <div
          className="vertical-resizer sidebar-resizer"
          role="separator"
          aria-label="サイドバー幅"
          aria-orientation="vertical"
          onMouseDown={(event) => startLayoutResize('sidebar', event)}
        />

        <section className="editor-column">
          <div className="editor-tabbar" aria-label="left editor tabs">
            {filePath ? (
              <div className="workbench-tab active">
                <FileCode2 size={16} />
                <span>{filePath.split('/').pop()}</span>
                <button type="button" onClick={closeCurrentFile} title="閉じる">
                  <X size={14} />
                </button>
              </div>
            ) : (
              <div className="tab-spacer" />
            )}
          </div>

          <div className="editor-stage">
            {filePath ? (
              <textarea
                className="code-editor"
                spellCheck={false}
                value={code}
                onChange={(event) => setCode(event.target.value)}
                aria-label="source editor"
              />
            ) : (
              <div className="empty-editor">
                <p>作業フォルダを開いてください。</p>
                <div className="empty-editor-actions">
                  <button type="button" onClick={chooseWorkspaceFolder}>
                    <FolderOpen size={16} />
                    フォルダを開く
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
            )}
          </div>
        </section>

        <div
          className="vertical-resizer web-resizer"
          role="separator"
          aria-label="コードとWebの幅"
          aria-orientation="vertical"
          onMouseDown={(event) => startLayoutResize('web', event)}
        />

        <section className="web-column">
          <div className="web-tabbar" aria-label="right editor tabs">
            <div className="workbench-tab active browser-tab">
              <Globe2 size={17} />
              <span>{activeWebLabel}</span>
              <button type="button" onClick={toggleWebPane} title="Webを閉じる">
                <X size={14} />
              </button>
            </div>
          </div>
          <div className="web-toolbar">
            <div className="web-target-switch" aria-label="Web target">
              <button
                className={webTarget === 'atcoder' ? 'active' : ''}
                type="button"
                onClick={() => switchWebTarget('atcoder')}
              >
                AtCoder
              </button>
              <button
                className={webTarget === 'problems' ? 'active' : ''}
                type="button"
                onClick={() => switchWebTarget('problems')}
              >
                Problems
              </button>
            </div>
            <div className="web-address">
              <input
                value={webDraftUrl}
                onChange={(event) => setWebDraftUrl(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void openWebUrl()
                }}
                aria-label="contest web url"
              />
              <button type="button" onClick={refreshWebPane} title="Reload">
                <RotateCw size={14} />
              </button>
              <button type="button" onClick={() => void openWebUrl()} title="Open URL">
                <ExternalLink size={14} />
              </button>
            </div>
          </div>
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
        </section>
      </div>

      {terminalOpen && (
        <section className="terminal-panel" style={{ height: terminalHeight, left: 48 + sidebarWidth + 6 }}>
          <div
            className="terminal-resizer"
            onMouseDown={(event) => {
              dragStart.current = { y: event.clientY, height: terminalHeight, lastHeight: terminalHeight }
            }}
          />
          <div className="terminal-command">
            <SquareTerminal size={16} />
            <input
              value={terminalCommand}
              onChange={(event) => setTerminalCommand(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void runSolution()
              }}
            />
            <button type="button" onClick={runSolution}>
              実行
            </button>
          </div>
          <pre>{terminalLog}</pre>
        </section>
      )}

      <footer className="statusbar">
        <span>{filePath ? filePath.split('/').pop() : 'ファイルなし'}</span>
        <span>{workspacePath || '/Users/sora/AtCode'}</span>
      </footer>

      {buildResult && diffOpen && (
        <div className="diff-toast">
          <div className="diff-toast-header">
            <strong>履歴Diff</strong>
            <button type="button" onClick={() => setDiffOpen(false)} title="閉じる">
              <X size={14} />
            </button>
          </div>
          <pre>{buildResult.diff}</pre>
        </div>
      )}

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
