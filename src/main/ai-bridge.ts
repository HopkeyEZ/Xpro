import { net } from 'electron';
import { getOpenAITools, getAnthropicTools, executeTool, getProjectRoot } from './ai-tools';
import { searchIndex } from './code-index';
import { vectorSearch } from './vector-store';

interface AiConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  thinking?: boolean;
  maxTokens?: number;
  reasoningEffort?: string;
  streaming?: boolean;
}

interface ChatMessage {
  role: string;
  content: any;
  tool_calls?: any[];
  tool_call_id?: string;
  name?: string;
}

// Tool loop event types sent to renderer
export interface ToolEvent {
  type: 'thinking' | 'tool_call' | 'tool_result' | 'text' | 'done' | 'error' | 'token_usage';
  toolName?: string;
  toolArgs?: Record<string, any>;
  toolResult?: string;
  toolOk?: boolean;
  text?: string;
  error?: string;
  agentName?: string;
  conversationHistory?: any[];
  inputTokens?: number;
  outputTokens?: number;
}

function normalizeBase(base: string): string {
  return base.replace(/\/+$/, '');
}

const TIMEOUT_MS = 180000;
const MAX_TOOL_ROUNDS = 30;
const MAX_GOAL_CHECKS = 10;
const GOAL_COMPLETE_MARKER = '[GOAL_COMPLETE]';

const GOAL_CHECK_PROMPT = [
  'IMPORTANT: Review the user\'s original request and everything you have done so far.',
  '',
  'If and ONLY if you have FULLY accomplished every part of the user\'s goal with actual tool executions and verified results, respond with exactly: ' + GOAL_COMPLETE_MARKER,
  '',
  'If there is ANY remaining work (files to edit, commands to run, errors to fix, steps not yet executed):',
  '- Do NOT say ' + GOAL_COMPLETE_MARKER,
  '- Briefly state what remains, then IMMEDIATELY continue using tool calls to finish.',
  '- You MUST call tools in your next response — do not just describe what you plan to do.',
  '',
  'Remember: Describing a plan is NOT the same as completing it. You must actually execute tool calls.',
].join('\n');

// Abort mechanism
let abortFlag = false;
let currentAbortController: AbortController | null = null;

export function abortAi(): void {
  abortFlag = true;
  if (currentAbortController) {
    try { currentAbortController.abort(); } catch {}
  }
}

// ==================== Sub-Agent Runner ====================
const SUB_MAX_ROUNDS = 8;
const SUB_TIMEOUT = 60000;

