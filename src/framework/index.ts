/**
 * Xpro Agent Framework — public entry point.
 *
 * The reusable core behind the Xpro IDE, exposed as a small SDK so any app
 * (a server, a CLI, a mini-program / SaaS backend) can embed AI agents:
 *
 *   import { createAgent, defineTool } from 'xpro';
 *
 *   const agent = createAgent({
 *     provider: 'anthropic',
 *     baseUrl: 'https://api.anthropic.com',
 *     apiKey: process.env.ANTHROPIC_API_KEY!,
 *     model: 'claude-sonnet-4',
 *     mode: 'default',
 *     tools: [ placeOrder, queryInventory ],   // your business tools
 *   });
 *
 *   const { finalText } = await agent.run('Refund order #1234 and notify the buyer');
 *
 * Layering (bottom → top): model · tools · policy · orchestration · session.
 * Only OpenAI and Anthropic protocols are supported.
 */

import { createModelClient, type ModelClientOptions, type ModelClient } from './model';
import { ToolRegistry, defineTool, type Tool, type ToolContext } from './tools';
import { PolicyEngine, type PermissionMode, type PolicyOptions } from './policy';
import { Session, type SessionSnapshot } from './session';
import { runAgentLoop, runSubAgent, type RunOptions, type RunResult, type LoopEvent } from './orchestration';

export interface AgentOptions extends Omit<ModelClientOptions, 'provider'> {
  provider: 'openai' | 'anthropic';
  model: string;
  /** business + built-in tools the agent may call */
  tools?: Tool[];
  /** system prompt */
  system?: string;
  /** permission mode + hooks + allow/deny lists + approval callback */
  mode?: PermissionMode;
  policy?: Omit<PolicyOptions, 'mode'>;
  /** default context passed to every tool handler */
  toolContext?: ToolContext;
}

export class Agent {
  readonly model: ModelClient;
  readonly tools = new ToolRegistry();
  readonly policy: PolicyEngine;
  readonly session: Session;

  constructor(private opts: AgentOptions) {
    this.model = createModelClient({
      provider: opts.provider,
      baseUrl: opts.baseUrl,
      apiKey: opts.apiKey,
      model: opts.model,
    });
    if (opts.tools?.length) this.tools.registerAll(opts.tools);
    this.policy = new PolicyEngine({ mode: opts.mode ?? 'default', ...(opts.policy ?? {}) });
    this.session = new Session({ system: opts.system });
  }

  /** Register another tool at runtime (e.g. after auth). */
  addTool(tool: Tool): this {
    this.tools.register(tool);
    return this;
  }

  setMode(mode: PermissionMode): this {
    this.policy.setMode(mode);
    return this;
  }

  /** Run one turn to completion, appending to the ongoing session. */
  async run(input: string, opts: RunOptions = {}): Promise<RunResult> {
    this.session.add({ role: 'user', content: input });
    return runAgentLoop(
      { model: this.model, tools: this.tools, policy: this.policy },
      this.session,
      { toolContext: this.opts.toolContext, ...opts },
    );
  }

  /** Dispatch an isolated sub-agent; only its summary returns. */
  async delegate(task: string, opts: RunOptions & { system?: string } = {}): Promise<string> {
    return runSubAgent(
      { model: this.model, tools: this.tools, policy: this.policy },
      task,
      { toolContext: this.opts.toolContext, ...opts },
    );
  }

  /** Snapshot for --resume / persistence. */
  checkpoint(): SessionSnapshot {
    return this.session.checkpoint();
  }

  resume(snap: SessionSnapshot): this {
    this.session.resume(snap);
    return this;
  }
}

export function createAgent(opts: AgentOptions): Agent {
  return new Agent(opts);
}

// Re-export the layer building blocks for advanced / custom wiring.
export { defineTool, ToolRegistry } from './tools';
export { PolicyEngine } from './policy';
export { Session } from './session';
export { createModelClient } from './model';
export { runAgentLoop, runSubAgent } from './orchestration';
export { runEvaluation, createGitWorkspace, llmJudge, formatReport } from './eval';
export type { Tool, ToolContext } from './tools';
export type { PermissionMode, PolicyOptions, Hook, Approver } from './policy';
export type { ModelClient, ModelMessage, ModelToolSpec, ModelRequest, ModelResponse } from './model';
export type { SessionSnapshot, Summarizer } from './session';
export type { RunOptions, RunResult, LoopEvent } from './orchestration';
export type {
  EvalSuite, EvalCase, EvalOptions, EvalReport, CaseReport,
  RolloutRecord, Scorer, Workspace, Exec, AgentFactory,
} from './eval';
