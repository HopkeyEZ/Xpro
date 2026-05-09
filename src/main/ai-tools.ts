import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { BrowserWindow } from 'electron';

const execAsync = promisify(exec);

/** Send text to the renderer terminal panel */
function sendToTerminal(text: string) {
  try {
    const wins = BrowserWindow.getAllWindows();
    if (wins.length === 0) {
      console.log('[sendToTerminal] No windows found');
      return;
    }
    const win = wins[0];
    if (win.isDestroyed()) {
      console.log('[sendToTerminal] Window is destroyed');
      return;
    }
    win.webContents.send('shell:data', text);
  } catch (err) {
    console.error('[sendToTerminal] Error:', err);
  }
}

// ==================== Background Process Tracking ====================
const backgroundProcesses: Map<number, { command: string; startedAt: number; child: any }> = new Map();

function trackBackground(pid: number, command: string, child: any) {
  backgroundProcesses.set(pid, { command, startedAt: Date.now(), child });
  console.log(`[BG] Tracking PID ${pid}: ${command}`);
}

function killBackgroundProcess(pid: number): boolean {
  const cp = require('child_process');
  const entry = backgroundProcesses.get(pid);

  // Collect ALL PIDs in the process tree (parent + children + grandchildren)
  // This handles Flask debug mode where reloader spawns a child that holds the port
  const allPids = new Set<number>([pid]);
  try {
    const out = cp.execSync(
      `wmic process where (ParentProcessId=${pid}) get ProcessId /format:list`,
      { windowsHide: true, timeout: 3000, encoding: 'utf-8' }
    );
    for (const m of out.matchAll(/ProcessId=(\d+)/g)) {
      const childPid = parseInt(m[1]);
      allPids.add(childPid);
      // Also find grandchildren
      try {
        const out2 = cp.execSync(
          `wmic process where (ParentProcessId=${childPid}) get ProcessId /format:list`,
          { windowsHide: true, timeout: 3000, encoding: 'utf-8' }
        );
        for (const m2 of out2.matchAll(/ProcessId=(\d+)/g)) {
          allPids.add(parseInt(m2[1]));
        }
      } catch {}
    }
  } catch {}

  if (entry) {
    try { entry.child.stdout?.destroy(); } catch {}
    try { entry.child.stderr?.destroy(); } catch {}
    try { entry.child.kill(); } catch {}
    backgroundProcesses.delete(pid);
  }

  // Kill every PID in the tree: graceful first, then force
  for (const p of allPids) {
    try { cp.execSync(`taskkill /PID ${p}`, { windowsHide: true, timeout: 3000, stdio: 'ignore' }); } catch {}
  }
  // Wait a moment for socket cleanup, then force kill any survivors
  try {
    const pidArgs = [...allPids].map(p => `/PID ${p}`).join(' ');
    cp.execSync(`ping -n 2 127.0.0.1 >nul & taskkill /F ${pidArgs}`,
      { windowsHide: true, timeout: 5000, stdio: 'ignore', shell: 'cmd.exe' });
  } catch {}

  const label = entry ? entry.command.substring(0, 80) : `PID ${pid}`;
  sendToTerminal(`\x1b[33m[BG] Killed process tree (${allPids.size} PIDs): ${label}\x1b[0m\n`);
  return true;
}

// ==================== Project Root ====================
let projectRoot = '';

export function setProjectRoot(root: string) {
  projectRoot = root;
}

export function getProjectRoot(): string {
  return projectRoot;
}

// ==================== Tool Definitions ====================

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, any>; // JSON Schema
}

// OpenAI format
export function getOpenAITools(): Array<{ type: 'function'; function: { name: string; description: string; parameters: Record<string, any> } }> {
  return TOOLS.map(t => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

// Anthropic format
export function getAnthropicTools(): Array<{ name: string; description: string; input_schema: Record<string, any> }> {
  return TOOLS.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }));
}

