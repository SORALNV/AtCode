export function isWindowsHost() {
  const platform = navigator.platform.toLowerCase()
  const agent = navigator.userAgent.toLowerCase()
  return platform.includes('win') || agent.includes('windows')
}

export function defaultWorkspacePath() {
  if (isWindowsHost()) return ''
  return '/Users/sora/AtCode'
}

export function parentDirectory(path: string) {
  const normalized = path.replace(/\\/g, '/')
  const index = normalized.lastIndexOf('/')
  if (index <= 0) return ''
  return path.slice(0, index)
}

export function basename(path: string) {
  return path.split(/[\\/]/).pop() || path
}

export function joinPath(parent: string, child: string) {
  const separator = parent.includes('\\') ? '\\' : '/'
  return `${parent.replace(/[\\/]+$/, '')}${separator}${child.replace(/^[\\/]+/, '')}`
}

export function shellQuote(value: string) {
  if (isWindowsHost()) return `'${value.replace(/'/g, "''")}'`
  return `'${value.replace(/'/g, "'\\''")}'`
}

export function changeDirectoryCommand(path: string) {
  if (isWindowsHost()) return `Set-Location -LiteralPath ${shellQuote(path)}\r`
  return `cd ${shellQuote(path)}\r`
}

export function commandJoiner() {
  return isWindowsHost() ? '; ' : ' && '
}
