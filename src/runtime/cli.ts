#!/usr/bin/env node
/**
 * xpro — the runnable process.
 *
 *   xpro run "add tests for the parser"     one task, headless, exit when done
 *   xpro eval suite.json                    N rollouts per prompt, scored, report
 *   xpro serve --port 8787                  long-lived HTTP process
 *
 * Same core in all three. `run` is the loop once, `serve` is the loop behind a
 * socket, `eval` is the loop many times with the diff graded afterwards — which
 * is the only one that tells you whether the other two are any good.
 *
 * Config comes from the environment so the process can be containerised:
 *   XPRO_PROVIDER   openai | anthropic       (default: anthropic)
 *   XPRO_BASE_URL   API base
 *   XPRO_API_KEY    key (falls back to OPENAI_API_KEY / ANTHROPIC_API_KEY)
 *   XPRO_MODEL      model id
 *   XPRO_MODE       default | acceptEdits | plan | bypass
 *   XPRO_ROOT       workspace root (default: cwd)
 */

import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createAgent, type Agent } from '../framework';
import {
  runEvaluation,
  createGitWorkspace,
  llmJudge,
  formatReport,
  type EvalSuite,
} from '../framework/eval';
import type { PermissionMode } from '../framework/policy';
import { createToolset } from './tools';
import { serve } from './server';

const exec = (cmd: string, args: string[], cwd: string): Promise<string> =>
  new Promise((resolve, reject) =>
    execFile(cmd, args, { cwd, maxBuffer: 32 << 20 }, (err, stdout) =>
      err ? reject(err) : resolve(stdout),
    ),
  );

export interface RuntimeConfig {
  provider: 'openai' | 'anthropic';
  baseUrl: string;
  apiKey: string;
  model: string;
  mode: PermissionMode;
  root: string;
}

export function configFromEnv(env = process.env): RuntimeConfig {
  const provider = (env.XPRO_PROVIDER as 'openai' | 'anthropic') ?? 'anthropic';
  const defaultBase =
    provider === 'openai' ? 'https://api.openai.com/v1' : 'https://api.anthropic.com';
  return {
    provider,
    baseUrl: env.XPRO_BASE_URL ?? defaultBase,
    apiKey: env.XPRO_API_KEY ?? env.ANTHROPIC_API_KEY ?? env.OPENAI_API_KEY ?? '',
    model: env.XPRO_MODEL ?? (provider === 'openai' ? 'gpt-4o' : 'claude-sonnet-4'),
    mode: (env.XPRO_MODE as PermissionMode) ?? 'acceptEdits',
    root: path.resolve(env.XPRO_ROOT ?? process.cwd()),
  };
}

/** One agent wired to the headless toolset, pointed at `root`. */
export function createRuntimeAgent(cfg: RuntimeConfig, overrides: Partial<RuntimeConfig> = {}): Agent {
  const c = { ...cfg, ...overrides };
  return createAgent({
    provider: c.provider,
    baseUrl: c.baseUrl,
    apiKey: c.apiKey,
    model: c.model,
    mode: c.mode,
    tools: createToolset({ root: c.root }),
    toolContext: { root: c.root },
  });
}

async function cmdRun(task: string, cfg: RuntimeConfig): Promise<number> {
  if (!task) {
    console.error('usage: xpro run "<task>"');
    return 1;
  }
  const agent = createRuntimeAgent(cfg);
  const result = await agent.run(task, {
    onEvent: (e) => {
      if (e.type === 'tool_call') process.stderr.write(`· ${e.toolName}\n`);
      if (e.type === 'error') process.stderr.write(`! ${e.error}\n`);
    },
  });
  process.stdout.write(result.finalText + '\n');
  // Non-zero when the loop didn't finish cleanly, so CI can gate on it.
  return result.stopped === 'end_turn' ? 0 : 1;
}

async function cmdEval(suitePath: string, cfg: RuntimeConfig, argv: string[]): Promise<number> {
  if (!suitePath) {
    console.error('usage: xpro eval <suite.json> [--rollouts N] [--out report.md]');
    return 1;
  }
  const suite = JSON.parse(readFileSync(suitePath, 'utf8')) as EvalSuite;
  const rollouts = Number(flag(argv, '--rollouts') ?? 2);
  const out = flag(argv, '--out') ?? 'eval-report.md';

  // The judge is read-only on purpose: a grader that can edit the repo can
  // "fix" what it is grading.
  const judge = createRuntimeAgent(cfg, { mode: 'plan' });

  const report = await runEvaluation({
    suite,
    workspace: createGitWorkspace({ root: cfg.root, exec }),
    rollouts,
    // A fresh agent per rollout — sharing one would carry the first attempt's
    // context into the second and stop them being independent samples.
    createAgent: () => createRuntimeAgent(cfg),
    scorer: llmJudge({ judge, max: 5 }),
    onRollout: (r) =>
      process.stderr.write(
        `${r.caseId} #${r.index} → ${r.score}/5 (${r.rounds} rounds, ${r.stopped})\n`,
      ),
  });

  const md = formatReport(report);
  writeFileSync(out, md, 'utf8');
  process.stdout.write(`${md}\n\nreport → ${out}\n`);
  return 0;
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const [cmd, ...rest] = argv;
  const cfg = configFromEnv();

  if (!cmd || cmd === '--help' || cmd === '-h') {
    process.stdout.write(
      [
        'xpro — runnable multi-agent process',
        '',
        '  xpro run "<task>"                 run one task to completion',
        '  xpro eval <suite.json>            score the agent over repeated rollouts',
        '  xpro serve [--port 8787]          long-lived HTTP process',
        '',
        'env: XPRO_PROVIDER XPRO_BASE_URL XPRO_API_KEY XPRO_MODEL XPRO_MODE XPRO_ROOT',
        '',
      ].join('\n'),
    );
    return 0;
  }

  if (!cfg.apiKey && cmd !== 'serve') {
    console.error('no API key: set XPRO_API_KEY (or ANTHROPIC_API_KEY / OPENAI_API_KEY)');
    return 1;
  }

  switch (cmd) {
    case 'run':
      return cmdRun(rest.join(' '), cfg);
    case 'eval':
      return cmdEval(rest[0], cfg, rest);
    case 'serve':
      return serve({ port: Number(flag(rest, '--port') ?? 8787), cfg });
    default:
      console.error(`unknown command: ${cmd}`);
      return 1;
  }
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err?.stack ?? String(err));
      process.exit(1);
    },
  );
}