const TOOLS: ToolDef[] = [
  {
    name: 'read_file',
    description: [
      'Read the contents of a file at the given absolute path. Returns file text.',
      'Usage notes:',
      '- ALWAYS use this to read a file before editing it with edit_file.',
      '- Max file size: 1MB. Binary files will be rejected.',
      '- Use this to verify edits after making changes when uncertain.',
      '- For large files, consider using search_text first to find relevant sections.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file to read' },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'write_file',
    description: [
      'Create or overwrite a file with the given content. Creates parent directories automatically.',
      'Usage notes:',
      '- Use this ONLY for creating new files or fully rewriting existing ones.',
      '- For small changes to existing files, prefer edit_file instead.',
      '- You must provide the COMPLETE file content — partial content will corrupt the file.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file to write' },
        content: { type: 'string', description: 'The complete content to write to the file' },
      },
      required: ['file_path', 'content'],
    },
  },
  {
    name: 'edit_file',
    description: [
      'Perform a surgical find-and-replace edit in an existing file.',
      'Usage notes:',
      '- old_text must match EXACTLY (including whitespace, indentation, and newlines).',
      '- ALWAYS read the file first with read_file to get the exact text to replace.',
      '- old_text must be unique in the file. If it matches multiple locations, include more surrounding context to make it unique.',
      '- Keep edits minimal and focused — change only what is necessary.',
      '- Preserve existing code style and indentation.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file to edit' },
        old_text: { type: 'string', description: 'The exact text to find in the file (must be unique)' },
        new_text: { type: 'string', description: 'The replacement text' },
      },
      required: ['file_path', 'old_text', 'new_text'],
    },
  },
  {
    name: 'list_directory',
    description: [
      'List files and subdirectories in a directory. Returns names, types, and sizes.',
      'Usage notes:',
      '- Use this to explore project structure before assuming file paths.',
      '- Set recursive=true to see nested structure (max 3 levels, 200 entries).',
      '- Use this before read_file or edit_file if you are unsure about file locations.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        dir_path: { type: 'string', description: 'Absolute path to the directory' },
        recursive: { type: 'boolean', description: 'If true, list recursively (max 3 levels deep). Default: false' },
      },
      required: ['dir_path'],
    },
  },
  {
    name: 'search_text',
    description: [
      'Search for a text pattern (regex) in files within a directory. Returns file:line matches.',
      'Usage notes:',
      '- Use this to find where functions, variables, or strings are defined/used.',
      '- Skips node_modules, .git, dist, __pycache__ automatically.',
      '- Max 50 matches returned. Use file_pattern to narrow scope (e.g. "*.ts").',
      '- Prefer this over reading multiple files when looking for specific code.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        dir_path: { type: 'string', description: 'Directory to search in' },
        pattern: { type: 'string', description: 'Search pattern (regex supported)' },
        file_pattern: { type: 'string', description: 'Glob pattern to filter files, e.g. "*.ts". Default: all files' },
      },
      required: ['dir_path', 'pattern'],
    },
  },
  {
    name: 'sub_agent',
    description: [
      'Launch a focused sub-agent to perform a specific task autonomously.',
      'Multiple sub_agent calls in the SAME response run in PARALLEL — use this to speed up work.',
      'Usage notes:',
      '- Each sub-agent has full access to all tools (read_file, write_file, run_command, etc.).',
      '- Use for: exploring multiple files/dirs simultaneously, parallel analysis, concurrent checks.',
      '- Each sub-agent works independently and returns a summary of its findings/actions.',
      '- Give each sub-agent a clear, focused task description.',
      '- Sub-agents cannot launch their own sub-agents (no nesting).',
      '- Example: call 3 sub_agents to explore src/, tests/, and docs/ in parallel.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Clear, focused description of what this sub-agent should accomplish' },
      },
      required: ['task'],
    },
  },
  {
    name: 'run_command',
    description: [
      'Execute a command directly inside PowerShell and return stdout/stderr.',
      'CRITICAL: Commands run DIRECTLY in PowerShell. Do NOT prefix with "powershell" or wrap in quotes.',
      'Usage notes:',
      '- Use PowerShell syntax. Aliases work: ls, cat, cp, mv, rm, curl, echo, mkdir.',
      '- WRONG: powershell -Command "Get-Process"  (nested PowerShell = broken quotes)',
      '- RIGHT: Get-Process  (direct command)',
      '- Kill port: netstat -aon | findstr :PORT  then  taskkill /F /PID <pid>',
      '- Long-running processes (servers): output returned after 8s idle, process keeps running in background.',
      '- Hard timeout: 120s. Only killed on hard timeout.',
      '- cwd defaults to the project root if not specified.',
      '- Do NOT use for file read/write/edit — use dedicated tools.',
      '- Output is synced to the IDE terminal panel in real-time.',
      '- NEVER use Start-Process to launch commands. It opens an external window and breaks the IDE terminal integration.',
      '- To start multiple servers: run each one in a separate run_command call. Each will auto-background after 8s idle.',
      '- Example: first call run_command("python app.py"), wait for it to background, then call run_command("npm run dev").',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command to execute' },
        cwd: { type: 'string', description: 'Working directory for the command. Default: project root' },
      },
      required: ['command'],
    },
  },
  {
    name: 'kill_process',
    description: [
      'Kill a background process or list all tracked background processes.',
      '- Use pid to kill a specific process (graceful then force kill).',
      '- Use action="list" to see all running background processes with their PIDs.',
      '- Background processes are tracked automatically when a command goes idle (servers, etc.).',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        pid: { type: 'number', description: 'PID of the process to kill. Get it from the idle message or use action=list.' },
        action: { type: 'string', description: 'Set to "list" to list all background processes instead of killing.' },
      },
    },
  },
];

