/**
 * Orchestration layer — the agent loop itself.
 *
 * Strip every wrapper away and an agent is just:
 *
 *   while true:
 *     resp = model(messages, tools)
 *     if resp is end_turn: break
 *     messages += assistant(resp)          # includes tool_use blocks
 *     results = [execute(t) for t in resp.tool_calls]
 *     messages += tool_results             # every id paired back
 *
 * Everything below is that loop made safe for production: a round cap, policy
 * checks before side effects, error results fed back (never dropped), parallel
 * sub-agents for context isolation, and event callbacks for the UI layer.
 */

import type { ModelClient, ModelMessage } from '../model';
import type { ToolRegistry, ToolContext } from '../tools';
import type { PolicyEngine } from '../policy';
import { Session } from '../session';

export interface LoopEvent {
  type: 'text' | 'thinking' | 'tool_call' | 'tool_result' | 'done' | 'error';
  text?: string;
  toolName?: string;
  toolArgs?: Record<string, any>;
  toolOutput?: string;
  toolOk?: boolean;
  error?: string;
}

export interface RunOptions {
  maxRounds?: number;
  toolContext?: ToolContext;
  signal?: AbortSignal;
  onEvent?: (e: LoopEvent) => void;
}

export interface RunResult {
  finalText: string;
  rounds: number;
  stopped: 'end_turn' | 'max_rounds' | 'aborted' | 'error';
}

export interface Orchestrator {
  model: ModelClient;
  tools: ToolRegistry;
  policy: PolicyEngine;
}

/**
 * Drive one agent turn to completion. `session` carries the running history so
 * the same call resumes a conversation transparently.
 */
export async function runAgentLoop(
  o: Orchestrator,
  session: Session,
  opts: RunOptions = {},
): Promise<RunResult> {
  const maxRounds = opts.maxRounds ?? 30;
  const emit = opts.onEvent ?? (() => {});
  const ctx = opts.toolContext ?? {};
  let finalText = '';

  for (let round = 0; round < maxRounds; round++) {
    if (opts.signal?.aborted) return { finalText, rounds: round, stopped: 'aborted' };

    let resp;
    try {
      resp = await o.model.complete({
        messages: session.history(),
        tools: o.tools.specs(),
        system: session.system,
        signal: opts.signal,
      });
    } catch (err: any) {
      emit({ type: 'error', error: err?.message ?? String(err) });
      return { finalText, rounds: round, stopped: 'error' };
    }

    if (resp.reasoning) emit({ type: 'thinking' });
    if (resp.text) {
      finalText = resp.text;
      emit({ type: 'text', text: resp.text });
    }

    // No tool calls → the model is done.
    if (!resp.toolCalls.length) {
      session.add({ role: 'assistant', content: resp.text });
      emit({ type: 'done' });
      return { finalText, rounds: round + 1, stopped: 'end_turn' };
    }

    // Record the assistant turn (with its tool_use requests) before executing.
    session.add({ role: 'assistant', content: resp.text || null, toolCalls: resp.toolCalls, reasoning: resp.reasoning });

    // Execute each call; EVERY result is paired back by id (failures included).
    for (const call of resp.toolCalls) {
      const tool = o.tools.get(call.name);
      let output: string;
      let isError = false;

      if (!tool) {
        output = `Unknown tool: ${call.name}`;
        isError = true;
      } else {
        let args: Record<string, any> = {};
        try { args = call.argumentsJson ? JSON.parse(call.argumentsJson) : {}; } catch {}
        emit({ type: 'tool_call', toolName: call.name, toolArgs: args });

        const verdict = await o.policy.check({ tool, args });
        if (!verdict.allowed) {
          output = `Tool call blocked: ${verdict.reason ?? 'policy'}`;
          isError = true;
        } else {
          const r = await o.tools.execute(call, ctx);
          output = r.output;
          isError = r.isError;
          await o.policy.afterToolUse({ tool, args }, output, isError);
        }
      }

      emit({ type: 'tool_result', toolName: call.name, toolOutput: output, toolOk: !isError });
      session.add({ role: 'tool', toolCallId: call.id, content: output });
    }
  }

  emit({ type: 'done' });
  return { finalText, rounds: maxRounds, stopped: 'max_rounds' };
}

/**
 * Sub-agent: run a child loop with its OWN session. The child may read 50 files;
 * the parent only ever sees the returned summary — the point is context
 * isolation, not parallelism.
 */
export async function runSubAgent(
  o: Orchestrator,
  task: string,
  opts: RunOptions & { system?: string } = {},
): Promise<string> {
  const child = new Session({
    system: opts.system ?? 'You are a focused sub-agent. Complete the task and return a concise summary.',
  });
  child.add({ role: 'user', content: task });
  const result = await runAgentLoop(o, child, { ...opts, maxRounds: opts.maxRounds ?? 8 });
  return result.finalText;
}
