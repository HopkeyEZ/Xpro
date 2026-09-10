/**
 * Eval layer — measuring what the agent actually *did*, not what it said.
 *
 * An agent that answers "I've fixed the bug and added tests" tells you nothing.
 * The only honest evidence is the diff it left on disk. So evaluation here is
 * built around three ideas:
 *
 *   1. Reproducible environment. Every rollout starts from the same pristine
 *      commit, so two runs differ because of the *agent*, not leftover state.
 *   2. Repeated rollouts. The same prompt is run N times independently. One
 *      run measures luck; the spread across runs measures reliability, which
 *      is what you actually ship on.
 *   3. Artifact-grounded scoring. The scorer sees the git diff, not the
 *      agent's self-report, and must write down a reason — so a score can be
 *      argued with instead of just trusted.
 *
 * Data is a three-level tree, mirroring how the runs actually nest:
 *
 *   EvalSuite (one environment)
 *     └── EvalCase (one prompt)
 *           └── RolloutRecord (one independent run: session, diff, score)
 *
 * Portability: the core framework depends on nothing but global `fetch`, and
 * this layer keeps that promise — running git is injected as an `exec`
 * function rather than imported, so the SDK still loads anywhere. A Node
 * adapter is three lines:
 *
 *   import { execFile } from 'node:child_process';
 *   const exec = (cmd, args, cwd) => new Promise((res, rej) =>
 *     execFile(cmd, args, { cwd, maxBuffer: 32 << 20 }, (e, out) => e ? rej(e) : res(out)));
 */

import type { RunResult } from '../orchestration';
import type { Agent } from '../index';

/** Runs a command and resolves with its stdout. Injected, never imported. */
export type Exec = (cmd: string, args: string[], cwd: string) => Promise<string>;

/**
 * The sandbox a rollout runs in. `reset()` puts it back to pristine, `diff()`
 * reports what the agent changed. Implement this over containers, VMs, or a
 * plain git checkout (see `createGitWorkspace`).
 */
export interface Workspace {
  /** absolute path the agent is pointed at */
  root: string;
  /** restore to the pristine baseline — called before every rollout */
  reset(): Promise<void>;
  /** the objective artifact: unified diff of everything the agent touched */
  diff(): Promise<string>;
}

export interface EvalCase {
  id: string;
  prompt: string;
  /**
   * Where the prompt came from. Repo-supplied tasks keep you honest (you
   * didn't write them to flatter the agent); authored ones let you probe
   * specific weaknesses. A suite wants both.
   */
  origin?: 'repo' | 'authored';
  tags?: string[];
  notes?: string;
}

export interface EvalSuite {
  /** stable id of the environment, e.g. the repo name */
  id: string;
  cases: EvalCase[];
  /** how the environment was built — recorded so a run can be reproduced */
  dockerfile?: string;
  commit?: string;
}

export interface RolloutRecord {
  caseId: string;
  /** which repetition, 0-based */
  index: number;
  sessionId: string;
  model: string;
  rounds: number;
  stopped: RunResult['stopped'];
  finalText: string;
  /** what actually changed on disk — the thing scoring is grounded in */
  diff: string;
  durationMs: number;
  score?: number;
  scoreReason?: string;
  error?: string;
}

export interface CaseReport {
  case: EvalCase;
  rollouts: RolloutRecord[];
  /** mean score across rollouts */
  mean: number;
  /**
   * Spread across rollouts of the *same* prompt in the *same* environment.
   * High spread means the agent is inconsistent — often more disqualifying
   * than a mediocre-but-steady mean, because you can't build on a coin flip.
   */
  stddev: number;
  /** how often the loop ended cleanly rather than hitting the round cap */
  completionRate: number;
}

export interface EvalReport {
  suiteId: string;
  model: string;
  startedAt: string;
  cases: CaseReport[];
  mean: number;
  /** mean of per-case stddev — one number for "how repeatable is this agent" */
  meanStddev: number;
}

/** Scores one rollout from its artifacts. Must justify itself. */
export type Scorer = (
  rollout: Omit<RolloutRecord, 'score' | 'scoreReason'>,
  evalCase: EvalCase,
) => Promise<{ score: number; reason: string }>;

