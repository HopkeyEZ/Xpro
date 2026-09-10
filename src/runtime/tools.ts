/**
 * Headless toolset — the standard hands for a server-side agent.
 *
 * The IDE's tools talk to Electron (approval dialogs over IPC, terminal output
 * through webContents). A process running on a server has none of that, so
 * these are rebuilt against nothing but Node: fs, child_process, path.
 *
 * Two properties matter more here than in a desktop app, because nobody is
 * watching the screen:
 *
 *   1. Every path is confined to `root`. A model that talks itself into
 *      `../../../../etc/passwd` gets an error, not a file. Confinement is
 *      checked after resolution, so `..` and symlink-ish tricks can't slip past.
 *   2. Approval stays in the policy layer, not in here. These tools declare
 *      `mutates: true` and let the engine decide; that keeps one gate to audit
 *      instead of a per-tool patchwork.
 */

import { promises as fsp } from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { defineTool, type Tool, type ToolContext } from '../framework/tools';

export interface ToolsetOptions {
  /** everything the agent may touch lives under here */
  root: string;
  /** hard cap on command runtime; a hung build shouldn't hang the process */
  commandTimeoutMs?: number;
  /** truncate oversized reads/outputs instead of blowing up the context window */
  maxBytes?: number;
  /** commands the agent may never run, matched on the executable name */
  denyCommands?: string[];
}

const DEFAULT_DENY = ['shutdown', 'reboot', 'mkfs', 'fdisk', 'dd'];

/**
 * Resolve `rel` under `root`, refusing anything that escapes.
 * Returns an absolute path or throws — callers never see a path they
 * didn't ask for.
 */
function resolveInRoot(root: string, rel: string): string {
  const abs = path.resolve(root, rel);
  const rootAbs = path.resolve(root);
  const inside = abs === rootAbs || abs.startsWith(rootAbs + path.sep);
  if (!inside) throw new Error(`path escapes workspace root: ${rel}`);
  return abs;
}

function clip(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s;
  // Cut on a character boundary, then say so — silent truncation makes an
  // agent confidently reason about a file it only half saw.
  const buf = Buffer.from(s, 'utf8').subarray(0, maxBytes);
  return buf.toString('utf8') + `\n\n[truncated at ${maxBytes} bytes]`;
}