async function runSubAgent(
  config: AiConfig,
  provider: string,
  task: string,
  agentName: string,
  onEvent: (evt: ToolEvent) => void,
): Promise<string> {
  const base = normalizeBase(config.baseUrl);
  const root = getProjectRoot();
  const sysPrompt = [
    'You are a focused sub-agent. Complete your assigned task using the available tools.',
    'Be thorough but efficient. When done, provide a clear, concise summary of findings/actions.',
    `Project root: ${root || 'unknown'}`,
    'Shell: PowerShell. Aliases work: ls, cat, cp, mv, rm, mkdir, echo, curl.',
  ].join('\n');

  let resultText = '';

  if (provider === 'anthropic') {
    const url = `${base}/v1/messages`;
    const tools = getAnthropicTools().filter(t => t.name !== 'sub_agent');
    const conversation: any[] = [{ role: 'user', content: task }];

    for (let round = 0; round < SUB_MAX_ROUNDS; round++) {
      if (abortFlag) return '(Stopped)';
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), SUB_TIMEOUT);
      let resJson: any;
      try {
        const res = await net.fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model: config.model, max_tokens: 4096, system: sysPrompt, messages: conversation, tools }),
          signal: controller.signal as any,
        });
        clearTimeout(timer);
        const text = await res.text();
        if (!res.ok) return `Sub-agent error: HTTP ${res.status}: ${text.slice(0, 200)}`;
        resJson = JSON.parse(text);
      } catch (err: any) {
        clearTimeout(timer);
        return `Sub-agent error: ${err.message}`;
      }

      const content = resJson.content || [];
      const toolUseBlocks = content.filter((b: any) => b.type === 'tool_use');
      const textParts = content.filter((b: any) => b.type === 'text').map((b: any) => b.text);
      if (textParts.length) resultText = textParts.join('\n');

      if (resJson.stop_reason === 'tool_use' || toolUseBlocks.length > 0) {
        conversation.push({ role: 'assistant', content });
        const toolResults: any[] = [];
        for (const tu of toolUseBlocks) {
          onEvent({ type: 'tool_call', toolName: tu.name, toolArgs: tu.input || {}, agentName });
          const result = await executeTool(tu.name, tu.input || {});
          const truncated = result.result.length > 8000 ? result.result.slice(0, 8000) + '\n...(truncated)' : result.result;
          onEvent({ type: 'tool_result', toolName: tu.name, toolResult: truncated.split('\n')[0].slice(0, 80), toolOk: result.ok, agentName });
          toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: truncated, is_error: !result.ok });
        }
        conversation.push({ role: 'user', content: toolResults });
        continue;
      }
      break;
    }
  } else {
    const url = `${base}/chat/completions`;
    const tools = getOpenAITools().filter(t => t.function.name !== 'sub_agent');
    const conversation: any[] = [
      { role: 'system', content: sysPrompt },
      { role: 'user', content: task },
    ];

    for (let round = 0; round < SUB_MAX_ROUNDS; round++) {
      if (abortFlag) return '(Stopped)';
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), SUB_TIMEOUT);
      let resJson: any;
      try {
        const res = await net.fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.apiKey}` },
          body: JSON.stringify({ model: config.model, messages: conversation, tools, temperature: 0.3, max_tokens: 384000 }),
          signal: controller.signal as any,
        });
        clearTimeout(timer);
        const text = await res.text();
        if (!res.ok) return `Sub-agent error: HTTP ${res.status}: ${text.slice(0, 200)}`;
        resJson = JSON.parse(text);
      } catch (err: any) {
        clearTimeout(timer);
        return `Sub-agent error: ${err.message}`;
      }

      const msg = resJson.choices?.[0]?.message;
      if (!msg) return 'Sub-agent: no response';

      if (msg.tool_calls && msg.tool_calls.length > 0) {
        if (msg.content) resultText += msg.content;
        const subAsstMsg: any = { role: 'assistant', content: msg.content || null, tool_calls: msg.tool_calls };
        if (msg.reasoning_content) subAsstMsg.reasoning_content = msg.reasoning_content;
        conversation.push(subAsstMsg);
        for (const tc of msg.tool_calls) {
          const fnName = tc.function?.name || '';
          let fnArgs: Record<string, any> = {};
          try { fnArgs = JSON.parse(tc.function?.arguments || '{}'); } catch {}
          onEvent({ type: 'tool_call', toolName: fnName, toolArgs: fnArgs, agentName });
          const result = await executeTool(fnName, fnArgs);
          const truncated = result.result.length > 8000 ? result.result.slice(0, 8000) + '\n...(truncated)' : result.result;
          onEvent({ type: 'tool_result', toolName: fnName, toolResult: truncated.split('\n')[0].slice(0, 80), toolOk: result.ok, agentName });
          conversation.push({ role: 'tool', tool_call_id: tc.id, content: truncated });
        }
        continue;
      }

      resultText += (msg.content || '');
      break;
    }
  }

  return resultText || '(no output from sub-agent)';
}

// ==================== OpenAI Tool Loop ====================
async function openaiToolLoop(
  config: AiConfig,
  messages: ChatMessage[],
  onEvent: (evt: ToolEvent) => void,
): Promise<void> {
  const base = normalizeBase(config.baseUrl);
  const url = `${base}/chat/completions`;
  const tools = getOpenAITools();

  // Clone messages for the loop
  const conversation: any[] = messages.map(m => ({ ...m }));
  let goalChecks = 0;

  // === 3-Layer Retrieval: inject relevant code context ===
  const projectRoot = getProjectRoot();
  if (projectRoot) {
    try {
      // Extract query from last user message
      const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
      const queryText = typeof lastUserMsg?.content === 'string'
        ? lastUserMsg.content
        : Array.isArray(lastUserMsg?.content)
          ? lastUserMsg.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join(' ')
          : '';

      if (queryText.length > 5) {
        const contextParts: string[] = [];

        // Layer 1: Code Index (keyword match)
        const indexResults = searchIndex(projectRoot, queryText, 3);
        if (indexResults.length > 0) {
          contextParts.push('## Relevant Code (from project index):');
          for (const r of indexResults) {
            contextParts.push(`### ${r.filePath}:${r.startLine}-${r.endLine} — ${r.description}`);
            contextParts.push('```\n' + r.code.slice(0, 1000) + '\n```');
          }
        }

        // Layer 2: Vector Search (semantic match)
        const vecResults = await vectorSearch(projectRoot, queryText, config, 3);
        const vecNew = vecResults.filter(v => !indexResults.some(i => i.filePath === v.filePath && i.startLine === v.startLine));
        if (vecNew.length > 0) {
          contextParts.push('## Additional Context (semantic search):');
          for (const v of vecNew) {
            contextParts.push(`- ${v.filePath}:${v.startLine}-${v.endLine} — ${v.description} (score: ${v.score.toFixed(2)})`);
          }
        }

        if (contextParts.length > 0) {
          const contextMsg = {
            role: 'system',
            content: `[Auto-retrieved project context]\n${contextParts.join('\n')}`,
          };
          // Insert after the first system message (or at position 1)
          const sysIdx = conversation.findIndex(m => m.role === 'system');
          conversation.splice(sysIdx >= 0 ? sysIdx + 1 : 0, 0, contextMsg);
          console.log(`[AI] Injected ${indexResults.length} index + ${vecNew.length} vector results`);
        }
      }
    } catch (err) {
      console.error('[AI] Context retrieval error (non-fatal):', err);
    }
  }

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    if (abortFlag) { onEvent({ type: 'done', text: '(Stopped by user)' }); return; }
    console.log(`[AI] OpenAI round ${round} -> ${url} model=${config.model}`);
    onEvent({ type: 'thinking' });

    const controller = new AbortController();
    currentAbortController = controller;
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    let resJson: any;
    let textWasStreamed = false;
    try {
      if (config.streaming !== false) {
        // ── Streaming path ──
        const res = await net.fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify({
            model: config.model,
            messages: conversation,
            tools,
            temperature: 0.3,
            max_tokens: config.maxTokens || 384000,
            stream: true,
            stream_options: { include_usage: true },
            ...(config.thinking ? {
              thinking: { type: 'enabled' },
              reasoning_effort: config.reasoningEffort || 'max',
            } : {}),
          }),
          signal: controller.signal as any,
        });
        clearTimeout(timer);

        if (!res.ok) {
          const errText = await res.text();
          console.log(`[AI] OpenAI status=${res.status} body=${errText.slice(0, 300)}`);
          throw new Error(`HTTP ${res.status}: ${errText.slice(0, 300)}`);
        }

        const reader = (res.body as any).getReader();
        const decoder = new TextDecoder();
        let sseBuffer = '';
        let accText = '';
        let accReasoning = false;
        const accToolCalls: Record<number, { id: string; name: string; arguments: string }> = {};
        let finalUsage: any = null;
        let finalFinishReason: string | null = null;

        streamLoop: while (true) {
          if (abortFlag) break;
          let chunkData: { done: boolean; value?: Uint8Array };
          try { chunkData = await reader.read(); } catch { break; }
          if (chunkData.done) break;
          sseBuffer += decoder.decode(chunkData.value, { stream: true });
          const lines = sseBuffer.split('\n');
          sseBuffer = lines.pop() ?? '';
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6);
            if (data === '[DONE]') break streamLoop;
            let parsed: any;
            try { parsed = JSON.parse(data); } catch { continue; }
            if (parsed.usage) finalUsage = parsed.usage;
            const choice = parsed.choices?.[0];
            if (!choice) continue;
            if (choice.finish_reason) finalFinishReason = choice.finish_reason;
            const delta = choice.delta;
            if (!delta) continue;
            if (delta.reasoning_content && !accReasoning) {
              accReasoning = true;
              onEvent({ type: 'thinking' });
            }
            if (delta.content) {
              accText += delta.content;
              textWasStreamed = true;
              onEvent({ type: 'text', text: delta.content });
            }
            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx: number = tc.index ?? 0;
                if (!accToolCalls[idx]) accToolCalls[idx] = { id: '', name: '', arguments: '' };
                if (tc.id) accToolCalls[idx].id = tc.id;
                if (tc.function?.name) accToolCalls[idx].name += tc.function.name;
                if (tc.function?.arguments) accToolCalls[idx].arguments += tc.function.arguments;
              }
            }
          }
        }

        const assembledToolCalls = Object.entries(accToolCalls)
          .sort(([a], [b]) => Number(a) - Number(b))
          .map(([, tc]) => ({ id: tc.id, type: 'function' as const, function: { name: tc.name, arguments: tc.arguments } }));
        console.log(`[AI] OpenAI stream done: textLen=${accText.length} tools=${assembledToolCalls.length} finish=${finalFinishReason}`);
        resJson = {
          choices: [{ message: { role: 'assistant', content: accText || null, tool_calls: assembledToolCalls.length > 0 ? assembledToolCalls : undefined }, finish_reason: finalFinishReason }],
          usage: finalUsage,
        };
      } else {
        // ── Non-streaming path ──
        const res = await net.fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify({
            model: config.model,
            messages: conversation,
            tools,
            temperature: 0.3,
            max_tokens: config.maxTokens || 384000,
            ...(config.thinking ? {
              thinking: { type: 'enabled' },
              reasoning_effort: config.reasoningEffort || 'max',
            } : {}),
          }),
          signal: controller.signal as any,
        });
        clearTimeout(timer);
        const text = await res.text();
        console.log(`[AI] OpenAI status=${res.status} body=${text.slice(0, 300)}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
        resJson = JSON.parse(text);
      }
    } catch (err: any) {
      clearTimeout(timer);
      if (abortFlag) {
        onEvent({ type: 'done', text: '(Stopped by user)' });
      } else if (err.name === 'AbortError') {
        onEvent({ type: 'error', error: 'Request timed out (180s)' });
      } else {
        onEvent({ type: 'error', error: err.message });
      }
      return;
    }

    // Emit token usage
    if (resJson.usage) {
      onEvent({ type: 'token_usage', inputTokens: resJson.usage.prompt_tokens || 0, outputTokens: resJson.usage.completion_tokens || 0 });
    }

    const choice = resJson.choices?.[0];
    const msg = choice?.message;
    if (!msg) {
      onEvent({ type: 'error', error: 'No response from API' });
      return;
    }

    // Emit reasoning_content (DeepSeek thinking mode) as thinking indicator
    if (msg.reasoning_content) {
      onEvent({ type: 'thinking' });
    }

    // Check for tool calls
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      // Emit any text content alongside tool calls (skip if already streamed)
      if (msg.content && !textWasStreamed) {
        onEvent({ type: 'text', text: msg.content });
      }
      // Add assistant message (with tool_calls) to conversation
      const asstMsg: any = {
        role: 'assistant',
        content: msg.content || null,
        tool_calls: msg.tool_calls,
      };
      // DeepSeek thinking mode: must pass reasoning_content back
      if (msg.reasoning_content) asstMsg.reasoning_content = msg.reasoning_content;
      conversation.push(asstMsg);

      // Separate sub_agent calls (parallel) from regular calls (sequential)
      const subAgentTCs: any[] = [];
      const regularTCs: any[] = [];
      for (const tc of msg.tool_calls) {
        if ((tc.function?.name || '') === 'sub_agent') subAgentTCs.push(tc);
        else regularTCs.push(tc);
      }

      // Execute regular tools sequentially
      for (const tc of regularTCs) {
        const fnName = tc.function?.name || '';
        let fnArgs: Record<string, any> = {};
        try { fnArgs = JSON.parse(tc.function?.arguments || '{}'); } catch {}

        onEvent({ type: 'tool_call', toolName: fnName, toolArgs: fnArgs });
        console.log(`[AI] Tool call: ${fnName}(${JSON.stringify(fnArgs).slice(0, 200)})`);

        const result = await executeTool(fnName, fnArgs);
        const truncatedResult = result.result.length > 16000
          ? result.result.slice(0, 16000) + '\n... (truncated)'
          : result.result;

        onEvent({ type: 'tool_result', toolName: fnName, toolResult: truncatedResult, toolOk: result.ok });
        console.log(`[AI] Tool result: ok=${result.ok} len=${result.result.length}`);
        conversation.push({ role: 'tool', tool_call_id: tc.id, content: truncatedResult });
      }

      // Execute sub-agents in PARALLEL
      if (subAgentTCs.length > 0) {
        console.log(`[AI] Launching ${subAgentTCs.length} sub-agent(s) in parallel`);
        const subResults = await Promise.all(subAgentTCs.map(async (tc) => {
          let fnArgs: Record<string, any> = {};
          try { fnArgs = JSON.parse(tc.function?.arguments || '{}'); } catch {}
          const task = fnArgs.task || '';
          const name = task.slice(0, 40);

          onEvent({ type: 'tool_call', toolName: 'sub_agent', toolArgs: fnArgs, agentName: name });
          console.log(`[AI] Sub-agent start: "${name}"`);

          const result = await runSubAgent(config, 'openai', task, name, onEvent);
          const truncated = result.length > 16000 ? result.slice(0, 16000) + '\n...(truncated)' : result;

          onEvent({ type: 'tool_result', toolName: 'sub_agent', toolResult: truncated.slice(0, 200), toolOk: true, agentName: name });
          console.log(`[AI] Sub-agent done: "${name}" len=${result.length}`);

          return { id: tc.id, content: truncated };
        }));

        for (const { id, content } of subResults) {
          conversation.push({ role: 'tool', tool_call_id: id, content });
        }
      }
      // Continue loop for next AI response
      continue;
    }

    // No tool calls — check if goal is complete
    const responseText = msg.content || '';

    // If AI explicitly signals completion, or we've exhausted goal checks, finish
    if (responseText.includes(GOAL_COMPLETE_MARKER) || goalChecks >= MAX_GOAL_CHECKS) {
      const cleanText = responseText.replace(GOAL_COMPLETE_MARKER, '').trim();
      // Include the final assistant text in history for memory extraction
      if (cleanText) conversation.push({ role: 'assistant', content: cleanText });
      // Return conversation history (filter out internal goal check prompts)
      const history = conversation.filter(m => m.content !== GOAL_CHECK_PROMPT);
      onEvent({ type: 'done', text: cleanText, conversationHistory: history });
      return;
    }

    // First text response: emit it, then inject goal check (skip if already streamed)
    if (!textWasStreamed) onEvent({ type: 'text', text: responseText });
    const textAsstMsg: any = { role: 'assistant', content: responseText };
    if (msg.reasoning_content) textAsstMsg.reasoning_content = msg.reasoning_content;
    conversation.push(textAsstMsg);
    conversation.push({ role: 'user', content: GOAL_CHECK_PROMPT });
    goalChecks++;
    console.log(`[AI] Goal check ${goalChecks}/${MAX_GOAL_CHECKS} — continuing...`);
    onEvent({ type: 'thinking' });
    continue;
  }

  onEvent({ type: 'error', error: `Max tool rounds (${MAX_TOOL_ROUNDS}) reached` });
}

// ==================== Anthropic Tool Loop ====================
async function anthropicToolLoop(
  config: AiConfig,
  messages: ChatMessage[],
  onEvent: (evt: ToolEvent) => void,
): Promise<void> {
  const base = normalizeBase(config.baseUrl);
  const url = `${base}/v1/messages`;
  const tools = getAnthropicTools();

  const systemMsg = messages.find(m => m.role === 'system')?.content ?? '';
  // Build conversation without system message
  const conversation: any[] = messages.filter(m => m.role !== 'system').map(m => ({ ...m }));
  let goalChecks = 0;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    if (abortFlag) { onEvent({ type: 'done', text: '(Stopped by user)' }); return; }
    // Debug: log message content types to verify image data is included
    for (const msg of conversation) {
      if (Array.isArray(msg.content)) {
        const types = msg.content.map((b: any) => b.type + (b.type === 'image' ? `(${b.source?.data?.length || 0}chars)` : ''));
        console.log(`[AI] Anthropic msg role=${msg.role} content=[${types.join(', ')}]`);
      }
    }
    console.log(`[AI] Anthropic round ${round} -> ${url} model=${config.model}`);
    onEvent({ type: 'thinking' });

    const controller = new AbortController();
    currentAbortController = controller;
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    let resJson: any;
    let textWasStreamed = false;
    try {
      if (config.streaming !== false) {
        // ── Streaming path ──
        const res = await net.fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': config.apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: config.model,
            max_tokens: 4096,
            system: systemMsg,
            messages: conversation,
            tools,
            stream: true,
          }),
          signal: controller.signal as any,
        });
        clearTimeout(timer);

        if (!res.ok) {
          const errText = await res.text();
          console.log(`[AI] Anthropic status=${res.status} body=${errText.slice(0, 300)}`);
          throw new Error(`HTTP ${res.status}: ${errText.slice(0, 300)}`);
        }

        const reader = (res.body as any).getReader();
        const decoder = new TextDecoder();
        let sseBuffer = '';
        let accText = '';
        const contentBlocks: Record<number, { type: string; id?: string; name?: string; inputJson: string }> = {};
        let finalUsage: any = null;
        let stopReason: string | null = null;

        streamLoop: while (true) {
          if (abortFlag) break;
          let chunkData: { done: boolean; value?: Uint8Array };
          try { chunkData = await reader.read(); } catch { break; }
          if (chunkData.done) break;
          sseBuffer += decoder.decode(chunkData.value, { stream: true });
          const lines = sseBuffer.split('\n');
          sseBuffer = lines.pop() ?? '';
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6);
            let evt: any;
            try { evt = JSON.parse(data); } catch { continue; }
            switch (evt.type) {
              case 'message_start':
                if (evt.message?.usage) finalUsage = { ...finalUsage, ...evt.message.usage };
                break;
              case 'content_block_start':
                contentBlocks[evt.index] = { type: evt.content_block.type, inputJson: '' };
                if (evt.content_block.type === 'tool_use') {
                  contentBlocks[evt.index].id = evt.content_block.id;
                  contentBlocks[evt.index].name = evt.content_block.name;
                }
                break;
              case 'content_block_delta':
                if (evt.delta.type === 'text_delta' && evt.delta.text) {
                  accText += evt.delta.text;
                  textWasStreamed = true;
                  onEvent({ type: 'text', text: evt.delta.text });
                } else if (evt.delta.type === 'input_json_delta') {
                  if (contentBlocks[evt.index]) contentBlocks[evt.index].inputJson += evt.delta.partial_json;
                }
                break;
              case 'message_delta':
                if (evt.delta?.stop_reason) stopReason = evt.delta.stop_reason;
                if (evt.usage) finalUsage = { ...finalUsage, ...evt.usage };
                break;
              case 'message_stop':
                break streamLoop;
            }
          }
        }

        const assembledContent: any[] = [];
        if (accText) assembledContent.push({ type: 'text', text: accText });
        for (const block of Object.values(contentBlocks)) {
          if (block.type === 'tool_use') {
            let inputObj: any = {};
            try { inputObj = JSON.parse(block.inputJson || '{}'); } catch {}
            assembledContent.push({ type: 'tool_use', id: block.id, name: block.name, input: inputObj });
          }
        }
        const hasTools = assembledContent.some((b: any) => b.type === 'tool_use');
        console.log(`[AI] Anthropic stream done: textLen=${accText.length} toolBlocks=${assembledContent.filter((b: any) => b.type === 'tool_use').length} stopReason=${stopReason}`);
        resJson = {
          content: assembledContent,
          stop_reason: stopReason || (hasTools ? 'tool_use' : 'end_turn'),
          usage: finalUsage,
        };
      } else {
        // ── Non-streaming path ──
        const res = await net.fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': config.apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: config.model,
            max_tokens: 4096,
            system: systemMsg,
            messages: conversation,
            tools,
          }),
          signal: controller.signal as any,
        });
        clearTimeout(timer);
        const text = await res.text();
        console.log(`[AI] Anthropic status=${res.status} body=${text.slice(0, 300)}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
        resJson = JSON.parse(text);
      }
    } catch (err: any) {
      clearTimeout(timer);
      if (abortFlag) {
        onEvent({ type: 'done', text: '(Stopped by user)' });
      } else if (err.name === 'AbortError') {
        onEvent({ type: 'error', error: 'Request timed out (180s)' });
      } else {
        onEvent({ type: 'error', error: err.message });
      }
      return;
    }

    // Emit token usage
    if (resJson.usage) {
      onEvent({ type: 'token_usage', inputTokens: resJson.usage.input_tokens || 0, outputTokens: resJson.usage.output_tokens || 0 });
    }

    const content = resJson.content || [];
    const stopReason = resJson.stop_reason;

    // Extract text and tool_use blocks
    let textParts: string[] = [];
    let toolUseBlocks: any[] = [];

    for (const block of content) {
      if (block.type === 'text' && block.text) {
        textParts.push(block.text);
      } else if (block.type === 'tool_use') {
        toolUseBlocks.push(block);
      }
    }

    // Check for tool calls
    if (stopReason === 'tool_use' || toolUseBlocks.length > 0) {
      // Emit any text content alongside tool calls (skip if already streamed)
      if (textParts.length > 0 && !textWasStreamed) {
        onEvent({ type: 'text', text: textParts.join('\n') });
      }
      // Add assistant message to conversation
      conversation.push({ role: 'assistant', content });

      // Separate sub_agent calls (parallel) from regular calls (sequential)
      const subAgentBlocks = toolUseBlocks.filter((tu: any) => tu.name === 'sub_agent');
      const regularBlocks = toolUseBlocks.filter((tu: any) => tu.name !== 'sub_agent');

      const toolResults: any[] = [];

      // Execute regular tools sequentially
      for (const tu of regularBlocks) {
        const fnName = tu.name || '';
        const fnArgs = tu.input || {};

        onEvent({ type: 'tool_call', toolName: fnName, toolArgs: fnArgs });
        console.log(`[AI] Tool call: ${fnName}(${JSON.stringify(fnArgs).slice(0, 200)})`);

        const result = await executeTool(fnName, fnArgs);
        const truncatedResult = result.result.length > 16000
          ? result.result.slice(0, 16000) + '\n... (truncated)'
          : result.result;

        onEvent({ type: 'tool_result', toolName: fnName, toolResult: truncatedResult, toolOk: result.ok });
        console.log(`[AI] Tool result: ok=${result.ok} len=${result.result.length}`);
        toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: truncatedResult, is_error: !result.ok });
      }

      // Execute sub-agents in PARALLEL
      if (subAgentBlocks.length > 0) {
        console.log(`[AI] Launching ${subAgentBlocks.length} sub-agent(s) in parallel`);
        const subResults = await Promise.all(subAgentBlocks.map(async (tu: any) => {
          const task = tu.input?.task || '';
          const name = task.slice(0, 40);

          onEvent({ type: 'tool_call', toolName: 'sub_agent', toolArgs: tu.input || {}, agentName: name });
          console.log(`[AI] Sub-agent start: "${name}"`);

          const result = await runSubAgent(config, 'anthropic', task, name, onEvent);
          const truncated = result.length > 16000 ? result.slice(0, 16000) + '\n...(truncated)' : result;

          onEvent({ type: 'tool_result', toolName: 'sub_agent', toolResult: truncated.slice(0, 200), toolOk: true, agentName: name });
          console.log(`[AI] Sub-agent done: "${name}" len=${result.length}`);

          return { id: tu.id, content: truncated };
        }));

        for (const { id, content: c } of subResults) {
          toolResults.push({ type: 'tool_result', tool_use_id: id, content: c, is_error: false });
        }
      }

      // Add tool results as user message
      conversation.push({ role: 'user', content: toolResults });
      continue;
    }

    // No tool calls — check if goal is complete
    const responseText = textParts.join('\n');

    if (responseText.includes(GOAL_COMPLETE_MARKER) || goalChecks >= MAX_GOAL_CHECKS) {
      const cleanText = responseText.replace(GOAL_COMPLETE_MARKER, '').trim();
      // Include the final assistant text in history for memory extraction
      if (cleanText) conversation.push({ role: 'assistant', content: [{ type: 'text', text: cleanText }] });
      const history = conversation.filter(m => m.content !== GOAL_CHECK_PROMPT);
      onEvent({ type: 'done', text: cleanText, conversationHistory: history });
      return;
    }

    // Emit text, then inject goal check (skip if already streamed)
    if (!textWasStreamed) onEvent({ type: 'text', text: responseText });
    conversation.push({ role: 'assistant', content: [{ type: 'text', text: responseText }] });
    conversation.push({ role: 'user', content: GOAL_CHECK_PROMPT });
    goalChecks++;
    console.log(`[AI] Goal check ${goalChecks}/${MAX_GOAL_CHECKS} — continuing...`);
    onEvent({ type: 'thinking' });
    continue;
  }

  onEvent({ type: 'error', error: `Max tool rounds (${MAX_TOOL_ROUNDS}) reached` });
}

// ==================== 统一入口 ====================
export async function aiChatWithTools(
  provider: string,
  config: AiConfig,
  messages: ChatMessage[],
  onEvent: (evt: ToolEvent) => void,
): Promise<void> {
  abortFlag = false;
  currentAbortController = null;
  if (provider === 'anthropic') {
    await anthropicToolLoop(config, messages, onEvent);
  } else {
    await openaiToolLoop(config, messages, onEvent);
  }
}

// Simple chat (no tools) - kept for backward compatibility
export async function aiChat(
  provider: string,
  config: AiConfig,
  messages: ChatMessage[],
): Promise<{ ok: boolean; data?: string; error?: string }> {
  return new Promise((resolve) => {
    let fullText = '';
    aiChatWithTools(provider, config, messages, (evt) => {
      if (evt.type === 'text') fullText += (evt.text || '');
      else if (evt.type === 'done') resolve({ ok: true, data: fullText || (evt.text || '') });
      else if (evt.type === 'error') resolve({ ok: false, error: evt.error });
    });
  });
}
