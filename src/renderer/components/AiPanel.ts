import { ConfigService, type XproConfig } from '../services/ConfigService';

interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: any;
}

export interface AiPanelInstance {
  showSettings: () => void;
}

export function initAiPanel(config: XproConfig): AiPanelInstance {
  const messagesEl = document.getElementById('ai-messages')!;
  const inputEl = document.getElementById('ai-input') as HTMLTextAreaElement;
  const sendBtn = document.getElementById('btn-ai-send') as HTMLButtonElement;
  const providerSelect = document.getElementById('ai-provider-select') as HTMLSelectElement;
  const aiStatusEl = document.getElementById('ai-status')!;

  let chatHistory: ChatMessage[] = [
    {
      role: 'system',
      content: '你是 Xpro IDE 内置的编程助手。帮助用户编写代码、调试问题、解释概念。回复简洁专业，代码用 markdown 代码块包裹。',
    },
  ];
  let sending = false;
  let currentStreamId = '';

  // 初始化 provider 选择
  if (config.ai.provider) {
    providerSelect.value = config.ai.provider;
    aiStatusEl.textContent = `🤖 ${config.ai.provider} · ${config.ai.model}`;
  }

  providerSelect.addEventListener('change', () => {
    config.ai.provider = providerSelect.value as any;
    ConfigService.save(config);
    updateStatusText();
  });

  function updateStatusText() {
    if (config.ai.provider && config.ai.model) {
      aiStatusEl.textContent = `🤖 ${config.ai.provider} · ${config.ai.model}`;
    } else {
      aiStatusEl.textContent = '🤖 未配置 AI';
    }
  }

  function appendMessage(role: 'user' | 'assistant', content: string) {
    const msgEl = document.createElement('div');
    msgEl.className = `ai-msg ${role}`;
    const bubble = document.createElement('div');
    bubble.className = 'ai-bubble';
    bubble.innerHTML = escapeAndFormat(content);
    msgEl.appendChild(bubble);
    messagesEl.appendChild(msgEl);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return bubble;
  }

  function escapeAndFormat(text: string): string {
    // 简单 markdown: 代码块
    let html = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    // 代码块
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, lang, code) => {
      return `<pre><code class="lang-${lang}">${code}</code></pre>`;
    });
    // 行内代码
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    // 换行
    html = html.replace(/\n/g, '<br>');
    return html;
  }

  async function sendMessage() {
    const text = inputEl.value.trim();
    if (!text || sending) return;

    if (!config.ai.provider || !config.ai.apiKey) {
      appendMessage('assistant', '⚠️ 请先在「AI 配置」中设置 API 信息');
      return;
    }

    sending = true;
    sendBtn.disabled = true;
    sendBtn.textContent = '发送中…';
    inputEl.value = '';

    // Check for annotation attachment
    const aiPanel = document.getElementById('ai-panel')!;
    const annotationImage = aiPanel.dataset.annotationImage;
    const annotationCode = aiPanel.dataset.annotationCode;
    const annotationFile = aiPanel.dataset.annotationFile;

    let userContent: any;
    let displayText: string;

    if (annotationImage && annotationCode) {
      const fileName = annotationFile?.split(/[\\/]/).pop() || 'unknown';
      const userRequest = text.replace(/^\[📎[^\]]*\]\n文件:[^\n]*\n\n/, '').trim();
      const contextText = `[重要：用户在前端预览页面上用红色笔圈选了上图中的部分区域]\n\n⚠️ 请只修改以下文件，不要修改之前对话中提到的其他文件：\n文件路径: ${annotationFile}\n\n该文件的完整代码 (${fileName}):\n\`\`\`\n${annotationCode}\n\`\`\`\n\n用户需求: ${userRequest || '请根据我圈选的区域进行修改'}`;

      if (config.ai.provider === 'anthropic') {
        // Anthropic multipart: image + text blocks
        userContent = [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: annotationImage,
            },
          },
          { type: 'text', text: contextText },
        ];
      } else {
        // OpenAI multipart: image_url + text blocks
        userContent = [
          {
            type: 'image_url',
            image_url: {
              url: `data:image/png;base64,${annotationImage}`,
              detail: 'high',
            },
          },
          { type: 'text', text: contextText },
        ];
      }
      displayText = `📎 [页面标注截图 — ${fileName}]\n\n${userRequest || '请根据我圈选的区域进行修改'}`;

      // Clean up annotation data
      delete aiPanel.dataset.annotationImage;
      delete aiPanel.dataset.annotationCode;
      delete aiPanel.dataset.annotationFile;
      const indicator = document.getElementById('annotation-indicator');
      if (indicator) indicator.style.display = 'none';
    } else {
      userContent = text;
      displayText = text;
    }

    chatHistory.push({ role: 'user', content: userContent });
    appendMessage('user', displayText);

    // 创建 assistant 占位气泡
    const bubble = appendMessage('assistant', '');
    let fullResponse = '';

    const requestId = `req-${Date.now()}`;
    currentStreamId = requestId;

    // Listen for tool events
    window.xpro.onAiToolEvent((rid: string, evt: any) => {
      if (rid !== currentStreamId) return;
      if (evt.type === 'text' || evt.type === 'done') {
        fullResponse += (evt.text || '');
        bubble.innerHTML = escapeAndFormat(fullResponse);
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }
      if (evt.type === 'tool_call') {
        fullResponse += `\n[Tool: ${evt.toolName}]\n`;
        bubble.innerHTML = escapeAndFormat(fullResponse);
      }
      if (evt.type === 'tool_result') {
        fullResponse += `[Result: ${evt.toolOk ? 'OK' : 'ERR'}]\n`;
        bubble.innerHTML = escapeAndFormat(fullResponse);
      }
      if (evt.type === 'done') {
        chatHistory.push({ role: 'assistant', content: fullResponse });
        sending = false;
        sendBtn.disabled = false;
        sendBtn.textContent = '发送';
      }
      if (evt.type === 'error') {
        bubble.innerHTML = escapeAndFormat(`Error: ${evt.error}`);
        sending = false;
        sendBtn.disabled = false;
        sendBtn.textContent = '发送';
      }
    });

    await window.xpro.aiChatWithTools(
      config.ai.provider,
      { baseUrl: config.ai.baseUrl, apiKey: config.ai.apiKey, model: config.ai.model },
      chatHistory,
      requestId,
    );
  }

  // 发送按钮
  sendBtn.addEventListener('click', sendMessage);

  // Ctrl+Enter 发送
  inputEl.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === 'Enter') {
      e.preventDefault();
      sendMessage();
    }
  });

  // 设置窗口
  function showSettings() {
    const existing = document.getElementById('ai-settings-modal');
    if (existing) { existing.remove(); return; }

    const modal = document.createElement('div');
    modal.id = 'ai-settings-modal';
    modal.style.cssText = `
      position: fixed; top: 50%; left: 50%; transform: translate(-50%,-50%);
      background: var(--bg-panel); border: 1px solid var(--border);
      border-radius: 10px; padding: 24px; z-index: 9999;
      min-width: 420px; box-shadow: 0 8px 32px rgba(0,0,0,0.5);
    `;
    modal.innerHTML = `
      <h3 style="margin-bottom:16px; color:var(--text-primary)">AI 模型配置</h3>
      <label style="color:var(--text-secondary);font-size:12px">协议</label>
      <select id="cfg-provider" style="width:100%;margin-bottom:10px;padding:6px;background:var(--bg-input);color:var(--text-primary);border:1px solid var(--border);border-radius:4px">
        <option value="openai" ${config.ai.provider==='openai'?'selected':''}>OpenAI</option>
        <option value="anthropic" ${config.ai.provider==='anthropic'?'selected':''}>Anthropic</option>
      </select>
      <label style="color:var(--text-secondary);font-size:12px">API 地址</label>
      <input id="cfg-url" value="${config.ai.baseUrl}" style="width:100%;margin-bottom:10px;padding:6px;background:var(--bg-input);color:var(--text-primary);border:1px solid var(--border);border-radius:4px">
      <label style="color:var(--text-secondary);font-size:12px">API Key</label>
      <input id="cfg-key" type="password" value="${config.ai.apiKey}" style="width:100%;margin-bottom:10px;padding:6px;background:var(--bg-input);color:var(--text-primary);border:1px solid var(--border);border-radius:4px">
      <label style="color:var(--text-secondary);font-size:12px">模型</label>
      <input id="cfg-model" value="${config.ai.model}" style="width:100%;margin-bottom:16px;padding:6px;background:var(--bg-input);color:var(--text-primary);border:1px solid var(--border);border-radius:4px">
      <div style="display:flex;gap:10px;justify-content:flex-end">
        <button id="cfg-cancel" style="padding:6px 16px;border:1px solid var(--border);background:none;color:var(--text-secondary);border-radius:6px;cursor:pointer">取消</button>
        <button id="cfg-save" style="padding:6px 16px;background:var(--bg-accent);color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:600">💾 保存</button>
      </div>
    `;
    document.body.appendChild(modal);

    document.getElementById('cfg-cancel')!.addEventListener('click', () => modal.remove());
    document.getElementById('cfg-save')!.addEventListener('click', async () => {
      config.ai.provider = (document.getElementById('cfg-provider') as HTMLSelectElement).value as any;
      config.ai.baseUrl = (document.getElementById('cfg-url') as HTMLInputElement).value;
      config.ai.apiKey = (document.getElementById('cfg-key') as HTMLInputElement).value;
      config.ai.model = (document.getElementById('cfg-model') as HTMLInputElement).value;
      await ConfigService.save(config);
      providerSelect.value = config.ai.provider;
      updateStatusText();
      modal.remove();
    });
  }

  // 欢迎消息
  appendMessage('assistant', '你好！我是 Xpro AI 助手。\n\n支持 **OpenAI** 和 **Anthropic** 协议。请在「AI 配置」中设置后开始使用。\n\n快捷键：`Ctrl+Enter` 发送消息。');

  return { showSettings };
}
