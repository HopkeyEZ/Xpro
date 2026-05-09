import * as monaco from 'monaco-editor';

export interface EditorTab {
  id: string;
  title: string;
  path: string | null;
  model: monaco.editor.ITextModel;
  modified: boolean;
  language: string;
}

export interface EditorInstance {
  monacoEditor: monaco.editor.IStandaloneCodeEditor;
  tabs: EditorTab[];
  activeTabId: string | null;
  newTab: () => void;
  openFile: (path: string, title: string, content: string) => void;
  saveCurrent: () => void;
  getActiveTab: () => EditorTab | null;
}

let tabIdCounter = 0;
function nextTabId(): string {
  return `tab-${++tabIdCounter}`;
}

function detectLanguage(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    rs: 'rust', py: 'python', js: 'javascript', jsx: 'javascript',
    ts: 'typescript', tsx: 'typescript', java: 'java',
    c: 'c', h: 'c', cpp: 'cpp', cxx: 'cpp', cc: 'cpp', hpp: 'cpp',
    go: 'go', html: 'html', htm: 'html', css: 'css',
    json: 'json', toml: 'toml', yaml: 'yaml', yml: 'yaml',
    md: 'markdown', sql: 'sql', sh: 'shell', bash: 'shell',
    xml: 'xml', vue: 'html',
  };
  return map[ext] ?? 'plaintext';
}

export function initEditor(): EditorInstance {
  const container = document.getElementById('editor-container')!;
  const tabBar = document.getElementById('editor-tabs')!;

  const monacoEditor = monaco.editor.create(container, {
    value: '// 欢迎使用 Xpro IDE\n// 打开文件夹开始编程\n',
    language: 'plaintext',
    theme: 'vs-dark',
    fontSize: 14,
    fontFamily: "'Cascadia Code', 'Consolas', 'Courier New', monospace",
    minimap: { enabled: true },
    wordWrap: 'off',
    tabSize: 4,
    smoothScrolling: true,
    cursorBlinking: 'smooth',
    cursorSmoothCaretAnimation: 'on',
    automaticLayout: true,
    padding: { top: 8 },
  });

  const tabs: EditorTab[] = [];
  let activeTabId: string | null = null;

  function renderTabs() {
    tabBar.innerHTML = '';
    for (const tab of tabs) {
      const el = document.createElement('div');
      el.className = `editor-tab${tab.id === activeTabId ? ' active' : ''}`;
      el.innerHTML = `
        <span class="${tab.modified ? 'tab-modified' : ''}">
          ${tab.modified ? '● ' : ''}${tab.title}
        </span>
        <span class="tab-close" data-id="${tab.id}">✕</span>
      `;
      el.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).classList.contains('tab-close')) {
          closeTab(tab.id);
        } else {
          switchTab(tab.id);
        }
      });
      tabBar.appendChild(el);
    }
  }

  function switchTab(id: string) {
    const tab = tabs.find(t => t.id === id);
    if (!tab) return;
    activeTabId = id;
    monacoEditor.setModel(tab.model);
    renderTabs();
  }

  function closeTab(id: string) {
    const idx = tabs.findIndex(t => t.id === id);
    if (idx < 0) return;
    tabs[idx].model.dispose();
    tabs.splice(idx, 1);
    if (tabs.length === 0) {
      newTab();
    } else if (activeTabId === id) {
      const next = tabs[Math.min(idx, tabs.length - 1)];
      switchTab(next.id);
    } else {
      renderTabs();
    }
  }

  function newTab() {
    const id = nextTabId();
    const model = monaco.editor.createModel('', 'plaintext');
    const tab: EditorTab = {
      id,
      title: '未命名',
      path: null,
      model,
      modified: false,
      language: 'plaintext',
    };
    model.onDidChangeContent(() => {
      if (!tab.modified) {
        tab.modified = true;
        renderTabs();
      }
    });
    tabs.push(tab);
    switchTab(id);
  }

  function openFile(path: string, title: string, content: string) {
    // 已打开则切换
    const existing = tabs.find(t => t.path === path);
    if (existing) {
      switchTab(existing.id);
      return;
    }

    const lang = detectLanguage(title);
    const id = nextTabId();
    const model = monaco.editor.createModel(content, lang);
    const tab: EditorTab = { id, title, path, model, modified: false, language: lang };
    model.onDidChangeContent(() => {
      if (!tab.modified) {
        tab.modified = true;
        renderTabs();
      }
    });
    tabs.push(tab);
    switchTab(id);
  }

  async function saveCurrent() {
    const tab = tabs.find(t => t.id === activeTabId);
    if (!tab) return;
    const content = tab.model.getValue();
    if (tab.path) {
      const res = await window.xpro.writeFile(tab.path, content);
      if (res.ok) {
        tab.modified = false;
        renderTabs();
      }
    } else {
      const savedPath = await window.xpro.saveFileAs(content);
      if (savedPath) {
        tab.path = savedPath;
        tab.title = savedPath.split(/[/\\]/).pop() ?? '未命名';
        tab.modified = false;
        renderTabs();
      }
    }
  }

  function getActiveTab(): EditorTab | null {
    return tabs.find(t => t.id === activeTabId) ?? null;
  }

  // 初始 tab
  newTab();

  return { monacoEditor, tabs, activeTabId, newTab, openFile, saveCurrent, getActiveTab };
}
