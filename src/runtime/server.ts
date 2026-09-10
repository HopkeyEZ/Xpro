/**
 * The long-lived form of the process.
 *
 * `xpro run` is one turn and exits; this keeps agents alive behind an HTTP
 * socket so a backend, a queue worker or another service can drive them. Same
 * loop, same tools, same policy — only the transport differs.
 *
 * Endpoints:
 *   GET  /health                      liveness + config summary
 *   POST /sessions                    {root?, mode?, system?} → {id}
 *   POST /sessions/:id/messages       {input} → SSE stream of loop events
 *   DELETE /sessions/:id              drop the session
 *
 * Node's http module only — the runtime stays dependency-free like the core.
 */

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { Agent } from '../framework';
import type { LoopEvent } from '../framework/orchestration';
import type { PermissionMode } from '../framework/policy';
import type { RuntimeConfig } from './cli';

export interface ServeOptions {
  port: number;
  cfg: RuntimeConfig;
  /** injected so tests can serve fake agents; defaults to the real runtime agent */
  createAgent?: (cfg: RuntimeConfig, overrides: Partial<RuntimeConfig>) => Agent;
}

interface Held {
  agent: Agent;
  root: string;
  /** one turn at a time per session — the loop mutates shared history */
  busy: boolean;
  createdAt: number;
}

const readBody = (req: http.IncomingMessage): Promise<any> =>
  new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 4 << 20) reject(new Error('body too large'));
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });

function json(res: http.ServerResponse, code: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) });
  res.end(s);
}

export async function serve(opts: ServeOptions): Promise<number> {
  // Imported lazily to keep cli.ts ↔ server.ts from forming a load-time cycle.
  const { createRuntimeAgent } = await import('./cli');
  const make = opts.createAgent ?? createRuntimeAgent;
  const sessions = new Map<string, Held>();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);
    const method = req.method ?? 'GET';

    try {
      if (method === 'GET' && url.pathname === '/health') {
        return json(res, 200, {
          ok: true,
          model: opts.cfg.model,
          provider: opts.cfg.provider,
          mode: opts.cfg.mode,
          root: opts.cfg.root,
          sessions: sessions.size,
          hasApiKey: Boolean(opts.cfg.apiKey),
        });
      }

      if (method === 'POST' && url.pathname === '/sessions') {
        const body = await readBody(req);
        const root = String(body.root ?? opts.cfg.root);
        const mode = (body.mode as PermissionMode) ?? opts.cfg.mode;
        const id = randomUUID();
        sessions.set(id, { agent: make(opts.cfg, { root, mode }), root, busy: false, createdAt: Date.now() });
        return json(res, 201, { id, root, mode });
      }

      if (parts[0] === 'sessions' && parts[1]) {
        const held = sessions.get(parts[1]);
        if (!held) return json(res, 404, { error: 'no such session' });

        if (method === 'DELETE' && parts.length === 2) {
          sessions.delete(parts[1]);
          return json(res, 200, { deleted: parts[1] });
        }

        if (method === 'POST' && parts[2] === 'messages') {
          if (held.busy) return json(res, 409, { error: 'session is already running a turn' });
          const body = await readBody(req);
          const input = String(body.input ?? '');
          if (!input) return json(res, 400, { error: 'input is required' });

          // Stream events as they happen: an agent turn can run for minutes and
          // a caller that only sees the final text has no way to show progress
          // or to notice it wedged.
          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
          });
          const send = (e: LoopEvent | Record<string, unknown>) =>
            res.write(`data: ${JSON.stringify(e)}\n\n`);

          held.busy = true;
          try {
            const result = await held.agent.run(input, { onEvent: send });
            send({ type: 'result', ...result });
          } catch (err: any) {
            send({ type: 'error', error: err?.message ?? String(err) });
          } finally {
            held.busy = false;
            res.end();
          }
          return;
        }
      }

      json(res, 404, { error: 'not found' });
    } catch (err: any) {
      // Headers may already be out on the SSE path; only answer if they aren't.
      if (!res.headersSent) json(res, 400, { error: err?.message ?? String(err) });
      else res.end();
    }
  });

  await new Promise<void>((resolve) => server.listen(opts.port, resolve));
  process.stderr.write(
    `xpro serve → http://localhost:${opts.port}  (${opts.cfg.provider}/${opts.cfg.model}, root ${opts.cfg.root})\n`,
  );

  // Resolve only when the socket closes, so the CLI keeps the process alive.
  await new Promise<void>((resolve) => {
    const stop = () => server.close(() => resolve());
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
  return 0;
}
