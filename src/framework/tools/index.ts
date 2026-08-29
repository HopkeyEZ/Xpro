/**
 * Tool layer — the agent's hands.
 *
 * A tool is a name + JSON-Schema + a handler that runs in *your* process.
 * The model never executes anything; it only asks to call a tool, and the
 * registry below is what actually runs it and pairs the result back by id.
 *
 * The agent's capability ceiling = the expressiveness of the tools you register.
 * Register your own business tools (place an order, query inventory, call a
 * mini-program / SaaS OpenAPI) and the agent can drive them — no core changes.
 */

import type { ModelToolSpec } from '../model';

export interface ToolContext {
  /** working directory / project root, if any */
  root?: string;
  /** free-form shared state passed through from the caller */
  [key: string]: any;
}

export interface Tool {
  name: string;
  description: string;
  /** JSON-Schema for the arguments object */
  parameters: Record<string, any>;
  /** true if the tool has side effects (write/exec/network) — gated by policy */
  mutates?: boolean;
  handler(args: Record<string, any>, ctx: ToolContext): Promise<string>;
}

export interface ToolResult {
  toolCallId: string;
  name: string;
  output: string;
  isError: boolean;
}

/** Helper for defining a tool with light type-checking at the call site. */
export function defineTool(tool: Tool): Tool {
  return tool;
}

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): this {
    if (this.tools.has(tool.name)) throw new Error(`Tool already registered: ${tool.name}`);
    this.tools.set(tool.name, tool);
    return this;
  }

  registerAll(tools: Tool[]): this {
    for (const t of tools) this.register(t);
    return this;
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  /** Provider-neutral specs handed to the model layer. */
  specs(): ModelToolSpec[] {
    return this.list().map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
  }

  /**
   * Execute one tool call. Never throws: a failed tool still returns a
   * ToolResult with isError:true so the id can be paired back to the model
   * (a missing tool_result is an instant 400 on the next turn).
   */
  async execute(
    call: { id: string; name: string; argumentsJson: string },
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const tool = this.tools.get(call.name);
    if (!tool) {
      return { toolCallId: call.id, name: call.name, output: `Unknown tool: ${call.name}`, isError: true };
    }
    let args: Record<string, any> = {};
    try {
      args = call.argumentsJson ? JSON.parse(call.argumentsJson) : {};
    } catch {
      return { toolCallId: call.id, name: call.name, output: 'Invalid JSON arguments', isError: true };
    }
    try {
      const output = await tool.handler(args, ctx);
      return { toolCallId: call.id, name: call.name, output, isError: false };
    } catch (err: any) {
      return { toolCallId: call.id, name: call.name, output: `Error: ${err?.message ?? err}`, isError: true };
    }
  }
}
