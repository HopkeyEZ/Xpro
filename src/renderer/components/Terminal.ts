export interface TerminalInstance {
  log: (msg: string) => void;
  error: (msg: string) => void;
  clear: () => void;
}

export function initTerminal(): TerminalInstance {
  const contentEl = document.getElementById('terminal-content')!;
  const clearBtn = document.getElementById('btn-clear-terminal')!;

  function appendLine(text: string, color?: string) {
    const line = document.createElement('div');
    line.style.color = color ?? 'var(--editor-fg)';
    const timestamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    line.textContent = `[${timestamp}] ${text}`;
    contentEl.appendChild(line);
    contentEl.scrollTop = contentEl.scrollHeight;
  }

  function log(msg: string) {
    appendLine(msg);
  }

  function error(msg: string) {
    appendLine(msg, 'var(--error)');
  }

  function clear() {
    contentEl.innerHTML = '';
  }

  clearBtn.addEventListener('click', clear);

  return { log, error, clear };
}