// ==================== Tool Executor ====================

export async function executeTool(name: string, args: Record<string, any>): Promise<{ ok: boolean; result: string }> {
  try {
    switch (name) {
      case 'read_file':
        return await execReadFile(args.file_path);
      case 'write_file':
        return await execWriteFile(args.file_path, args.content);
      case 'edit_file':
        return await execEditFile(args.file_path, args.old_text, args.new_text);
      case 'list_directory':
        return await execListDir(args.dir_path, args.recursive);
      case 'search_text':
        return await execSearchText(args.dir_path, args.pattern, args.file_pattern);
      case 'run_command':
        return await execRunCommand(args.command, args.cwd || projectRoot);
      case 'kill_process':
        return execKillProcess(args.pid, args.action);
      default:
        return { ok: false, result: `Unknown tool: ${name}` };
    }
  } catch (err: any) {
    return { ok: false, result: `Tool error: ${err.message}` };
  }
}

async function execReadFile(filePath: string): Promise<{ ok: boolean; result: string }> {
  if (!filePath) return { ok: false, result: 'file_path is required' };
  try { await fsp.access(filePath); } catch { return { ok: false, result: `File not found: ${filePath}` }; }

  const stat = await fsp.stat(filePath);
  if (stat.size > 1024 * 1024) return { ok: false, result: `File too large: ${(stat.size / 1024).toFixed(0)}KB (max 1MB)` };

  const buf = await fsp.readFile(filePath);
  const check = buf.subarray(0, Math.min(buf.length, 8192));
  if (check.includes(0)) return { ok: false, result: 'Binary file cannot be read as text' };

  return { ok: true, result: buf.toString('utf-8') };
}

/** Notify renderer of a file change (for checkpoint + lint integration) */
function notifyFileChange(toolName: string, filePath: string, oldContent: string, newContent: string) {
  try {
    const wins = BrowserWindow.getAllWindows();
    if (wins.length > 0 && !wins[0].isDestroyed()) {
      wins[0].webContents.send('ai:fileChanged', { toolName, filePath, oldContent, newContent });
    }
  } catch (e) {
    console.warn('[notifyFileChange]', e);
  }
}

