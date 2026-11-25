// Discovery layer for the local AGY (Antigravity) language server:
// port discovery from CLI logs and CSRF token discovery from process command lines.
// Mechanism references (not copied): n2ns/antigravity-panel debug scripts.
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'

/** Extract local HTTP server ports from CLI log text.
 * Matches lines like: `Language server listening on random port at 53245 for HTTP`
 * (the `for HTTPS (gRPC)` sibling lines are deliberately excluded). */
export function parseLogPorts(logText: string): number[] {
  const ports: number[] = []
  const re = /Language server listening on random port at (\d{2,5}) for HTTP\b/g
  for (const match of logText.matchAll(re)) {
    const port = Number(match[1])
    if (port > 0 && port < 65536) ports.push(port)
  }
  return [...new Set(ports)]
}

/** Read the newest CLI logs (newest first) and extract their local HTTP ports. */
export function readLogPorts(logDir: string, logFileCount = 3): { ports: number[]; newestLogMtimeMs: number | null } {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(logDir, { withFileTypes: true })
  } catch {
    return { ports: [], newestLogMtimeMs: null }
  }
  const logs = entries
    .filter((e) => e.isFile() && /^cli-.*\.log$/.test(e.name))
    .map((e) => path.join(logDir, e.name))
  const withMtime: { file: string; mtimeMs: number }[] = []
  for (const file of logs) {
    try {
      withMtime.push({ file, mtimeMs: fs.statSync(file).mtimeMs })
    } catch {
      // file vanished between readdir and stat; skip it
    }
  }
  // Newest first. mtime ties (same-millisecond batch writes are common on
  // NTFS) break on the descending date-stamped basename: under the `cli-*.log`
  // naming convention lexicographic order matches chronological order, so the
  // total order stays deterministic without changing the newest-first meaning.
  withMtime.sort((a, b) =>
    b.mtimeMs - a.mtimeMs ||
    (path.basename(a.file) < path.basename(b.file) ? 1 : path.basename(a.file) > path.basename(b.file) ? -1 : 0),
  )
  const ports: number[] = []
  for (const { file } of withMtime.slice(0, logFileCount)) {
    let text: string
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    ports.push(...parseLogPorts(text))
  }
  const newest = withMtime[0]?.mtimeMs ?? null
  return { ports: [...new Set(ports)], newestLogMtimeMs: newest }
}

interface CommandLineProcess {
  name: string
  commandLine: string
}

/** Best-effort: list candidate processes with their command lines (Windows only). */
function listWindowsProcessCommandLines(processNameHint: string): Promise<CommandLineProcess[]> {
  return new Promise<CommandLineProcess[]>((resolve) => {
    const args = [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Get-CimInstance Win32_Process -Filter "Name like '%${processNameHint}%'" | ` +
        'Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress',
    ]
    execFile('powershell.exe', args, { timeout: 10_000, windowsHide: true }, (err, stdout) => {
      const output = typeof stdout === 'string' ? stdout : ''
      if (err || !output.trim()) {
        resolve([])
        return
      }
      try {
        const parsed: unknown = JSON.parse(output)
        const rows = Array.isArray(parsed) ? parsed : [parsed]
        const out: CommandLineProcess[] = []
        for (const row of rows) {
          if (row && typeof row === 'object') {
            const rec = row as Record<string, unknown>
            if (typeof rec.CommandLine === 'string' && typeof rec.Name === 'string') {
              out.push({ name: rec.Name, commandLine: rec.CommandLine })
            }
          }
        }
        resolve(out)
      } catch {
        resolve([])
      }
    })
  })
}

/** Extract `csrf_token=<hex>` style argument from a command line. */
export function extractCsrfToken(commandLine: string): string | null {
  const match = commandLine.match(/csrf_token[= ]+([0-9a-fA-F]{8,})/)
  return match?.[1] ?? null
}

/** Find a CSRF token from any running language server process command line. */
export async function discoverCsrfToken(): Promise<string | null> {
  if (process.platform !== 'win32') return null
  const processes = await listWindowsProcessCommandLines('language_server')
  for (const proc of processes) {
    const token = extractCsrfToken(proc.commandLine)
    if (token) return token
  }
  return null
}
