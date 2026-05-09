/**
 * AiService — AI 聊天服务，管理 Ask/Agent 模式切换和消息状态
 */

import { CheckpointService, FileSnapshot } from './CheckpointService';
import { ApprovalService } from './ApprovalService';
import { LintService } from './LintService';

export type AiMode = 'agent' | 'ask';

export interface AiConfig {
  openaiKey: string;
  openaiBase: string;
  anthropicKey: string;
  anthropicBase: string;
}

class AiServiceClass {
  private mode: AiMode = 'agent';
  private messages: Array<{ role: string; content: any }> = [];
  private running = false;
  private requestId = 0;
  private listeners: Array<() => void> = [];
  private config: AiConfig = {
    openaiKey: '', openaiBase: 'https://api.openai.com/v1',
    anthropicKey: '', anthropicBase: 'https://api.anthropic.com',
  };

  /** 获取当前模式 */
  getMode(): AiMode {
    return this.mode;
  }

  /** 切换模式 */
  setMode(mode: AiMode) {
    this.mode = mode;
    // Ask 模式下禁用审批（因为不会写文件）
    // Agent 模式下启用审批
    ApprovalService.setEnabled(mode === 'agent');
    this.notify();
  }

  /** 切换到另一个模式 */
  toggleMode(): AiMode {
    const newMode = this.mode === 'agent' ? 'ask' : 'agent';
    this.setMode(newMode);
    return newMode;
  }

  /** 获取配置 */
  getConfig(): AiConfig {
    return { ...this.config };
  }

  /** 设置配置 */
  setConfig(config: Partial<AiConfig>) {
    this.config = { ...this.config, ...config };
  }

  /** 获取消息列表 */
  getMessages() {
    return this.messages;
  }

  /** 清除消息 */
  clearMessages() {
    this.messages = [];
    this.notify();
  }

  /** 添加消息 */
  addMessage(role: string, content: any) {
    this.messages.push({ role, content });
  }

  /** 替换消息列表（恢复对话历史时） */
  setMessages(messages: Array<{ role: string; content: any }>) {
    this.messages = messages;
  }

  /** 生成请求 ID */
  nextRequestId(): string {
    return `req_${++this.requestId}_${Date.now()}`;
  }

  /** 是否正在运行 */
  isRunning(): boolean {
    return this.running;
  }

  setRunning(running: boolean) {
    this.running = running;
    this.notify();
  }

  /** 获取 Ask 模式的 system prompt（只读，无工具） */
  getAskSystemPrompt(rootFolder: string, lang: string): string {
    return [
      `You are an expert AI coding assistant in read-only mode inside the Xpro IDE.`,
      `You have VISION capability — you CAN see and analyze images/screenshots attached by the user.`,
      ``,
      `## Mode: ASK (Read-Only)`,
      `- You can ONLY read and analyze code. You CANNOT modify files or run commands.`,
      `- Provide explanations, suggestions, code reviews, and architectural advice.`,
      `- If the user asks you to make changes, explain what changes would be needed but DO NOT execute them.`,
      `- Suggest the user switch to Agent mode if they want actual modifications.`,
      ``,
      `## Environment`,
      `- OS: Windows`,
      `- Project root: ${rootFolder || '(not set)'}`,
      ``,
      `## Communication Style`,
      `- Be concise and direct.`,
      `- Use code blocks with syntax highlighting.`,
      `- Respond in ${lang === 'zh' ? 'Chinese' : 'the same language the user uses'}.`,
    ].join('\n');
  }