/** The standard toolset. Register with `createAgent({ tools: createToolset({ root }) })`. */
export function createToolset(opts: ToolsetOptions): Tool[] {
  const root = path.resolve(opts.root);
  const maxBytes = opts.maxBytes ?? 256 * 1024;
  const timeout = opts.commandTimeoutMs ?? 120_000;
  const deny = new Set([...DEFAULT_DENY, ...(opts.denyCommands ?? [])]);

  // ctx.root wins when set, so one toolset can serve several workspaces.
  const rootOf = (ctx: ToolContext) => path.resolve(ctx.root ?? root);

  return [
    defineTool({
      name: 'read_file',
      description: 'Read a UTF-8 text file inside the workspace.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'path relative to the workspace root' },
        },
        required: ['path'],
      },
      async handler({ path: rel }, ctx) {
        const abs = resolveInRoot(rootOf(ctx), String(rel));
        return clip(await fsp.readFile(abs, 'utf8'), maxBytes);
      },
    }),

    defineTool({
      name: 'write_file',
      description: 'Create or overwrite a file. Parent directories are created as needed.',
      mutates: true,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
      },
      async handler({ path: rel, content }, ctx) {
        const abs = resolveInRoot(rootOf(ctx), String(rel));
        await fsp.mkdir(path.dirname(abs), { recursive: true });
        await fsp.writeFile(abs, String(content), 'utf8');
        return `wrote ${rel} (${Buffer.byteLength(String(content))} bytes)`;
      },
    }),

    defineTool({
      name: 'edit_file',
      description:
        'Replace an exact string in a file. The old text must appear exactly once, ' +
        'so an ambiguous edit fails loudly instead of changing the wrong line.',
      mutates: true,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          old_text: { type: 'string' },
          new_text: { type: 'string' },
        },
        required: ['path', 'old_text', 'new_text'],
      },
      async handler({ path: rel, old_text, new_text }, ctx) {
        const abs = resolveInRoot(rootOf(ctx), String(rel));
        const before = await fsp.readFile(abs, 'utf8');
        const parts = before.split(String(old_text));
        if (parts.length === 1) throw new Error('old_text not found');
        if (parts.length > 2) throw new Error(`old_text matches ${parts.length - 1} times; make it unique`);
        await fsp.writeFile(abs, parts.join(String(new_text)), 'utf8');
        return `edited ${rel}`;
      },
    }),

    defineTool({
      name: 'list_directory',
      description: 'List entries in a directory, marking which are directories.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'defaults to the workspace root' } },
      },
      async handler({ path: rel }, ctx) {
        const abs = resolveInRoot(rootOf(ctx), String(rel ?? '.'));
        const entries = await fsp.readdir(abs, { withFileTypes: true });
        if (!entries.length) return '(empty)';
        return entries
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
          .sort()
          .join('\n');
      },
    }),

    defineTool({
      name: 'search_text',
      description:
        'Search file contents for a regular expression, returning path:line:text hits.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          path: { type: 'string', description: 'subdirectory to search, defaults to root' },
          max_results: { type: 'number' },
        },
        required: ['pattern'],
      },
      async handler({ pattern, path: rel, max_results }, ctx) {
        const base = resolveInRoot(rootOf(ctx), String(rel ?? '.'));
        const re = new RegExp(String(pattern));
        const limit = Number(max_results ?? 100);
        const hits: string[] = [];

        const walk = async (dir: string): Promise<void> => {
          if (hits.length >= limit) return;
          for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
            if (hits.length >= limit) return;
            // Skipping these isn't cosmetic: one node_modules walk buries the
            // real hits and burns the context window.
            if (e.isDirectory()) {
              if (['node_modules', '.git', 'dist', 'build', '.next'].includes(e.name)) continue;
              await walk(path.join(dir, e.name));
              continue;
            }
            const abs = path.join(dir, e.name);
            let text: string;
            try {
              text = await fsp.readFile(abs, 'utf8');
            } catch {
              continue; // binary or unreadable — not an error worth reporting
            }
            text.split('\n').forEach((line, i) => {
              if (hits.length < limit && re.test(line)) {
                hits.push(`${path.relative(rootOf(ctx), abs)}:${i + 1}:${line.trim().slice(0, 200)}`);
              }
            });
          }
        };

        await walk(base);
        return hits.length ? clip(hits.join('\n'), maxBytes) : 'no matches';
      },
    }),

    defineTool({
      name: 'run_command',
      description:
        'Run a shell command in the workspace and return its combined output. ' +
        'Use for builds, tests, git — anything the task actually needs verified.',
      mutates: true,
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'the executable, e.g. "npm"' },
          args: { type: 'array', items: { type: 'string' } },
        },
        required: ['command'],
      },
      async handler({ command, args }, ctx) {
        const cmd = String(command);
        if (deny.has(path.basename(cmd))) throw new Error(`command not allowed: ${cmd}`);
        const argv = Array.isArray(args) ? args.map(String) : [];
        const cwd = rootOf(ctx);

        return new Promise<string>((resolve) => {
          execFile(cmd, argv, { cwd, timeout, maxBuffer: 16 << 20 }, (err, stdout, stderr) => {
            const out = [stdout, stderr].filter(Boolean).join('\n').trim();
            // A failed command is information the agent needs, not an exception:
            // hand back the exit code and output so it can react.
            resolve(clip(err ? `exit ${(err as any).code ?? 1}\n${out}` : out || '(no output)', maxBytes));
          });
        });
      },
    }),
  ];
}
