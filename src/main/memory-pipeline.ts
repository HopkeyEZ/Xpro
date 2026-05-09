/**
 * Memory Ingestion Pipeline
 *
 * Extracts structured memories from AI conversations using LLM.
 * Pipeline: Conversation → LLM Extraction → Classification → Store
 */

import { net } from 'electron';
import { MemoryType, storeMemories } from './memory-store';

interface AiConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  provider?: string;
  lang?: string;
}

interface ChatMessage {
  role: string;
  content: string;
}

function getExtractionPrompt(lang: string): string {
  const langInstruction = lang === 'zh'
    ? '\n\nIMPORTANT: Write ALL memory content and searchQueries in Chinese (the same language as the conversation). The topicKey should remain in lowercase English.'
    : '';

  return `You are a memory extraction system for a software project. Analyze the conversation and extract ALL useful information as structured memories.

For each memory, classify it as one of:
- **fact**: Technologies, frameworks, project structure, configurations, architecture decisions, file purposes
- **event**: Code changes made, bugs fixed, features added, files created or modified
- **instruction**: Coding conventions, how-to rules, setup steps, build commands
- **task**: Work in progress, planned features, known issues

Rules:
1. Be AGGRESSIVE about extracting. Any technical detail about the project is worth remembering.
2. Extract architecture info: tech stack, frameworks, folder structure, database choice, API patterns.
3. Extract what was done: files modified, features implemented, bugs fixed, commands run.
4. Each memory should be a single, atomic statement.
5. For facts and instructions, provide a short topicKey (2-4 words, lowercase English, like "tech-stack", "project-structure").
6. For each memory, generate 2-3 search queries that someone might use to find this information.
7. If the conversation updates a previous fact, extract the NEW value.
8. You MUST extract at least 1 memory from any non-trivial conversation.${langInstruction}

Respond in this exact JSON format (no markdown, no code fences):
[
  {
    "type": "fact",
    "topicKey": "tech-stack",
    "content": "Project uses Spring Boot backend with Vue.js frontend",
    "searchQueries": ["what framework", "tech stack", "frontend backend"]
  }
]

Only respond with [] if the conversation is literally empty or just greetings.`;
}

/**
 * Extract memories from a conversation using LLM.
 */
