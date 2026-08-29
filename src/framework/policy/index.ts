/**
 * Policy layer — where a toy becomes a product.
 *
 * Every side-effecting tool call is checked here BEFORE it runs. The gate lives
 * in the execution path, not in the prompt: a prompt is a soft constraint the
 * model can violate; this is a hard one it cannot.
 *
 * Independent of the tool layer — adding a tool never changes permission logic,
 * and a permission rule needs to know nothing about a tool's internals.
 */

import type { Tool } from '../tools';

export type PermissionMode =
  | 'default'      // ask before every mutating tool
  | 'acceptEdits'  // auto-accept file edits, still ask for the rest
  | 'plan'         // read-only: deny every mutating tool
  | 'bypass';      // allow everything (use with care)

export type Decision = 'allow' | 'ask' | 'deny';

export interface ToolCallIntent {
  tool: Tool;
  args: Record<string, any>;
}

/** Deterministic code run around tool calls — the things a model would forget. */
export interface Hook {
  /** return 'deny' to block, 'ask' to force a prompt, or void to pass through */
  preToolUse?(intent: ToolCallIntent): Decision | void | Promise<Decision | void>;
  postToolUse?(intent: ToolCallIntent, output: string, isError: boolean): void | Promise<void>;
}

/** Caller decides how to surface an approval prompt (CLI, IDE dialog, web…). */
export type Approver = (intent: ToolCallIntent) => Promise<boolean>;

export interface PolicyOptions {
  mode?: PermissionMode;
  /** tool names always allowed without asking */
  allowlist?: string[];
  /** tool names always denied */
  denylist?: string[];
  hooks?: Hook[];
  approve?: Approver;
}

const EDIT_TOOLS = new Set(['write_file', 'edit_file', 'write', 'edit']);

export class PolicyEngine {
  private mode: PermissionMode;
  private allow: Set<string>;
  private deny: Set<string>;
  private hooks: Hook[];
  private approver?: Approver;

  constructor(opts: PolicyOptions = {}) {
    this.mode = opts.mode ?? 'default';
    this.allow = new Set(opts.allowlist ?? []);
    this.deny = new Set(opts.denylist ?? []);
    this.hooks = opts.hooks ?? [];
    this.approver = opts.approve;
  }

  setMode(mode: PermissionMode): void {
    this.mode = mode;
  }

  /** Static decision from mode + lists, before any hook or prompt. */
  private baseDecision(intent: ToolCallIntent): Decision {
    const name = intent.tool.name;
    if (this.deny.has(name)) return 'deny';
    if (this.allow.has(name)) return 'allow';
    if (!intent.tool.mutates) return 'allow'; // read-only always allowed
    switch (this.mode) {
      case 'bypass': return 'allow';
      case 'plan': return 'deny';
      case 'acceptEdits': return EDIT_TOOLS.has(name) ? 'allow' : 'ask';
      default: return 'ask';
    }
  }

  /**
   * Resolve the final go/no-go for one tool call. Runs preToolUse hooks first
   * (any 'deny' wins), then the base decision, then the approver for 'ask'.
   */
  async check(intent: ToolCallIntent): Promise<{ allowed: boolean; reason?: string }> {
    for (const h of this.hooks) {
      const d = await h.preToolUse?.(intent);
      if (d === 'deny') return { allowed: false, reason: `blocked by hook: ${intent.tool.name}` };
      if (d === 'ask') {
        const ok = this.approver ? await this.approver(intent) : false;
        return { allowed: ok, reason: ok ? undefined : 'denied by user' };
      }
    }
    const base = this.baseDecision(intent);
    if (base === 'allow') return { allowed: true };
    if (base === 'deny') return { allowed: false, reason: `denied by policy (${this.mode})` };
    const ok = this.approver ? await this.approver(intent) : false;
    return { allowed: ok, reason: ok ? undefined : 'denied by user' };
  }

  async afterToolUse(intent: ToolCallIntent, output: string, isError: boolean): Promise<void> {
    for (const h of this.hooks) await h.postToolUse?.(intent, output, isError);
  }
}