async function execWriteFile(filePath: string, content: string): Promise<{ ok: boolean; result: string }> {
  if (!filePath) return { ok: false, result: 'file_path is required' };
  if (content === undefined || content === null) return { ok: false, result: 'content is required' };

  // Read existing content for checkpoint (if file exists)
  let oldContent = '';
  try { oldContent = await fsp.readFile(filePath, 'utf-8'); } catch { /* new file */ }

  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, content, 'utf-8');

  notifyFileChange('write_file', filePath, oldContent, content);
  return { ok: true, result: `File written: ${filePath} (${content.length} chars)` };
}

async function execEditFile(filePath: string, oldText: string, newText: string): Promise<{ ok: boolean; result: string }> {
  if (!filePath || oldText === undefined) return { ok: false, result: 'file_path and old_text are required' };
  try { await fsp.access(filePath); } catch { return { ok: false, result: `File not found: ${filePath}` }; }

  const content = await fsp.readFile(filePath, 'utf-8');
  if (!content.includes(oldText)) {
    return { ok: false, result: `old_text not found in file. File length: ${content.length} chars` };
  }

  const count = content.split(oldText).length - 1;
  if (count > 1) {
    return { ok: false, result: `old_text matches ${count} locations. Please provide more unique text.` };
  }

  const updated = content.replace(oldText, newText);
  await fsp.writeFile(filePath, updated, 'utf-8');

  notifyFileChange('edit_file', filePath, content, updated);
  return { ok: true, result: `Edit applied: ${filePath} (replaced ${oldText.length} chars → ${newText.length} chars)` };
}

async function execListDir(dirPath: string, recursive?: boolean): Promise<{ ok: boolean; result: string }> {
  if (!dirPath) return { ok: false, result: 'dir_path is required' };
  try { await fsp.access(dirPath); } catch { return { ok: false, result: `Directory not found: ${dirPath}` }; }

  const entries: string[] = [];
  const maxEntries = 200;

  async function walk(dir: string, depth: number) {
    if (entries.length >= maxEntries) return;
    const items = await fsp.readdir(dir, { withFileTypes: true });
    for (const item of items) {
      if (entries.length >= maxEntries) break;
      const fullPath = path.join(dir, item.name);
      const rel = path.relative(dirPath, fullPath);
      if (item.isDirectory()) {
        entries.push(`[DIR]  ${rel}/`);
        if (recursive && depth < 3) await walk(fullPath, depth + 1);
      } else {
        try {
          const stat = await fsp.stat(fullPath);
          const sizeKB = (stat.size / 1024).toFixed(1);
          entries.push(`[FILE] ${rel} (${sizeKB}KB)`);
        } catch {
          entries.push(`[FILE] ${rel}`);
        }
      }
    }
  }

  await walk(dirPath, 0);
  const suffix = entries.length >= maxEntries ? `\n... (truncated at ${maxEntries} entries)` : '';
  return { ok: true, result: entries.join('\n') + suffix };
}