/** Builds a *fresh* agent per rollout — a reused session leaks context between runs. */
export type AgentFactory = (ctx: { case: EvalCase; index: number; workspace: Workspace }) => Agent;

export interface EvalOptions {
  suite: EvalSuite;
  workspace: Workspace;
  /** must return a new Agent each call, or rollouts stop being independent */
  createAgent: AgentFactory;
  scorer: Scorer;
  /** independent runs per case; 1 measures luck, so the default is 2 */
  rollouts?: number;
  maxRounds?: number;
  signal?: AbortSignal;
  onRollout?: (r: RolloutRecord) => void;
}

/**
 * A git checkout as the workspace: reset with `checkout . && clean -fd`,
 * diff with `add -N` first so new files show up too (a plain `git diff`
 * silently ignores untracked files — an agent that creates a whole new module
 * would otherwise score as having done nothing).
 */
export function createGitWorkspace(opts: { root: string; exec: Exec; ref?: string }): Workspace {
  const { root, exec, ref = 'HEAD' } = opts;
  return {
    root,
    async reset() {
      await exec('git', ['checkout', '--force', ref, '--', '.'], root);
      await exec('git', ['clean', '-fd'], root);
    },
    async diff() {
      // Stage intent-to-add so untracked files appear in the diff, then diff
      // the working tree against the baseline ref.
      await exec('git', ['add', '-A', '-N'], root);
      return exec('git', ['diff', ref], root);
    },
  };
}

/**
 * Run the suite. Each rollout: reset → fresh agent → run → capture diff → score.
 *
 * Failures are recorded, never thrown: one crashed rollout is a data point
 * about the agent, not a reason to lose the other ninety.
 */
export async function runEvaluation(opts: EvalOptions): Promise<EvalReport> {
  const { suite, workspace, createAgent, scorer } = opts;
  const rollouts = opts.rollouts ?? 2;
  const startedAt = new Date().toISOString();
  const caseReports: CaseReport[] = [];
  let model = '';

  for (const c of suite.cases) {
    const records: RolloutRecord[] = [];

    for (let i = 0; i < rollouts; i++) {
      if (opts.signal?.aborted) break;

      const sessionId = newId();
      const started = Date.now();
      let record: RolloutRecord;

      try {
        await workspace.reset();
        const agent = createAgent({ case: c, index: i, workspace });
        model = agent.model.model;

        const result = await agent.run(c.prompt, {
          maxRounds: opts.maxRounds,
          signal: opts.signal,
          toolContext: { root: workspace.root },
        });
        const diff = await workspace.diff();

        record = {
          caseId: c.id,
          index: i,
          sessionId,
          model,
          rounds: result.rounds,
          stopped: result.stopped,
          finalText: result.finalText,
          diff,
          durationMs: Date.now() - started,
        };
      } catch (err: any) {
        records.push({
          caseId: c.id,
          index: i,
          sessionId,
          model,
          rounds: 0,
          stopped: 'error',
          finalText: '',
          diff: '',
          durationMs: Date.now() - started,
          score: 0,
          scoreReason: 'rollout crashed before producing an artifact',
          error: err?.message ?? String(err),
        });
        opts.onRollout?.(records[records.length - 1]);
        continue;
      }

      try {
        const { score, reason } = await scorer(record, c);
        record.score = score;
        record.scoreReason = reason;
      } catch (err: any) {
        record.score = 0;
        record.scoreReason = `scoring failed: ${err?.message ?? err}`;
      }

      records.push(record);
      opts.onRollout?.(record);
    }

    const scores = records.map((r) => r.score ?? 0);
    caseReports.push({
      case: c,
      rollouts: records,
      mean: mean(scores),
      stddev: stddev(scores),
      completionRate: records.length
        ? records.filter((r) => r.stopped === 'end_turn').length / records.length
        : 0,
    });
  }

  return {
    suiteId: suite.id,
    model,
    startedAt,
    cases: caseReports,
    mean: mean(caseReports.map((c) => c.mean)),
    meanStddev: mean(caseReports.map((c) => c.stddev)),
  };
}