  /** 获取 Agent 模式的 system prompt（完整工具能力） */
  getAgentSystemPrompt(rootFolder: string, lang: string, memoryBlock: string): string {
    return [
      `You are an expert AI coding assistant operating inside the Xpro IDE.`,
      `You have direct access to the user's filesystem through tool calls: read_file, write_file, edit_file, list_directory, search_text, run_command.`,
      `You have VISION capability — you CAN see and analyze images/screenshots attached by the user. When the user sends an annotated screenshot, you MUST describe what you see and act on it. Never say you cannot see images.`,
      memoryBlock,
      `## CRITICAL: Action-First Principle`,
      `- You MUST actually EXECUTE tool calls to accomplish tasks. NEVER just describe or explain what you would do.`,
      `- When the user asks you to do something (open, modify, run, fix, create, etc.), IMMEDIATELY use the appropriate tools to DO IT.`,
      `- Wrong: "I will read the file and then edit it..." (just talking)`,
      `- Right: Actually call read_file, then call edit_file (actually doing it)`,
      `- Every response that involves code changes MUST include actual tool calls, not just analysis text.`,
      `- Show your analysis BRIEFLY, then execute. Do not explain without acting.`,
      ``,
      `## Environment`,
      `- OS: Windows`,
      `- Shell: PowerShell — commands run DIRECTLY in PowerShell. Do NOT prefix with "powershell -Command". Aliases work: ls, cat, cp, mv, rm, mkdir, echo, curl.`,
      `- Project root: ${rootFolder || '(not set)'}`,
      ``,
      `## Tool Usage Policy`,
      `- ALWAYS read a file before editing it. Never guess file contents.`,
      `- Use edit_file for surgical changes; old_text must match exactly including whitespace.`,
      `- Use write_file only for new files or full rewrites.`,
      `- Prefer search_text to locate code before making changes.`,
      `- Use list_directory to explore project structure before assuming paths.`,
      `- Use run_command for builds, tests, git, and other shell tasks. Commands run in PowerShell. Output is synced to the terminal panel.`,
      `- Execute multiple tool calls in sequence when needed — gather context first, then act.`,
      `- When a tool call fails, read the error, adjust, and retry.`,
      ``,
      `## Code Editing Discipline`,
      `- Make minimal, focused edits. Do not rewrite entire files when a small change suffices.`,
      `- Preserve existing code style, indentation, and comments.`,
      `- Do NOT add unnecessary error handling, compatibility shims, or dead code.`,
      `- After editing, verify the change is correct by reading the file back if uncertain.`,
      ``,
      `## Execution Flow`,
      `- Step 1: Briefly state what you will do (1-2 sentences max).`,
      `- Step 2: Execute tool calls to actually do it.`,
      `- Step 3: Report the result with tool output evidence.`,
      `- Never skip Step 2. If the user asks to "start a project", you must actually run commands. If they ask to "fix a bug", you must actually edit files.`,
      ``,
      `## Communication Style`,
      `- Be concise and direct. Brief analysis, then action, then result.`,
      `- After completing work, provide a short summary of what was done and the results.`,
      `- Respond in the same language the user uses.`,
      ``,
      `## Goal Awareness (Autonomous Completion)`,
      `- You operate in autonomous mode. Your job is to FULLY complete the user's request, not just partially.`,
      `- If the task has multiple steps, complete ALL steps with actual tool calls.`,
      `- After implementing changes, verify them: run builds/tests, read back edited files, check for errors.`,
      `- Do not stop halfway or ask "should I continue?" — just keep going until the goal is met.`,
      `- When you are certain the goal is fully achieved, include [GOAL_COMPLETE] in your final response.`,
    ].join('\n');
  }

  /** 在 AI 写文件前创建检查点 */
  async createFileCheckpoint(filePath: string, label: string): Promise<void> {
    try {
      const result = await (window as any).xpro.readFile(filePath);
      const snapshot: FileSnapshot = {
        path: filePath,
        content: result.ok ? result.data : '',
        timestamp: Date.now(),
      };
      CheckpointService.createCheckpoint(label, [snapshot]);
    } catch (e) {
      console.warn('[AiService] Checkpoint creation failed:', e);
    }
  }

  /** AI 修改后触发 lint 检测 */
  async triggerLint(filePath: string): Promise<string | null> {
    if (!LintService.isEnabled()) return null;
    const result = await LintService.lintFile(filePath);
    if (result && !result.passed) {
      return LintService.formatSummary([result]);
    }
    return null;
  }

  subscribe(fn: () => void) {
    this.listeners.push(fn);
    return () => { this.listeners = this.listeners.filter(l => l !== fn); };
  }

  private notify() {
    this.listeners.forEach(fn => fn());
  }
}

export const AiService = new AiServiceClass();