async function execSearchText(dirPath: string, pattern: string, filePattern?: string): Promise<{ ok: boolean; result: string }> {
  if (!dirPath || !pattern) return { ok: false, result: 'dir_path and pattern are required' };
  try { await fsp.access(dirPath); } catch { return { ok: false, result: `Directory not found: ${dirPath}` }; }

  const regex = new RegExp(pattern, 'gi');
  const matches: string[] = [];
  const maxMatches = 50;

  async function searchDir(dir: string, depth: number) {
    if (matches.length >= maxMatches || depth > 5) return;
    let items: fs.Dirent[];
    try { items = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }

    for (const item of items) {
      if (matches.length >= maxMatches) break;
      const fullPath = path.join(dir, item.name);

      // Skip common non-useful dirs
      if (item.isDirectory()) {
        if (['node_modules', '.git', 'dist', '.next', '__pycache__'].includes(item.name)) continue;
        await searchDir(fullPath, depth + 1);
        continue;
      }

      // File filter
      if (filePattern) {
        const glob = filePattern.replace('*', '');
        if (!item.name.endsWith(glob) && !item.name.includes(glob)) continue;
      }

      try {
        const stat = await fsp.stat(fullPath);
        if (stat.size > 512 * 1024) continue; // skip large files
        const content = await fsp.readFile(fullPath, 'utf-8');
        const lines = content.split('\n');
        for (let i = 0; i < lines.length && matches.length < maxMatches; i++) {
          if (regex.test(lines[i])) {
            const rel = path.relative(dirPath, fullPath);
            matches.push(`${rel}:${i + 1}: ${lines[i].trim().substring(0, 200)}`);
          }
          regex.lastIndex = 0;
        }
      } catch { /* skip unreadable */ }
    }
  }

  await searchDir(dirPath, 0);
  if (matches.length === 0) return { ok: true, result: 'No matches found.' };
  const suffix = matches.length >= maxMatches ? `\n... (truncated at ${maxMatches} matches)` : '';
  return { ok: true, result: matches.join('\n') + suffix };
}

function execKillProcess(pid?: number, action?: string): { ok: boolean; result: string } {
  if (action === 'list') {
    if (backgroundProcesses.size === 0) {
      return { ok: true, result: 'No background processes running.' };
    }
    const lines: string[] = [];
    for (const [p, info] of backgroundProcesses) {
      const age = Math.round((Date.now() - info.startedAt) / 1000);
      lines.push(`PID=${p}  age=${age}s  cmd=${info.command.substring(0, 100)}`);
    }
    return { ok: true, result: lines.join('\n') };
  }

  if (!pid) {
    // Kill all background processes
    if (backgroundProcesses.size === 0) {
      return { ok: true, result: 'No background processes to kill.' };
    }
    const killed: number[] = [];
    for (const p of [...backgroundProcesses.keys()]) {
      killBackgroundProcess(p);
      killed.push(p);
    }
    return { ok: true, result: `Killed ${killed.length} background process(es): ${killed.join(', ')}` };
  }

  const ok = killBackgroundProcess(pid);
  return ok
    ? { ok: true, result: `Killed process PID=${pid}` }
    : { ok: false, result: `Could not kill PID=${pid} (not found or access denied)` };
}