/**
 * LLM-as-judge, built on the framework itself: a tool-less agent that sees the
 * prompt and the diff and must return `{score, reason}`.
 *
 * Deliberately shown the diff and *not* the agent's own summary — a model
 * grading another model's self-report grades prose, not work.
 */
export function llmJudge(opts: {
  judge: Agent;
  /** upper bound of the scale; scores are clamped into [0, max] */
  max?: number;
  /** what "good" means for this suite — the rubric the judge must apply */
  rubric?: string;
}): Scorer {
  const max = opts.max ?? 5;
  const rubric =
    opts.rubric ??
    [
      `Score 0-${max} on: does the diff actually accomplish the request,`,
      'is it correct and complete, does it avoid unrelated or destructive edits,',
      'and would a reviewer merge it as-is.',
      'An empty diff scores 0 regardless of what the agent claimed.',
    ].join(' ');

  return async (rollout, evalCase) => {
    const prompt = [
      'You are grading an autonomous coding agent. Judge only the diff.',
      '',
      `RUBRIC: ${rubric}`,
      '',
      `TASK GIVEN TO THE AGENT:\n${evalCase.prompt}`,
      '',
      `DIFF PRODUCED (empty means it changed nothing):\n${rollout.diff || '(empty)'}`,
      '',
      `Reply with JSON only: {"score": <0-${max}>, "reason": "<one or two sentences>"}`,
    ].join('\n');

    const { finalText } = await opts.judge.run(prompt);
    const parsed = parseJudgement(finalText, max);
    return parsed;
  };
}

/** Markdown summary — the three levels, flattened for a human to skim. */
export function formatReport(report: EvalReport): string {
  const lines: string[] = [
    `# Eval — ${report.suiteId}`,
    '',
    `- model: \`${report.model}\``,
    `- started: ${report.startedAt}`,
    `- mean score: **${report.mean.toFixed(2)}**`,
    `- mean spread across repeats: **${report.meanStddev.toFixed(2)}** (lower = more repeatable)`,
    '',
    '| case | origin | mean | spread | completed | rollouts |',
    '| --- | --- | --- | --- | --- | --- |',
  ];

  for (const c of report.cases) {
    lines.push(
      `| ${c.case.id} | ${c.case.origin ?? '-'} | ${c.mean.toFixed(2)} | ${c.stddev.toFixed(2)} |` +
        ` ${(c.completionRate * 100).toFixed(0)}% | ${c.rollouts.length} |`,
    );
  }

  lines.push('', '## Rollouts', '');
  for (const c of report.cases) {
    lines.push(`### ${c.case.id}`, '', `> ${c.case.prompt}`, '');
    for (const r of c.rollouts) {
      const diffStat = r.diff ? `${r.diff.split('\n').length} diff lines` : 'no changes';
      lines.push(
        `- **#${r.index}** score \`${r.score ?? '-'}\` · ${r.rounds} rounds · ${r.stopped}` +
          ` · ${(r.durationMs / 1000).toFixed(1)}s · ${diffStat}`,
        `  - ${r.scoreReason ?? ''}${r.error ? ` (error: ${r.error})` : ''}`,
      );
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ─── internals ───────────────────────────────────────────────────────────────

function newId(): string {
  const c: any = (globalThis as any).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `rollout_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function stddev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / xs.length);
}

/**
 * Judges sometimes wrap JSON in prose or a code fence. Pull out the first
 * balanced object rather than trusting the whole reply to parse.
 */
function parseJudgement(text: string, max: number): { score: number; reason: string } {
  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const obj = JSON.parse(match[0]);
      const raw = Number(obj.score);
      if (Number.isFinite(raw)) {
        return {
          score: Math.min(max, Math.max(0, raw)),
          reason: String(obj.reason ?? '').trim() || 'no reason given',
        };
      }
    } catch {
      // fall through to the failure case below
    }
  }
  // An unparseable judgement is a failed measurement, not a zero-quality diff —
  // say so explicitly instead of silently poisoning the mean.
  return { score: 0, reason: `judge returned unparseable output: ${text.slice(0, 200)}` };
}
