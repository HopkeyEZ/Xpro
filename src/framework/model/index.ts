/**
 * Model layer — the bottom of the stack.
 *
 * A provider-agnostic wrapper over the Messages API of OpenAI and Anthropic.
 * Everything above (tools, policy, orchestration) talks to this interface only,
 * so adding or swapping a provider never touches the agent loop.
 *
 * Depends on nothing but the global `fetch` (Node 18+ / browser), so the whole
 * framework can be imported and run outside Electron — from a server, a CLI,
 * a mini-program backend, or another app.
 */

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface ModelMessage {
  role: Role;
  content: string | null;
  /** assistant tool-call requests (provider-normalized) */
  toolCalls?: ToolCall[];
  /** for role: 'tool' — which call this result answers */
  toolCallId?: string;
  /** optional reasoning trace echoed back for reasoning models */
  reasoning?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  /** raw JSON string of arguments, as returned by the model */
  argumentsJson: string;
}

/** JSON-Schema tool definition, provider-neutral. */
export interface ModelToolSpec {
  name: string;
  description: string;
  parameters: Record<string, any>;
}

export interface ModelRequest {
  messages: ModelMessage[];
  tools?: ModelToolSpec[];
  system?: string;
  maxTokens?: number;
  temperature?: number;
  /** enable a reasoning/thinking trace when the model supports it */
  thinking?: boolean;
  /** reasoning effort hint: 'low' | 'medium' | 'high' */
  effort?: string;
  signal?: AbortSignal;
}

export interface ModelResponse {
  text: string;
  toolCalls: ToolCall[];
  reasoning?: string;
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'other';
  usage?: { inputTokens: number; outputTokens: number };
}

export interface ModelClient {
  readonly provider: 'openai' | 'anthropic';
  complete(req: ModelRequest): Promise<ModelResponse>;
}

export interface ModelClientOptions {
  provider: 'openai' | 'anthropic';
  baseUrl: string;
  apiKey: string;
  model: string;
}

const trimSlash = (s: string) => s.replace(/\/+$/, '');

/** OpenAI-compatible Chat Completions client (also fits Azure/OSS gateways). */
class OpenAIClient implements ModelClient {
  readonly provider = 'openai' as const;
  constructor(private opts: ModelClientOptions) {}

  async complete(req: ModelRequest): Promise<ModelResponse> {
    const base = trimSlash(this.opts.baseUrl);
    const messages = req.messages.map((m) => {
      if (m.role === 'tool') {
        return { role: 'tool', tool_call_id: m.toolCallId, content: m.content ?? '' };
      }
      if (m.role === 'assistant' && m.toolCalls?.length) {
        return {
          role: 'assistant',
          content: m.content,
          tool_calls: m.toolCalls.map((t) => ({
            id: t.id,
            type: 'function',
            function: { name: t.name, arguments: t.argumentsJson },
          })),
        };
      }
      return { role: m.role, content: m.content ?? '' };
    });
    if (req.system) messages.unshift({ role: 'system', content: req.system } as any);

    const body: any = {
      model: this.opts.model,
      messages,
      max_tokens: req.maxTokens ?? 4096,
      temperature: req.temperature ?? 0.7,
    };
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    }
    if (req.effort) body.reasoning_effort = req.effort;

    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.opts.apiKey}` },
      body: JSON.stringify(body),
      signal: req.signal,
    });
    if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const json: any = await res.json();
    const msg = json.choices?.[0]?.message ?? {};
    const toolCalls: ToolCall[] = (msg.tool_calls ?? []).map((t: any) => ({
      id: t.id,
      name: t.function?.name,
      argumentsJson: t.function?.arguments ?? '{}',
    }));
    return {
      text: msg.content ?? '',
      toolCalls,
      reasoning: msg.reasoning_content,
      stopReason: toolCalls.length ? 'tool_use' : 'end_turn',
      usage: json.usage
        ? { inputTokens: json.usage.prompt_tokens ?? 0, outputTokens: json.usage.completion_tokens ?? 0 }
        : undefined,
    };
  }
}

/** Anthropic Messages API client. */
class AnthropicClient implements ModelClient {
  readonly provider = 'anthropic' as const;
  constructor(private opts: ModelClientOptions) {}

  async complete(req: ModelRequest): Promise<ModelResponse> {
    const base = trimSlash(this.opts.baseUrl);
    const messages: any[] = [];
    for (const m of req.messages) {
      if (m.role === 'system') continue; // Anthropic takes system as a top-level field
      if (m.role === 'tool') {
        messages.push({
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content ?? '' }],
        });
        continue;
      }
      if (m.role === 'assistant' && m.toolCalls?.length) {
        const blocks: any[] = [];
        if (m.content) blocks.push({ type: 'text', text: m.content });
        for (const t of m.toolCalls) {
          blocks.push({ type: 'tool_use', id: t.id, name: t.name, input: safeParse(t.argumentsJson) });
        }
        messages.push({ role: 'assistant', content: blocks });
        continue;
      }
      messages.push({ role: m.role, content: m.content ?? '' });
    }

    const body: any = {
      model: this.opts.model,
      max_tokens: req.maxTokens ?? 4096,
      messages,
    };
    const sys = req.system ?? req.messages.find((m) => m.role === 'system')?.content;
    if (sys) body.system = sys;
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      }));
    }
    if (req.thinking) body.thinking = { type: 'enabled', budget_tokens: 4096 };

    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.opts.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal: req.signal,
    });
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const json: any = await res.json();
    let text = '';
    let reasoning: string | undefined;
    const toolCalls: ToolCall[] = [];
    for (const block of json.content ?? []) {
      if (block.type === 'text') text += block.text;
      else if (block.type === 'thinking') reasoning = block.thinking;
      else if (block.type === 'tool_use') {
        toolCalls.push({ id: block.id, name: block.name, argumentsJson: JSON.stringify(block.input ?? {}) });
      }
    }
    return {
      text,
      toolCalls,
      reasoning,
      stopReason: json.stop_reason === 'tool_use' ? 'tool_use' : 'end_turn',
      usage: json.usage
        ? { inputTokens: json.usage.input_tokens ?? 0, outputTokens: json.usage.output_tokens ?? 0 }
        : undefined,
    };
  }
}

function safeParse(s: string): any {
  try { return JSON.parse(s); } catch { return {}; }
}

/** Factory — the only entry the rest of the framework uses. */
export function createModelClient(opts: ModelClientOptions): ModelClient {
  return opts.provider === 'anthropic' ? new AnthropicClient(opts) : new OpenAIClient(opts);
}