async function execRunCommand(command: string, cwd?: string): Promise<{ ok: boolean; result: string }> {
  if (!command) return { ok: false, result: 'command is required' };

  // Block Start-Process — it opens external windows and breaks IDE terminal integration
  if (/^\s*Start-Process\s/i.test(command)) {
    return {
      ok: false,
      result: 'ERROR: Start-Process is forbidden. It opens an external window and breaks IDE terminal.\n'
        + 'Run the command DIRECTLY instead. For servers, just call run_command("python app.py") — it will auto-background after 8s idle.\n'
        + 'To start multiple servers, use SEPARATE run_command calls, one for each server.',
    };
  }

  const HARD_TIMEOUT = 120_000;  // 120s absolute safety net
  const IDLE_TIMEOUT = 8_000;    // 8s no output = long-running, return early
  const MAX_OUTPUT = 1024 * 512; // 512KB

  const decodeBuffer = (buf: Buffer): string => {
    const text = buf.toString('utf-8');
    if (!text.includes('\ufffd')) return text;
    try { return new (require('util').TextDecoder)('gbk').decode(buf); } catch { return text; }
  };

  // Graceful-first kill: SIGTERM → wait → force kill /F /T
  // Giving the process time to close sockets prevents zombie port handles on Windows
  const killTree = (child: any) => {
    try { child.stdout?.destroy(); } catch {}
    try { child.stderr?.destroy(); } catch {}
    if (child.pid) {
      // Step 1: graceful kill (no /F) — lets process close sockets
      try {
        require('child_process').execSync(`taskkill /T /PID ${child.pid}`, {
          windowsHide: true, timeout: 3000, stdio: 'ignore',
        });
      } catch {}
      // Step 2: wait 1s for socket cleanup, then force kill
      try {
        require('child_process').execSync(
          `ping -n 2 127.0.0.1 >nul & taskkill /F /T /PID ${child.pid}`,
          { windowsHide: true, timeout: 5000, stdio: 'ignore', shell: 'cmd.exe' },
        );
      } catch {}
    }
    try { child.kill(); } catch {}
  };

  const workDir = cwd || projectRoot || process.cwd();
  sendToTerminal(`\n\x1b[36m> ${command}\x1b[0m\n`);

  return new Promise((resolve) => {
    // stdin: 'ignore' — prevents hanging (opencode pattern)
    const child = require('child_process').spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', command],
      { cwd: workDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' } },
    );

    const stdoutBufs: Buffer[] = [];
    const stderrBufs: Buffer[] = [];
    let done = false;
    let killed = false;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;

    const collectOutput = (): string => {
      const out = decodeBuffer(Buffer.concat(stdoutBufs));
      const err = decodeBuffer(Buffer.concat(stderrBufs));
      return (out + (err ? '\n' + err : '')).trim();
    };

    const finish = (ok: boolean, result: string) => {
      if (done) return;
      done = true;
      clearTimeout(hardTimer);
      if (idleTimer) clearTimeout(idleTimer);
      if (!ok) sendToTerminal(`\x1b[31m[ERROR] ${result.split('\n')[0]}\x1b[0m\n`);
      resolve({ ok, result: result.slice(0, MAX_OUTPUT) || '(no output)' });
    };

    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (done) return;
        // DON'T kill the process — let it run in background (e.g. servers)
        // Just return collected output so the AI can continue
        // Track the background process so it can be killed later
        if (child.pid) trackBackground(child.pid, command, child);
        sendToTerminal(`\x1b[33m[idle ${IDLE_TIMEOUT / 1000}s, process running in background, PID=${child.pid}]\x1b[0m\n`);
        finish(true, collectOutput() + `\n(process running in background, PID=${child.pid})`);
      }, IDLE_TIMEOUT);
    };

    child.stdout?.on('data', (d: Buffer) => {
      stdoutBufs.push(d);
      sendToTerminal(decodeBuffer(d));
      resetIdleTimer();
    });

    child.stderr?.on('data', (d: Buffer) => {
      stderrBufs.push(d);
      sendToTerminal(`\x1b[31m${decodeBuffer(d)}\x1b[0m`);
      resetIdleTimer();
    });

    // KEY FIX from opencode: use 'exit' instead of 'close'
    // 'close' waits for ALL stdio to close — hangs when child spawns background processes
    // 'exit' fires as soon as the process terminates, regardless of pipe state
    child.on('exit', (code: number | null) => {
      // Destroy remaining stdio to prevent pipe leaks
      try { child.stdout?.destroy(); } catch {}
      try { child.stderr?.destroy(); } catch {}
      const output = collectOutput();
      if (killed) {
        finish(true, output + '\n(command timed out)');
      } else if (code === 0 || code === null) {
        finish(true, output);
      } else {
        finish(false, `Exit code: ${code}\n${output}`.trim());
      }
    });

    child.on('error', (err: Error) => {
      sendToTerminal(`\x1b[31m[SPAWN ERROR] ${err.message}\x1b[0m\n`);
      finish(false, `Spawn error: ${err.message}`);
    });

    // Hard timeout: absolute safety net — kill only on hard timeout
    const hardTimer = setTimeout(() => {
      if (done) return;
      killed = true;
      sendToTerminal(`\x1b[33m[TIMEOUT ${HARD_TIMEOUT / 1000}s] killing process\x1b[0m\n`);
      killTree(child);
      setTimeout(() => finish(true, collectOutput() + '\n(killed after timeout)'), 1000);
    }, HARD_TIMEOUT);
  });
}
