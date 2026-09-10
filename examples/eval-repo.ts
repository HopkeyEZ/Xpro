/**
 * Evaluate an agent against a real repo.
 *
 *   npx tsc -p tsconfig.framework.json
 *   ANTHROPIC_API_KEY=... npx ts-node examples/eval-repo.ts /path/to/repo
 *
 * What it does: for each prompt, reset the repo to HEAD, hand a *fresh* agent
 * the task, capture the git diff it produced, and have a judge score that diff.
 * Every prompt runs twice, so the report shows not just how good the agent is
 * but how repeatable it is — the number that decides whether you can build on it.
 */

import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import {
  createAgent,
  createGitWorkspace,
  runEvaluation,
  llmJudge,
  formatReport,
  type EvalSuite,
} from '../src/framework';

// The only Node-specific glue the eval layer needs.
const exec = (cmd: string, args: string[], cwd: string): Promise<string> =>
  new Promise((resolve, reject) =>
    execFile(cmd, args, { cwd, maxBuffer: 32 << 20 }, (err, stdout) =>
      err ? reject(err) : resolve(stdout),
    ),
  );

const root = process.argv[2];
if (!root) {
  console.error('usage: ts-node examples/eval-repo.ts <path-to-git-repo>');
  process.exit(1);
}

const model = process.env.XPRO_EVAL_MODEL ?? 'claude-sonnet-4';
const apiKey = process.env.ANTHROPIC_API_KEY ?? '';

const suite: EvalSuite = {
  id: 'demo-repo',
  cases: [
    {
      id: 'add-tests',
      // A task the repo itself implies — you didn't write it to flatter the agent.
      origin: 'repo',
      prompt: 'Add unit tests for the module with the least coverage. Run them and make them pass.',
      tags: ['testing'],
    },
    {
      id: 'refactor-dup',
      // One you authored to probe a specific weakness.
      origin: 'authored',
      prompt: 'Find duplicated logic across two files and extract it into a shared helper, without changing behaviour.',
      tags: ['refactor'],
    },
  ],
};

async function main() {
  const workspace = createGitWorkspace({ root, exec });

  const judge = createAgent({
    provider: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    apiKey,
    model,
    mode: 'plan', // the judge reads and reasons; it must never touch the repo
  });

  const report = await runEvaluation({
    suite,
    workspace,
    rollouts: 2,
    createAgent: () =>
      // A new agent per rollout: reusing one would leak the previous run's
      // context and quietly turn "two independent attempts" into "one long one".
      createAgent({
        provider: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        apiKey,
        model,
        mode: 'acceptEdits',
        toolContext: { root },
      }),
    scorer: llmJudge({ judge, max: 5 }),
    onRollout: (r) =>
      console.log(`${r.caseId} #${r.index} → ${r.score}/5  (${r.rounds} rounds, ${r.stopped})`),
  });

  const md = formatReport(report);
  writeFileSync('eval-report.md', md, 'utf8');
  console.log(`\n${md}\n\nwritten to eval-report.md`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