export async function extractMemories(
  config: AiConfig,
  messages: ChatMessage[],
  projectPath: string,
  sessionId: string,
): Promise<{ ok: boolean; stored: number; error?: string }> {
  console.log(`[Memory-Pipeline] Called with model=${config.model}, baseUrl=${config.baseUrl}, hasKey=${!!config.apiKey}, messages=${messages.length}`);
  if (!config.apiKey || !config.baseUrl) {
    console.log('[Memory-Pipeline] Skipped: missing apiKey or baseUrl');
    return { ok: false, stored: 0, error: 'No AI config' };
  }

  // Build the conversation text for extraction
  const conversationText = messages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => {
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      return `[${m.role}]: ${content}`;
    })
    .join('\n\n');

  console.log(`[Memory-Pipeline] Conversation text length=${conversationText.length}, first 200 chars: ${conversationText.slice(0, 200)}`);
  if (conversationText.length < 50) {
    console.log('[Memory-Pipeline] Skipped: conversation text too short');
    return { ok: true, stored: 0 }; // Too short, nothing to extract
  }

  // Truncate if too long (keep last 8000 chars which are most relevant)
  const truncated = conversationText.length > 10000
    ? '...(earlier messages omitted)\n\n' + conversationText.slice(-8000)
    : conversationText;

  const base = config.baseUrl.replace(/\/+$/, '');
  const isAnthropic = config.provider === 'anthropic' || base.includes('anthropic');
  const extractionPrompt = getExtractionPrompt(config.lang || 'en');

  try {
    let responseText: string;

    if (isAnthropic) {
      const res = await net.fetch(`${base}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': config.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: config.model,
          max_tokens: 2048,
          system: extractionPrompt,
          messages: [{ role: 'user', content: `Extract memories from this conversation:\n\n${truncated}` }],
        }),
      });
      if (!res.ok) {
        const errText = await res.text();
        return { ok: false, stored: 0, error: `HTTP ${res.status}: ${errText.slice(0, 200)}` };
      }
      const json = await res.json() as any;
      responseText = json.content?.[0]?.text || '[]';
    } else {
      const isDeepSeek = base.includes('deepseek');
      const bodyObj: any = {
        model: config.model,
        temperature: 0.3,
        messages: [
          { role: 'system', content: extractionPrompt },
          { role: 'user', content: `Extract memories from this conversation:\n\n${truncated}` },
        ],
      };
      // DeepSeek: disable thinking mode for extraction (saves tokens, avoids empty content)
      if (isDeepSeek) {
        bodyObj.thinking = { type: 'disabled' };
        bodyObj.response_format = { type: 'json_object' };
        bodyObj.temperature = 0;
      }
      console.log(`[Memory-Pipeline] POST ${base}/chat/completions | model=${bodyObj.model} | isDeepSeek=${isDeepSeek} | userMsgLen=${bodyObj.messages[1]?.content?.length}`);
      const res = await net.fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(bodyObj),
      });
      if (!res.ok) {
        const errText = await res.text();
        return { ok: false, stored: 0, error: `HTTP ${res.status}: ${errText.slice(0, 200)}` };
      }
      const rawText = await res.text();
      console.log(`[Memory-Pipeline] Raw API response (${rawText.length} chars): ${rawText.slice(0, 600)}`);
      const json = JSON.parse(rawText);
      const msg = json.choices?.[0]?.message;
      // DeepSeek thinking models may put content in reasoning_content
      responseText = msg?.content || msg?.reasoning_content || '[]';
    }

    console.log(`[Memory-Pipeline] LLM raw response (${responseText.length} chars): ${responseText.slice(0, 500)}`);

    // Parse the JSON response
    // Strip markdown code fences if present
    let cleaned = responseText.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
    }

    let extracted: Array<{
      type: MemoryType;
      topicKey: string;
      content: string;
      searchQueries: string[];
    }>;

    try {
      const parsed = JSON.parse(cleaned);
      // Handle both direct array and wrapped object (e.g. DeepSeek json_object mode: {"memories": [...]})
      if (Array.isArray(parsed)) {
        extracted = parsed;
      } else if (typeof parsed === 'object' && parsed !== null) {
        // Find the first array value in the object
        const arrVal = Object.values(parsed).find(v => Array.isArray(v));
        extracted = (arrVal as any[]) || [];
      } else {
        extracted = [];
      }
    } catch {
      console.error('[Memory] Failed to parse extraction response:', cleaned.slice(0, 200));
      return { ok: false, stored: 0, error: 'Failed to parse LLM response' };
    }

    if (!Array.isArray(extracted) || extracted.length === 0) {
      console.log('[Memory-Pipeline] LLM returned empty array or non-array');
      return { ok: true, stored: 0, error: `LLM returned ${JSON.stringify(extracted).slice(0, 100)}` };
    }

    // Validate and store
    const valid = extracted.filter(m =>
      ['fact', 'event', 'instruction', 'task'].includes(m.type) &&
      typeof m.content === 'string' &&
      m.content.length > 5,
    );

    const result = storeMemories(
      projectPath,
      valid.map(m => ({
        type: m.type,
        topicKey: m.topicKey || '',
        content: m.content,
        searchQueries: Array.isArray(m.searchQueries) ? m.searchQueries : [],
        sessionId,
      })),
    );

    console.log(`[Memory] Extracted ${valid.length}, stored ${result.stored}, superseded ${result.superseded}, dupes ${result.duplicates}`);
    return { ok: true, stored: result.stored };
  } catch (err: any) {
    console.error('[Memory] Extraction error:', err);
    return { ok: false, stored: 0, error: err.message };
  }
}

/**
 * AI-powered batch categorization of file changes.
 * Takes a list of {id, label, filePath} and returns a mapping of id -> category.
 */
export async function categorizeChanges(
  config: AiConfig,
  changes: Array<{ id: string; label: string; filePath: string }>,
): Promise<Record<string, string>> {
  if (!config.apiKey || !config.baseUrl || changes.length === 0) return {};

  const changeList = changes.map((c, i) =>
    `${i + 1}. [${c.id}] ${c.filePath.split(/[\\/]/).pop()} — ${c.label}`
  ).join('\n');

  const prompt = `You are a code change categorizer. Given the following file changes, group them into categories based on their impact area.

Categories should be short labels like: Frontend UI, Backend API, Styles/CSS, Config, Database, Routing, State Management, Build/Deploy, Tests, Documentation, etc. Use Chinese labels.

If multiple changes affect the same area, give them the same category. Use at most 5-6 categories.

Changes:
${changeList}

Respond with ONLY a JSON object mapping each change ID to its category. Example:
{"cp_123": "前端UI", "cp_456": "后端API", "cp_789": "前端UI"}

JSON:`;

  try {
    const base = config.baseUrl.replace(/\/+$/, '');
    const isDeepSeek = base.includes('deepseek');
    const bodyObj: any = {
      model: config.model,
      max_tokens: 500,
      temperature: 0,
      messages: [{ role: 'user', content: prompt }],
    };
    if (isDeepSeek) {
      bodyObj.thinking = { type: 'disabled' };
      bodyObj.response_format = { type: 'json_object' };
    }

    const res = await net.fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(bodyObj),
    });
    if (!res.ok) return {};

    const json = await res.json() as any;
    const text = json.choices?.[0]?.message?.content || '';
    // Extract JSON from response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return {};
    const parsed = JSON.parse(jsonMatch[0]);
    // Validate: must be Record<string, string>
    const result: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'string') result[k] = v;
    }
    console.log(`[Memory-Pipeline] Categorized ${Object.keys(result).length} changes`);
    return result;
  } catch (e) {
    console.warn('[Memory-Pipeline] categorizeChanges error:', e);
    return {};
  }
}

/**
 * Generate a short summary title for a file change using LLM.
 */
export async function summarizeFileChange(
  config: AiConfig,
  filePath: string,
  oldContent: string,
  newContent: string,
): Promise<string> {
  if (!config.apiKey || !config.baseUrl) return '';

  const fileName = filePath.split(/[\\/]/).pop() || filePath;
  // Build a compact diff (max 2000 chars)
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');
  const diffParts: string[] = [];
  const maxDiffLen = 2000;
  let len = 0;
  for (let i = 0; i < Math.max(oldLines.length, newLines.length); i++) {
    if (len > maxDiffLen) break;
    if (i < oldLines.length && i < newLines.length && oldLines[i] !== newLines[i]) {
      diffParts.push(`- ${oldLines[i]}`);
      diffParts.push(`+ ${newLines[i]}`);
      len += oldLines[i].length + newLines[i].length + 4;
    } else if (i >= oldLines.length && i < newLines.length) {
      diffParts.push(`+ ${newLines[i]}`);
      len += newLines[i].length + 2;
    } else if (i < oldLines.length && i >= newLines.length) {
      diffParts.push(`- ${oldLines[i]}`);
      len += oldLines[i].length + 2;
    }
  }

  const prompt = `You are a code change summarizer. Given the file name and diff below, write a SINGLE short sentence (max 15 words) in Chinese summarizing what was changed. No quotes, no markdown.

File: ${fileName}
Diff:
${diffParts.join('\n').slice(0, maxDiffLen)}`;

  try {
    const base = config.baseUrl.replace(/\/+$/, '');
    const isAnthropic = config.provider === 'anthropic' || base.includes('anthropic');
    let responseText: string;

    if (isAnthropic) {
      const res = await net.fetch(`${base}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': config.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: config.model,
          max_tokens: 100,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      if (!res.ok) return '';
      const json = await res.json() as any;
      responseText = json.content?.[0]?.text || '';
    } else {
      const res = await net.fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
          max_tokens: 100,
          temperature: 0.1,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      if (!res.ok) return '';
      const json = await res.json() as any;
      responseText = json.choices?.[0]?.message?.content || '';
    }
    return responseText.trim().slice(0, 80);
  } catch (e) {
    console.warn('[Memory] summarizeFileChange error:', e);
    return '';
  }
}
