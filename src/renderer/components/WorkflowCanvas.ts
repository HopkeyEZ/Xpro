/**
 * WorkflowCanvas – 将文件树以节点+连线的方式平铺在画布上
 * 支持：拖拽平移、滚轮缩放、节点拖拽、点击查看文件、自动树形布局
 */

import { CheckpointService, ApprovalService, LintService, AiService, AnnotationService } from '../services';

interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  children?: FileEntry[];
}

interface WfNode {
  id: string;
  name: string;
  path: string;
  isDir: boolean;
  x: number;
  y: number;
  parentId: string | null;
  el: HTMLDivElement | null;
  collapsed: boolean;
  loaded: boolean;
  childIds: string[];
}

interface WfEdge {
  from: string;
  to: string;
  pathEl: SVGPathElement | null;
}

const NODE_W = 180;
const NODE_H = 58;
const DIR_NODE_W = 200;
const H_GAP = 60;
const V_GAP = 16;

export class WorkflowCanvas {
  private viewport: HTMLElement;
  private canvas: HTMLElement;
  private svgLayer: SVGSVGElement;
  private nodesLayer: HTMLElement;
  private nodes: Map<string, WfNode> = new Map();
  private edges: WfEdge[] = [];
  private scale = 1;
  private panX = 0;
  private panY = 0;
  private isPanning = false;
  private panStartX = 0;
  private panStartY = 0;
  private selectedNodeId: string | null = null;
  private dragNodeId: string | null = null;
  private dragOffsetX = 0;
  private dragOffsetY = 0;
  private rootFolder: string = '';
  private editingPath: string | null = null;
  private originalContent: string = '';
  private isModified = false;
  private activeFilter: string = 'all';
  private searchQuery: string = '';
  private aiMessages: Array<{ role: string; content: string }> = [];
  private aiConfig: { openaiKey: string; openaiBase: string; anthropicKey: string; anthropicBase: string; thinking: boolean } = {
    openaiKey: '', openaiBase: 'https://api.openai.com/v1',
    anthropicKey: '', anthropicBase: 'https://api.anthropic.com',
    thinking: false,
  };
  private apiProfiles: Array<{ name: string; baseUrl: string; apiKey: string; model: string; provider: string }> = [];
  private activeProfile: string = '';
  private layoutDir: 'h' | 'v' = 'h';
  private autoCatTimer: number | null = null;
  private annotating = false;
  private annotateDrawing = false;
  private liveServerUrl: string | null = null;
  private liveRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private lang: 'en' | 'zh' = 'en';
  private totalInputTokens = 0;
  private totalOutputTokens = 0;
  private static i18n: Record<string, Record<string, string>> = {
    en: {
      openFolder: 'Open Folder', openFiles: 'Open Files', autoLayout: 'Auto Layout', fitView: 'Fit View',
      noFolder: 'No folder opened', nodes: 'nodes', search: 'Search files...',
      all: 'All', folders: 'Folders', terminal: 'Terminal', clear: 'Clear',
      cmdPlaceholder: 'Type a command...',
      aiTitle: 'AI Assistant', settings: 'Settings', aiPlaceholder: 'Ask AI to help with your code... (Enter to send, Shift+Enter for newline)',
      save: 'Save', modified: 'Modified',
      apiSettings: 'API Settings', savBtn: 'Apply', cancel: 'Cancel',
      savedProfiles: 'Saved Profiles', noProfiles: 'No saved profiles',
      profileName: 'Profile Name', profileNamePh: 'e.g. DeepSeek, OpenAI, Claude...',
      baseUrl: 'Base URL', apiKey: 'API Key', model: 'Model',
      modelPh: 'e.g. deepseek-v4-flash, gpt-4o', thinkingMode: 'Thinking Mode',
      saveProfile: 'Save Profile', use: 'Use', delete: 'Delete',
      ctxOpen: 'Open File', ctxConn: 'Show Connections', ctxCollapse: 'Collapse Children',
      annotate: 'Edit', annotateActive: 'Drawing...', restart: 'Restart',
    },
    zh: {
      openFolder: '打开文件夹', openFiles: '打开文件', autoLayout: '自动布局', fitView: '适应视图',
      noFolder: '未打开文件夹', nodes: '个节点', search: '搜索文件...',
      all: '全部', folders: '文件夹', terminal: '终端', clear: '清空',
      cmdPlaceholder: '输入命令...',
      aiTitle: 'AI 助手', settings: '设置', aiPlaceholder: '让 AI 帮你写代码... (Enter 发送, Shift+Enter 换行)',
      save: '保存', modified: '已修改',
      apiSettings: 'API 设置', savBtn: '应用', cancel: '取消',
      savedProfiles: '已保存配置', noProfiles: '暂无保存的配置',
      profileName: '配置名称', profileNamePh: '如 DeepSeek、OpenAI、Claude...',
      baseUrl: '接口地址', apiKey: '密钥', model: '模型',
      modelPh: '如 deepseek-v4-flash、gpt-4o', thinkingMode: '思考模式',
      saveProfile: '保存配置', use: '使用', delete: '删除',
      ctxOpen: '打开文件', ctxConn: '显示连接', ctxCollapse: '折叠子节点',
      annotate: '标注编辑', annotateActive: '绘制中...', restart: '重启',
    },
  };

  constructor() {
    this.viewport = document.getElementById('canvas-viewport')!;
    this.canvas = document.getElementById('canvas')!;
    this.svgLayer = document.getElementById('connections-layer')! as unknown as SVGSVGElement;
    this.nodesLayer = document.getElementById('nodes-layer')!;
    this.initEvents();
  }

  /* ========== 事件绑定 ========== */
  private initEvents() {
    // Pan
    this.viewport.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      if ((e.target as HTMLElement).closest('.wf-node')) return;
      this.isPanning = true;
      this.panStartX = e.clientX - this.panX;
      this.panStartY = e.clientY - this.panY;
    });

    window.addEventListener('mousemove', (e) => {
      if (this.isPanning) {
        this.panX = e.clientX - this.panStartX;
        this.panY = e.clientY - this.panStartY;
        this.applyTransform();
      }
      if (this.dragNodeId) {
        const node = this.nodes.get(this.dragNodeId);
        if (!node) return;
        node.x = (e.clientX - this.dragOffsetX - this.panX) / this.scale;
        node.y = (e.clientY - this.dragOffsetY - this.panY) / this.scale;
        this.positionNode(node);
        this.updateEdges();
        this.updateMinimap();
      }
    });

    window.addEventListener('mouseup', () => {
      this.isPanning = false;
      this.dragNodeId = null;
    });

    // Zoom
    this.viewport.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = this.viewport.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const delta = e.deltaY > 0 ? 0.9 : 1.1;
      const newScale = Math.min(3, Math.max(0.1, this.scale * delta));
      const ratio = newScale / this.scale;
      this.panX = mx - (mx - this.panX) * ratio;
      this.panY = my - (my - this.panY) * ratio;
      this.scale = newScale;
      this.applyTransform();
      document.getElementById('zoom-level')!.textContent = `${Math.round(this.scale * 100)}%`;
    }, { passive: false });

    // Context menu hide
    document.addEventListener('click', () => {
      document.getElementById('context-menu')!.classList.add('hidden');
    });

    // ── Detail panel resize handles (long-press 300ms to activate) ──
    {
      const dp = document.getElementById('detail-panel')!;
      const handles = dp.querySelectorAll('.detail-resize-handle');
      let resizing = false;
      let startX = 0, startY = 0;
      let startW = 0, startH = 0, startTop = 0, startLeft = 0;
      let mode = '';
      let dpPressTimer: ReturnType<typeof setTimeout> | null = null;

      handles.forEach(handle => {
        handle.addEventListener('mousedown', (e: Event) => {
          const me = e as MouseEvent;
          me.preventDefault();
          me.stopPropagation();
          const capturedX = me.clientX;
          const capturedY = me.clientY;
          let detectedMode = '';
          if ((handle as HTMLElement).classList.contains('left')) detectedMode = 'left';
          else if ((handle as HTMLElement).classList.contains('right')) detectedMode = 'right';
          else if ((handle as HTMLElement).classList.contains('bottom')) detectedMode = 'bottom';
          else if ((handle as HTMLElement).classList.contains('top')) detectedMode = 'top';
          else if ((handle as HTMLElement).classList.contains('corner-bl')) detectedMode = 'corner-bl';
          else if ((handle as HTMLElement).classList.contains('corner-tl')) detectedMode = 'corner-tl';
          else if ((handle as HTMLElement).classList.contains('corner-br')) detectedMode = 'corner-br';
          else if ((handle as HTMLElement).classList.contains('corner-tr')) detectedMode = 'corner-tr';

          dpPressTimer = setTimeout(() => {
            resizing = true;
            startX = capturedX;
            startY = capturedY;
            const rect = dp.getBoundingClientRect();
            startW = rect.width;
            startH = rect.height;
            startTop = rect.top;
            startLeft = rect.left;
            mode = detectedMode;
            document.body.style.cursor = getComputedStyle(handle as HTMLElement).cursor;
            document.body.style.userSelect = 'none';
          }, 300);
        });
      });

      document.addEventListener('mousemove', (e: MouseEvent) => {
        if (!resizing) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;

        if (mode === 'left' || mode === 'corner-bl' || mode === 'corner-tl') {
          dp.style.width = Math.max(320, startW - dx) + 'px';
        }
        if (mode === 'right' || mode === 'corner-br' || mode === 'corner-tr') {
          dp.style.width = Math.max(320, startW + dx) + 'px';
          dp.style.left = startLeft + 'px';
          dp.style.right = 'auto';
        }
        if (mode === 'bottom' || mode === 'corner-bl' || mode === 'corner-br') {
          dp.style.height = Math.max(200, startH + dy) + 'px';
        }
        if (mode === 'top' || mode === 'corner-tl' || mode === 'corner-tr') {
          dp.style.height = Math.max(200, startH - dy) + 'px';
          dp.style.top = (startTop + dy) + 'px';
        }
        dp.classList.add('user-resized');
      });

      document.addEventListener('mouseup', () => {
        if (dpPressTimer) { clearTimeout(dpPressTimer); dpPressTimer = null; }
        if (resizing) {
          resizing = false;
          document.body.style.cursor = '';
          document.body.style.userSelect = '';
        }
      });
    }

    // Detail panel close
    document.getElementById('detail-close')?.addEventListener('click', () => {
      const dp = document.getElementById('detail-panel')!;
      if (this.liveServerUrl) {
        // Just hide the panel, keep live server running; Preview button stays visible
        dp.classList.add('hidden');
        return;
      }
      dp.classList.add('hidden');
      dp.classList.remove('has-preview');
      document.getElementById('preview-pane')!.classList.add('hidden');
      (document.getElementById('preview-frame') as HTMLIFrameElement).srcdoc = '';
      this.editingPath = null;
    });

    // Preview refresh button
    document.getElementById('preview-refresh')?.addEventListener('click', () => {
      if (this.editingPath) {
        const ed = document.getElementById('detail-editor') as HTMLTextAreaElement;
        const ext = this.editingPath.split('.').pop()?.toLowerCase() || '';
        this.updatePreview(ed.value, ext, this.editingPath);
      }
    });

    // ── Annotation mode ──
    const annotateBtn = document.getElementById('preview-annotate')!;
    const annotateCanvas = document.getElementById('annotate-canvas') as HTMLCanvasElement;
    const annotateClearBtn = document.getElementById('annotate-clear')!;
    const annotateLabel = document.getElementById('annotate-label')!;

    annotateBtn.addEventListener('click', () => {
      this.annotating = !this.annotating;
      annotateBtn.classList.toggle('active', this.annotating);
      annotateCanvas.classList.toggle('hidden', !this.annotating);
      const t = WorkflowCanvas.i18n[this.lang];
      annotateLabel.textContent = this.annotating ? (t.annotateActive || 'Drawing...') : (t.annotate || 'Edit');
      if (this.annotating) {
        this.resizeAnnotateCanvas();
      } else {
        // Exiting annotation mode — clear canvas and remove attachment
        annotateClearBtn.classList.add('hidden');
        this.clearAnnotateCanvas();
        this.removeAnnotation();
      }
    });

    // Drawing on canvas
    annotateCanvas.addEventListener('mousedown', (e) => {
      this.annotateDrawing = true;
      const ctx = annotateCanvas.getContext('2d')!;
      const rect = annotateCanvas.getBoundingClientRect();
      ctx.beginPath();
      ctx.moveTo(e.clientX - rect.left, e.clientY - rect.top);
    });

    annotateCanvas.addEventListener('mousemove', (e) => {
      if (!this.annotateDrawing) return;
      const ctx = annotateCanvas.getContext('2d')!;
      const rect = annotateCanvas.getBoundingClientRect();
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#ef4444';
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.lineTo(e.clientX - rect.left, e.clientY - rect.top);
      ctx.stroke();
    });

    // Mouseup → auto-capture annotation and attach to AI
    annotateCanvas.addEventListener('mouseup', () => {
      if (this.annotateDrawing) {
        this.annotateDrawing = false;
        annotateClearBtn.classList.remove('hidden');
        this.captureAnnotation();
      }
    });

    annotateCanvas.addEventListener('mouseleave', () => {
      if (this.annotateDrawing) {
        this.annotateDrawing = false;
        annotateClearBtn.classList.remove('hidden');
        this.captureAnnotation();
      }
    });

    // Clear annotation strokes (allow re-drawing)
    annotateClearBtn.addEventListener('click', () => {
      this.clearAnnotateCanvas();
      annotateClearBtn.classList.add('hidden');
      this.removeAnnotation();
    });

    // Save button
    document.getElementById('detail-save')?.addEventListener('click', () => {
      this.saveCurrentFile();
    });

    // Editor input → mark modified + live preview update
    let previewDebounce: ReturnType<typeof setTimeout> | null = null;
    const editorEl = document.getElementById('detail-editor') as HTMLTextAreaElement;
    editorEl?.addEventListener('input', () => {
      if (editorEl.value !== this.originalContent) {
        this.markModified();
      } else {
        this.isModified = false;
        document.getElementById('detail-save')!.classList.add('hidden');
        document.getElementById('detail-modified')!.classList.add('hidden');
      }
      // Live preview with debounce (500ms)
      if (this.editingPath && this.isPreviewable(this.editingPath)) {
        if (previewDebounce) clearTimeout(previewDebounce);
        previewDebounce = setTimeout(() => {
          const ext = this.editingPath!.split('.').pop()?.toLowerCase() || '';
          this.updatePreview(editorEl.value, ext, this.editingPath!);
        }, 500);
      }
    });

    // Tab key inserts tab in textarea
    editorEl?.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        const start = editorEl.selectionStart;
        const end = editorEl.selectionEnd;
        editorEl.value = editorEl.value.substring(0, start) + '\t' + editorEl.value.substring(end);
        editorEl.selectionStart = editorEl.selectionEnd = start + 1;
        if (editorEl.value !== this.originalContent) this.markModified();
      }
    });

    // Ctrl+S to save
    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.key === 's') {
        e.preventDefault();
        if (this.editingPath && this.isModified) {
          this.saveCurrentFile();
        }
      }
    });

    // ── Auto-reload when AI modifies the currently open file ──
    window.xpro.onAiToolEvent((_rid: string, evt: any) => {
      if (evt.type === 'tool_result' && evt.toolOk && evt.toolName) {
        const name = evt.toolName;
        if (name === 'write_file' || name === 'edit_file') {
          if (this.editingPath) this.refreshOpenFile();
          this.refreshLivePreview();
        }
      }
    });

    // ── Auto-reload on external file system changes ──
    window.xpro.onFsChange((_dir: string) => {
      if (this.editingPath && !this.isModified) {
        this.refreshOpenFile();
      }
      this.refreshLivePreview();
    });

    // Context menu actions
    document.querySelectorAll('.ctx-item').forEach(item => {
      item.addEventListener('click', () => {
        const action = (item as HTMLElement).dataset.action;
        if (action === 'open' && this.selectedNodeId) this.showDetail(this.selectedNodeId);
        if (action === 'collapse' && this.selectedNodeId) this.toggleCollapse(this.selectedNodeId);
        if (action === 'connections' && this.selectedNodeId) this.highlightConnections(this.selectedNodeId);
      });
    });

    // Search bar toggle
    const searchBar = document.getElementById('search-bar')!;
    const searchInput = document.getElementById('search-input') as HTMLInputElement;

    document.getElementById('btn-search')?.addEventListener('click', () => {
      searchBar.classList.toggle('show');
      if (searchBar.classList.contains('show')) {
        searchInput.focus();
      } else {
        this.clearSearch();
      }
    });

    document.getElementById('search-close')?.addEventListener('click', () => {
      searchBar.classList.remove('show');
      this.clearSearch();
    });

    // Ctrl+F
    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.key === 'f') {
        e.preventDefault();
        searchBar.classList.add('show');
        searchInput.focus();
      }
      if (e.key === 'Escape' && searchBar.classList.contains('show')) {
        searchBar.classList.remove('show');
        this.clearSearch();
      }
    });

    // Search input
    searchInput?.addEventListener('input', () => {
      this.searchQuery = searchInput.value;
      this.applySearchFilter();
    });

    // Filter buttons
    document.querySelectorAll('.filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.activeFilter = (btn as HTMLElement).dataset.filter || 'all';
        this.applySearchFilter();
      });
    });

    // Bottom panel toggle — toggles terminal input row
    const toggleBtn = document.getElementById('btn-toggle-bottom')!;
    const termInputRow = document.getElementById('terminal-input-row')!;
    toggleBtn.addEventListener('click', () => {
      const hidden = termInputRow.style.display === 'none';
      termInputRow.style.display = hidden ? '' : 'none';
      toggleBtn.textContent = hidden ? '▾' : '▴';
    });

    // Clear terminal
    document.getElementById('btn-clear-terminal')?.addEventListener('click', () => {
      const termOut = document.getElementById('terminal-output')!;
      termOut.innerHTML = '';
      this.termInputBuf = '';
      this.termEnsureCursor();
    });

    // Terminal input box
    const termInput = document.getElementById('terminal-input') as HTMLInputElement;
    const sendTermCmd = () => {
      const cmd = termInput.value.trim();
      if (!cmd) return;
      termInput.value = '';
      this.termExec(cmd);
    };
    termInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        sendTermCmd();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (this.cmdHistory.length > 0 && this.cmdHistoryIdx > 0) {
          this.cmdHistoryIdx--;
          termInput.value = this.cmdHistory[this.cmdHistoryIdx];
        }
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (this.cmdHistoryIdx < this.cmdHistory.length - 1) {
          this.cmdHistoryIdx++;
          termInput.value = this.cmdHistory[this.cmdHistoryIdx];
        } else {
          this.cmdHistoryIdx = this.cmdHistory.length;
          termInput.value = '';
        }
      }
    });
    document.getElementById('btn-terminal-send')?.addEventListener('click', sendTermCmd);

    // Register shell data listener IMMEDIATELY so AI tool output always shows in terminal
    window.xpro.onShellData((data: string) => {
      this.termAppend(data);
    });
    window.xpro.onShellExit((code: number | null) => {
      this.termAppend(`\n[Shell exited with code ${code}]\n`);
      this.shellStarted = false;
      if (this.liveServerUrl) this.closeLivePreview();
    });

    // Toolbar Preview button (always visible when live server is active)
    document.getElementById('btn-preview')?.addEventListener('click', () => {
      if (this.liveServerUrl) this.showLivePreview(this.liveServerUrl);
    });

    // Live preview banner buttons
    document.getElementById('live-preview-open')?.addEventListener('click', () => {
      if (this.liveServerUrl) this.showLivePreview(this.liveServerUrl);
    });
    document.getElementById('live-preview-close')?.addEventListener('click', () => {
      this.closeLivePreview();
    });
    document.getElementById('live-preview-refresh')?.addEventListener('click', () => {
      const frame = document.getElementById('preview-frame') as HTMLIFrameElement;
      if (this.liveServerUrl) frame.src = this.liveServerUrl;
    });

    // URL bar navigation
    const urlInput = document.getElementById('url-input') as HTMLInputElement;
    urlInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        let val = urlInput.value.trim();
        if (val && !val.startsWith('http')) val = 'http://' + val;
        if (val) this.navigateLivePreview(val);
      }
    });
    document.getElementById('url-back')?.addEventListener('click', () => {
      if (this.liveHistoryIdx > 0) {
        this.liveHistoryIdx--;
        this.navigateLivePreview(this.liveHistory[this.liveHistoryIdx], false);
      }
    });
    document.getElementById('url-forward')?.addEventListener('click', () => {
      if (this.liveHistoryIdx < this.liveHistory.length - 1) {
        this.liveHistoryIdx++;
        this.navigateLivePreview(this.liveHistory[this.liveHistoryIdx], false);
      }
    });
    document.getElementById('url-refresh')?.addEventListener('click', () => {
      const frame = document.getElementById('preview-frame') as HTMLIFrameElement;
      if (frame) frame.src = frame.src;
    });

    // Inline terminal input (type directly in terminal-output)
    const termOut = document.getElementById('terminal-output')!;
    termOut.addEventListener('click', () => termOut.focus());
    termOut.addEventListener('keydown', (e) => {
      // Ignore modifier-only or ctrl/alt combos (except Ctrl+C)
      if (e.key === 'Shift' || e.key === 'Alt' || e.key === 'Meta') return;

      if (e.ctrlKey && e.key === 'c') {
        // Ctrl+C: send interrupt
        e.preventDefault();
        this.termInputBuf = '';
        this.termUpdateCursor();
        window.xpro.shellWrite('\x03');
        return;
      }
      if (e.ctrlKey || e.altKey || e.metaKey) return;

      e.preventDefault();

      if (e.key === 'Enter') {
        const cmd = this.termInputBuf;
        this.termInputBuf = '';
        this.termRemoveCursor();
        this.termExec(cmd);
      } else if (e.key === 'Backspace') {
        if (this.termInputBuf.length > 0) {
          this.termInputBuf = this.termInputBuf.slice(0, -1);
          this.termUpdateCursor();
        }
      } else if (e.key === 'ArrowUp') {
        if (this.cmdHistory.length > 0 && this.cmdHistoryIdx > 0) {
          this.cmdHistoryIdx--;
          this.termInputBuf = this.cmdHistory[this.cmdHistoryIdx];
          this.termUpdateCursor();
        }
      } else if (e.key === 'ArrowDown') {
        if (this.cmdHistoryIdx < this.cmdHistory.length - 1) {
          this.cmdHistoryIdx++;
          this.termInputBuf = this.cmdHistory[this.cmdHistoryIdx];
        } else {
          this.cmdHistoryIdx = this.cmdHistory.length;
          this.termInputBuf = '';
        }
        this.termUpdateCursor();
      } else if (e.key.length === 1) {
        // Printable character
        this.termInputBuf += e.key;
        this.termUpdateCursor();
      }
    });

    // Resize bottom container — requires long-press (300ms hold) to activate
    const bottomContainer = document.getElementById('bottom-container')!;
    const bpHeader = document.getElementById('bottom-panel-header')!;
    let resizing = false;
    let resizeStartY = 0;
    let resizeStartH = 0;
    let resizePressTimer: ReturnType<typeof setTimeout> | null = null;

    bpHeader.addEventListener('mousedown', (e) => {
      if ((e.target as HTMLElement).closest('button')) return;
      if (e.button !== 0) return;
      const capturedY = e.clientY;
      resizePressTimer = setTimeout(() => {
        resizing = true;
        resizeStartY = capturedY;
        resizeStartH = bottomContainer.offsetHeight;
        document.body.style.cursor = 'row-resize';
        bpHeader.style.background = 'rgba(88,166,255,0.08)';
      }, 300);
    });

    document.addEventListener('mousemove', (e) => {
      if (!resizing) return;
      const delta = resizeStartY - e.clientY;
      const newH = Math.max(60, Math.min(window.innerHeight * 0.7, resizeStartH + delta));
      bottomContainer.style.height = `${newH}px`;
    });

    document.addEventListener('mouseup', () => {
      if (resizePressTimer) { clearTimeout(resizePressTimer); resizePressTimer = null; }
      if (resizing) {
        resizing = false;
        document.body.style.cursor = '';
        bpHeader.style.background = '';
      }
    });

    // ========== AI Panel toggle — toggles AI input row ==========
    const aiToggleBtn = document.getElementById('btn-toggle-ai')!;
    const aiInputRow = document.getElementById('ai-input-row')!;
    aiToggleBtn.addEventListener('click', () => {
      const hidden = aiInputRow.style.display === 'none';
      aiInputRow.style.display = hidden ? '' : 'none';
      aiToggleBtn.textContent = hidden ? '▾' : '▴';
    });

    document.getElementById('btn-clear-ai')?.addEventListener('click', () => {
      this.aiMessages = [];
      AiService.clearMessages();
      document.getElementById('ai-messages')!.innerHTML = '';
    });

    // ── AI Mode Toggle (Agent / Ask) ──
    const modeBtn = document.getElementById('btn-ai-mode')!;
    modeBtn.classList.add('mode-agent');
    modeBtn.addEventListener('click', () => {
      const newMode = AiService.toggleMode();
      modeBtn.textContent = newMode === 'agent' ? '⚡ Agent' : '💬 Ask';
      modeBtn.classList.toggle('mode-agent', newMode === 'agent');
      modeBtn.classList.toggle('mode-ask', newMode === 'ask');
      this.aiAddSystem(newMode === 'agent'
        ? (this.lang === 'zh' ? '已切换到 Agent 模式 — 可读写文件、执行命令' : 'Switched to Agent mode — can read/write files, run commands')
        : (this.lang === 'zh' ? '已切换到 Ask 模式 — 只读分析，不修改文件' : 'Switched to Ask mode — read-only analysis, no file modifications'));
    });

    // ── Restart ──
    document.getElementById('btn-restart')?.addEventListener('click', () => {
      (window as any).xpro.restart();
    });

    // ── Checkpoint → Memory indicator ──
    CheckpointService.subscribe(() => {
      this.updateMemoryIndicator();
    });

    // ── Approval Bar ──
    document.getElementById('btn-approve-all')?.addEventListener('click', async () => {
      const count = await ApprovalService.approveAll();
      this.aiAddSystem(this.lang === 'zh' ? `已接受 ${count} 个变更` : `Accepted ${count} changes`);
    });
    document.getElementById('btn-reject-all')?.addEventListener('click', () => {
      ApprovalService.rejectAll();
      this.aiAddSystem(this.lang === 'zh' ? '已拒绝所有变更' : 'Rejected all changes');
    });
    document.getElementById('btn-show-diffs')?.addEventListener('click', () => {
      this.showDiffModal();
    });
    document.getElementById('btn-close-diff')?.addEventListener('click', () => {
      document.getElementById('diff-modal')!.classList.add('hidden');
    });
    ApprovalService.subscribe(() => {
      this.updateApprovalBar();
    });

    // ── Lint Service ──
    LintService.subscribe((results) => {
      this.updateLintBar(results);
    });

    // Memory panel button
    document.getElementById('btn-memory')?.addEventListener('click', () => {
      this.showMemoryPanel();
    });

    // AI header also resizes the container (long-press 300ms)
    const aiHeader = document.getElementById('ai-panel-header')!;
    aiHeader.addEventListener('mousedown', (e) => {
      if ((e.target as HTMLElement).closest('button, select, input')) return;
      if (e.button !== 0) return;
      const capturedY = e.clientY;
      resizePressTimer = setTimeout(() => {
        resizing = true;
        resizeStartY = capturedY;
        resizeStartH = bottomContainer.offsetHeight;
        document.body.style.cursor = 'row-resize';
        aiHeader.style.background = 'rgba(88,166,255,0.08)';
      }, 300);
    });

    // AI settings modal (single URL + Key, follows current provider)
    const modal = document.getElementById('ai-settings-modal')!;
    const apiKeyInput = document.getElementById('api-key') as HTMLInputElement;
    const apiBaseInput = document.getElementById('api-base') as HTMLInputElement;
    const settingsTitle = document.getElementById('ai-settings-title')!;

    const thinkingChk = document.getElementById('chk-thinking') as HTMLInputElement;
    const profileNameInput = document.getElementById('profile-name') as HTMLInputElement;
    const profileList = document.getElementById('profile-list')!;

    const renderProfiles = () => {
      profileList.innerHTML = '';
      if (this.apiProfiles.length === 0) {
        profileList.innerHTML = `<div style="color:#666;font-size:11px;padding:6px;text-align:center;">${this.t('noProfiles')}</div>`;
        return;
      }
      for (const p of this.apiProfiles) {
        const row = document.createElement('div');
        const isActive = this.activeProfile === p.name;
        row.style.cssText = `display:flex;align-items:center;justify-content:space-between;padding:5px 8px;border-radius:5px;margin-bottom:3px;cursor:pointer;font-size:11px;border:1px solid ${isActive ? 'rgba(96,165,250,0.4)' : 'rgba(255,255,255,0.06)'};background:${isActive ? 'rgba(96,165,250,0.1)' : 'rgba(255,255,255,0.02)'};`;
        const left = document.createElement('div');
        left.style.cssText = 'display:flex;flex-direction:column;gap:1px;flex:1;';
        const nameEl = document.createElement('span');
        nameEl.style.cssText = `font-weight:600;color:${isActive ? '#60a5fa' : '#ccc'};`;
        nameEl.textContent = p.name;
        const infoEl = document.createElement('span');
        infoEl.style.cssText = 'color:#666;font-size:10px;';
        infoEl.textContent = `${p.model} · ${p.baseUrl.replace(/https?:\/\//, '').slice(0, 30)}`;
        left.appendChild(nameEl);
        left.appendChild(infoEl);
        row.appendChild(left);

        const btnGroup = document.createElement('div');
        btnGroup.style.cssText = 'display:flex;gap:4px;';
        const useBtn = document.createElement('button');
        useBtn.textContent = isActive ? '✓' : this.t('use');
        useBtn.style.cssText = `font-size:10px;padding:2px 8px;border-radius:4px;cursor:pointer;border:1px solid ${isActive ? 'rgba(34,197,94,0.3)' : 'rgba(96,165,250,0.3)'};background:${isActive ? 'rgba(34,197,94,0.1)' : 'rgba(96,165,250,0.1)'};color:${isActive ? '#4ade80' : '#60a5fa'};`;
        useBtn.onclick = (e) => {
          e.stopPropagation();
          this.applyProfile(p);
          profileNameInput.value = p.name;
          apiBaseInput.value = p.baseUrl;
          apiKeyInput.value = p.apiKey;
          (document.getElementById('ai-provider') as HTMLSelectElement).value = p.provider || 'openai';
          renderProfiles();
        };
        const delBtn = document.createElement('button');
        delBtn.textContent = '✕';
        delBtn.style.cssText = 'font-size:10px;padding:2px 6px;border-radius:4px;cursor:pointer;border:1px solid rgba(239,68,68,0.2);background:rgba(239,68,68,0.1);color:#f87171;';
        delBtn.onclick = (e) => {
          e.stopPropagation();
          this.apiProfiles = this.apiProfiles.filter(x => x.name !== p.name);
          if (this.activeProfile === p.name) this.activeProfile = '';
          this.saveAiConfig();
          renderProfiles();
        };
        btnGroup.appendChild(useBtn);
        btnGroup.appendChild(delBtn);
        row.appendChild(btnGroup);
        profileList.appendChild(row);
      }
    };

    document.getElementById('btn-ai-settings')?.addEventListener('click', () => {
      const provider = (document.getElementById('ai-provider') as HTMLSelectElement).value;
      const isAnt = provider === 'anthropic';
      apiBaseInput.value = isAnt ? this.aiConfig.anthropicBase : this.aiConfig.openaiBase;
      apiBaseInput.placeholder = isAnt ? 'https://api.anthropic.com' : 'https://api.openai.com/v1';
      apiKeyInput.value = isAnt ? this.aiConfig.anthropicKey : this.aiConfig.openaiKey;
      apiKeyInput.placeholder = isAnt ? 'sk-ant-...' : 'sk-...';
      profileNameInput.value = this.activeProfile;
      thinkingChk.checked = this.aiConfig.thinking;
      renderProfiles();
      modal.classList.remove('hidden');
    });
    document.getElementById('btn-close-ai-settings')?.addEventListener('click', () => {
      modal.classList.add('hidden');
    });
    // Save Profile button
    document.getElementById('btn-save-profile')?.addEventListener('click', () => {
      const name = profileNameInput.value.trim();
      if (!name) { profileNameInput.focus(); return; }
      const provider = (document.getElementById('ai-provider') as HTMLSelectElement).value;
      const profile = {
        name,
        baseUrl: apiBaseInput.value.trim(),
        apiKey: apiKeyInput.value.trim(),
        model: (document.getElementById('ai-model') as HTMLInputElement).value.trim(),
        provider,
      };
      const idx = this.apiProfiles.findIndex(p => p.name === name);
      if (idx >= 0) { this.apiProfiles[idx] = profile; } else { this.apiProfiles.push(profile); }
      this.applyProfile(profile);
      this.saveAiConfig();
      renderProfiles();
      this.aiAddSystem(`Profile "${name}" saved.`);
    });
    // Apply button (use current fields without saving profile)
    document.getElementById('btn-save-ai-settings')?.addEventListener('click', () => {
      const provider = (document.getElementById('ai-provider') as HTMLSelectElement).value;
      const key = apiKeyInput.value.trim();
      const base = apiBaseInput.value.trim();
      if (provider === 'anthropic') {
        this.aiConfig.anthropicKey = key;
        this.aiConfig.anthropicBase = base || 'https://api.anthropic.com';
      } else {
        this.aiConfig.openaiKey = key;
        this.aiConfig.openaiBase = base || 'https://api.openai.com/v1';
      }
      this.aiConfig.thinking = thinkingChk.checked;
      modal.classList.add('hidden');
      this.saveAiConfig();
      this.aiAddSystem(`Settings applied. Thinking: ${this.aiConfig.thinking ? 'ON' : 'OFF'}`);
    });

    // AI send / stop
    const aiInput = document.getElementById('ai-input') as HTMLTextAreaElement;
    const sendBtn = document.getElementById('btn-ai-send') as HTMLButtonElement;
    const SEND_SVG = '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M1 1.5l14 6.5-14 6.5V9l8-1-8-1V1.5z"/></svg>';
    const STOP_SVG = '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><rect x="3" y="3" width="10" height="10" rx="2"/></svg>';

    const sendAi = () => {
      if (this.aiRunning) {
        // Stop
        window.xpro.aiAbort();
        return;
      }
      const text = aiInput.value.trim();
      if (!text) return;
      aiInput.value = '';
      aiInput.style.height = 'auto';
      this.aiSend(text);
    };
    sendBtn?.addEventListener('click', sendAi);
    aiInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendAi();
      }
    });
    // Auto-resize textarea
    aiInput?.addEventListener('input', () => {
      aiInput.style.height = 'auto';
      aiInput.style.height = Math.min(aiInput.scrollHeight, 120) + 'px';
    });

    // Drag-and-drop files into AI input
    const aiPanelBody = document.getElementById('ai-panel-body')!;
    const dropTargets = [aiInput, aiPanelBody];
    for (const el of dropTargets) {
      if (!el) continue;
      el.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (e instanceof DragEvent && e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
        aiInput.classList.add('drag-over');
      });
      el.addEventListener('dragleave', (e) => {
        e.preventDefault();
        aiInput.classList.remove('drag-over');
      });
      el.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        aiInput.classList.remove('drag-over');
        if (!(e instanceof DragEvent) || !e.dataTransfer) return;

        const paths: string[] = [];

        // OS file drops
        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
          for (let i = 0; i < e.dataTransfer.files.length; i++) {
            const f = e.dataTransfer.files[i] as any;
            if (f.path) paths.push(f.path);
          }
        }

        // Internal text/plain drops (canvas node paths)
        if (paths.length === 0) {
          const text = e.dataTransfer.getData('text/plain');
          if (text && (text.includes('/') || text.includes('\\'))) {
            paths.push(...text.split('\n').map(s => s.trim()).filter(Boolean));
          }
        }

        if (paths.length > 0) {
          const cur = aiInput.value;
          const insert = paths.join('\n');
          const sep = cur && !cur.endsWith('\n') && !cur.endsWith(' ') ? ' ' : '';
          aiInput.value = cur + sep + insert;
          aiInput.style.height = 'auto';
          aiInput.style.height = Math.min(aiInput.scrollHeight, 120) + 'px';
          aiInput.focus();
        }
      });
    }

    // Register AI tool event listener once
    window.xpro.onAiToolEvent((rid: string, evt: any) => {
      if (this.aiEventHandler) this.aiEventHandler(rid, evt);
    });

    // Register AI file change listener (checkpoint + approval + lint)
    (window as any).xpro.onAiFileChanged((data: { toolName: string; filePath: string; oldContent: string; newContent: string }) => {
      const fileName = data.filePath.split(/[\\/]/).pop() || data.filePath;
      console.log(`[ai:fileChanged] ${data.toolName} → ${fileName}`);

      // 1. Create checkpoint with temporary label, then async LLM summary
      const cp = CheckpointService.createCheckpoint(
        `${data.toolName}: ${fileName}`,
        [{ path: data.filePath, content: data.oldContent, newContent: data.newContent, timestamp: Date.now() }]
      );
      this.updateMemoryIndicator();

      // Async: get LLM summary title for this change
      const provider = (document.getElementById('ai-provider') as HTMLSelectElement)?.value || 'openai';
      const model = (document.getElementById('ai-model') as HTMLInputElement)?.value || 'gpt-4o';
      const isAnt = provider === 'anthropic';
      const config = {
        model,
        provider,
        apiKey: isAnt ? this.aiConfig.anthropicKey : this.aiConfig.openaiKey,
        baseUrl: isAnt ? this.aiConfig.anthropicBase : this.aiConfig.openaiBase,
      };
      if (config.apiKey) {
        (window as any).xpro.memorySummarizeChange(config, data.filePath, data.oldContent, data.newContent)
          .then((res: any) => {
            if (res.ok && res.summary) {
              CheckpointService.updateLabel(cp.id, res.summary);
            }
          })
          .catch(() => {});

        // Auto-categorize: debounce 3s after last change
        if (this.autoCatTimer) clearTimeout(this.autoCatTimer);
        this.autoCatTimer = window.setTimeout(() => {
          this.autoCategorize(config);
        }, 3000);
      }

      // 2. Add to approval queue (if approval is enabled)
      if (ApprovalService.isEnabled()) {
        ApprovalService.addChange({
          path: data.filePath,
          oldContent: data.oldContent,
          newContent: data.newContent,
          toolName: data.toolName,
          description: `${data.toolName}: ${fileName}`,
        });
      }

      // 3. Trigger lint check
      LintService.lintFile(data.filePath);

      // 4. Refresh open file if it matches
      if (this.editingPath === data.filePath) {
        this.refreshOpenFile();
      }
    });

    // Load saved AI config
    this.loadAiConfig();

    // Set lint project root when folder is opened
    LintService.setProjectRoot(this.rootFolder);

    // Language toggle
    document.getElementById('btn-lang')?.addEventListener('click', () => {
      this.lang = this.lang === 'en' ? 'zh' : 'en';
      this.applyLang();
    });
  }

  private t(key: string): string {
    return WorkflowCanvas.i18n[this.lang]?.[key] || key;
  }

  private applyLang() {
    const t = this.t.bind(this);
    const s = (id: string, text: string) => { const el = document.getElementById(id); if (el) el.textContent = text; };
    const q = (sel: string, text: string) => { const el = document.querySelector(sel); if (el) el.textContent = text; };
    const ph = (id: string, val: string) => { const el = document.getElementById(id) as HTMLInputElement | null; if (el) el.placeholder = val; };

    s('btn-lang', this.lang === 'en' ? 'EN / 中' : '中 / EN');

    // Toolbar
    q('#btn-open-folder span', t('openFolder'));
    q('#btn-open-files span', t('openFiles'));
    q('#btn-auto-layout span', t('autoLayout'));
    q('#btn-fit-view span', t('fitView'));

    // Folder path
    if (!this.rootFolder) s('folder-path', t('noFolder'));

    // Node count
    const count = this.nodes.size;
    s('node-count', this.lang === 'zh' ? `${count} ${t('nodes')}` : `${count} nodes`);

    // Search
    ph('search-input', t('search'));
    q('.filter-btn[data-filter="all"]', t('all'));
    q('.filter-btn[data-filter="dir"]', t('folders'));

    // Terminal
    s('bottom-panel-title', t('terminal'));
    s('btn-clear-terminal', t('clear'));

    // AI panel
    s('ai-panel-title', t('aiTitle'));
    s('btn-ai-settings', t('settings'));
    s('btn-clear-ai', t('clear'));
    ph('ai-input', t('aiPlaceholder'));

    // Detail panel
    s('detail-save', t('save'));

    // Restart button
    s('btn-restart', t('restart'));

    // Settings modal
    s('ai-settings-title', t('apiSettings'));
    s('lbl-saved-profiles', t('savedProfiles'));
    s('lbl-profile-name', t('profileName'));
    s('lbl-base-url', t('baseUrl'));
    s('lbl-api-key', t('apiKey'));
    s('lbl-thinking', t('thinkingMode'));
    s('btn-save-profile', t('saveProfile'));
    s('btn-save-ai-settings', t('savBtn'));
    s('btn-close-ai-settings', t('cancel'));
    ph('profile-name', t('profileNamePh'));

    // Context menu
    const ctxItems = document.querySelectorAll('.ctx-item');
    if (ctxItems[0]) ctxItems[0].textContent = t('ctxOpen');
    if (ctxItems[1]) ctxItems[1].textContent = t('ctxConn');
    if (ctxItems[2]) ctxItems[2].textContent = t('ctxCollapse');
  }

  private applyTransform() {
    this.canvas.style.transform = `translate(${this.panX}px, ${this.panY}px) scale(${this.scale})`;
  }

  /* ========== 文件系统监听 ========== */
  private watchActive = false;

  private async startWatching() {
    if (!this.rootFolder) return;
    await window.xpro.watchFolder(this.rootFolder);
    if (!this.watchActive) {
      this.watchActive = true;
      window.xpro.onFsChange((changedDir: string) => {
        this.handleFsChange(changedDir);
      });
    }
  }

  private fsChangeTimer: ReturnType<typeof setTimeout> | null = null;

  private handleFsChange(changedDir: string) {
    // Debounce multiple rapid changes
    if (this.fsChangeTimer) clearTimeout(this.fsChangeTimer);
    this.fsChangeTimer = setTimeout(() => {
      this.refreshDir(changedDir);
    }, 500);
  }

  private async refreshDir(dirPath: string) {
    const node = this.nodes.get(dirPath);
    if (!node || !node.isDir || node.collapsed) return;

    // Re-read directory contents
    const newEntries = await this.readOneLevel(dirPath);
    const newPaths = new Set(newEntries.map(e => e.path));
    const oldChildIds = [...node.childIds];

    // Remove deleted children
    for (const cid of oldChildIds) {
      if (!newPaths.has(cid)) {
        this.removeNodeTree(cid);
      }
    }

    // Add new children
    for (const entry of newEntries) {
      if (!this.nodes.has(entry.path)) {
        this.addNode(entry, dirPath);
      }
    }

    // Re-layout and render
    this.autoLayout();
    this.renderAll();
  }

  private removeNodeTree(id: string) {
    const node = this.nodes.get(id);
    if (!node) return;
    // Remove children recursively
    for (const cid of [...node.childIds]) {
      this.removeNodeTree(cid);
    }
    // Remove from parent's childIds
    if (node.parentId) {
      const parent = this.nodes.get(node.parentId);
      if (parent) {
        parent.childIds = parent.childIds.filter(c => c !== id);
      }
    }
    // Remove edges
    this.edges = this.edges.filter(e => e.from !== id && e.to !== id);
    // Remove node
    this.nodes.delete(id);
  }

  /* ========== 加载文件夹 ========== */
  async loadFolder(folderPath: string) {
    this.nodes.clear();
    this.edges = [];
    this.nodesLayer.innerHTML = '';
    this.svgLayer.innerHTML = '';

    const norm = (p: string) => p.replace(/\\/g, '/');
    const basename = (p: string) => norm(p).split('/').pop() || p;

    this.rootFolder = folderPath;
    document.getElementById('folder-path')!.textContent = folderPath;
    window.xpro.aiSetProjectRoot(folderPath);
    LintService.setProjectRoot(folderPath);
    await CheckpointService.setProjectRoot(folderPath);

    // Add root node
    this.addNode({ name: basename(folderPath), path: folderPath, isDir: true }, null);
    const rootNode = this.nodes.get(folderPath);
    if (rootNode) {
      rootNode.collapsed = false;
      rootNode.loaded = true;
    }

    // Load first level
    const entries = await this.readOneLevel(folderPath);
    for (const entry of entries) {
      this.addNode(entry, folderPath);
    }

    this.autoLayout();
    this.renderAll();
    this.fitView();
    this.startWatching();
    this.updateMemoryIndicator();
  }

  /* ========== 加载选中文件（展开完整路径树） ========== */
  async loadFiles(filePaths: string[]) {
    this.nodes.clear();
    this.edges = [];
    this.nodesLayer.innerHTML = '';
    this.svgLayer.innerHTML = '';

    const norm = (p: string) => p.replace(/\\/g, '/');
    const basename = (p: string) => norm(p).split('/').pop() || p;
    const dirname = (p: string) => { const s = norm(p); return s.substring(0, s.lastIndexOf('/')); };
    const split = (p: string) => norm(p).split('/').filter(Boolean);

    // 找到所有选中文件的公共根目录
    const allParts = filePaths.map(fp => split(fp));
    let commonParts: string[] = [];
    if (allParts.length > 0) {
      commonParts = [...allParts[0]];
      for (let i = 1; i < allParts.length; i++) {
        let j = 0;
        while (j < commonParts.length && j < allParts[i].length && commonParts[j] === allParts[i][j]) j++;
        commonParts = commonParts.slice(0, j);
      }
    }
    // 去掉最后一段（如果公共前缀刚好到文件名层级，取其父目录）
    // 公共根 = 公共目录部分
    // 找到公共目录（排除文件本身的名字段）
    const fileDirParts = filePaths.map(fp => { const p = split(fp); return p.slice(0, p.length - 1); });
    let rootParts = [...fileDirParts[0]];
    for (let i = 1; i < fileDirParts.length; i++) {
      let j = 0;
      while (j < rootParts.length && j < fileDirParts[i].length && rootParts[j] === fileDirParts[i][j]) j++;
      rootParts = rootParts.slice(0, j);
    }

    // 在 Windows 上拼回路径（保留盘符格式 C:/）
    const rootPath = rootParts.join('/');
    // 原始格式（带反斜杠）
    const rootPathNative = rootPath.replace(/\//g, '\\');
    this.rootFolder = rootPathNative;
    document.getElementById('folder-path')!.textContent = rootPathNative;
    window.xpro.aiSetProjectRoot(rootPathNative);

    // 收集需要展开的所有目录路径（从根到每个文件的父目录）
    const dirsToLoad = new Set<string>();
    dirsToLoad.add(rootPath);
    for (const fp of filePaths) {
      const parts = split(fp);
      // 从 rootParts.length 开始，逐层往下加目录
      for (let i = rootParts.length + 1; i < parts.length; i++) {
        dirsToLoad.add(parts.slice(0, i).join('/'));
      }
    }

    // 选中文件的路径集合（标准化）
    const selectedSet = new Set(filePaths.map(fp => norm(fp)));

    // 从根目录开始，逐层加载需要展开的目录
    const sortedDirs = Array.from(dirsToLoad).sort((a, b) => a.length - b.length);

    for (const dirPath of sortedDirs) {
      const dirNative = dirPath.replace(/\//g, '\\');

      // 确保目录节点本身存在（根节点无 parent，其他挂到父目录）
      if (!this.nodes.has(dirNative)) {
        const dirName = basename(dirPath);
        const parentDirPath = dirname(dirPath);
        const parentNative = parentDirPath.replace(/\//g, '\\');
        const parentId = this.nodes.has(parentNative) ? parentNative : null;
        this.addNode({ name: dirName, path: dirNative, isDir: true }, parentId);
      }

      const dirNode = this.nodes.get(dirNative);
      if (dirNode) {
        dirNode.collapsed = false;
        dirNode.loaded = true;
      }

      // 加载该目录下的子文件/子目录
      const entries = await this.readOneLevel(dirNative);
      for (const entry of entries) {
        if (this.nodes.has(entry.path)) continue;
        this.addNode(entry, dirNative);
      }
    }

    this.autoLayout();
    this.renderAll();
    this.fitView();

    // 给选中的文件加亮边框
    for (const node of this.nodes.values()) {
      if (node.el && selectedSet.has(norm(node.path))) {
        node.el.classList.add('selected');
      }
    }

    this.startWatching();
  }

  private async readOneLevel(dirPath: string): Promise<FileEntry[]> {
    const result = await window.xpro.readDir(dirPath);
    if (!result.ok || !result.data) return [];

    const sorted = result.data.sort((a: any, b: any) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    const entries: FileEntry[] = [];
    for (const item of sorted) {
      if (item.name.startsWith('.') || item.name === 'node_modules' || item.name === 'dist' || item.name === '__pycache__') continue;
      entries.push({ name: item.name, path: item.path, isDir: item.isDir });
    }
    return entries;
  }

  private addNode(entry: FileEntry, parentId: string | null): WfNode {
    const id = entry.path;
    const node: WfNode = {
      id, name: entry.name, path: entry.path,
      isDir: entry.isDir,
      x: 0, y: 0,
      parentId,
      el: null,
      collapsed: true,
      loaded: !entry.isDir, // 文件不需要加载子项，目录未加载
      childIds: [],
    };
    this.nodes.set(id, node);

    if (parentId) {
      this.edges.push({ from: parentId, to: id, pathEl: null });
      const parent = this.nodes.get(parentId);
      if (parent) parent.childIds.push(id);
    }

    return node;
  }

  /* ========== 布局方向切换 ========== */
  setLayoutDir(dir: 'h' | 'v') {
    this.layoutDir = dir;
    this.autoLayout();
    this.renderAll();
    this.fitView();
  }

  /* ========== 树形布局 ========== */
  autoLayout() {
    const roots = Array.from(this.nodes.values()).filter(n => n.parentId === null);
    if (this.layoutDir === 'v') {
      let xOffset = 60;
      for (const root of roots) {
        xOffset = this.layoutSubtreeV(root, xOffset, 60);
        xOffset += H_GAP * 2;
      }
    } else {
      let yOffset = 60;
      for (const root of roots) {
        yOffset = this.layoutSubtreeH(root, 60, yOffset);
        yOffset += V_GAP * 2;
      }
    }
    document.getElementById('node-count')!.textContent = `${this.nodes.size} nodes`;
  }

  /* 从左到右 (horizontal) */
  private layoutSubtreeH(node: WfNode, x: number, y: number): number {
    const w = node.isDir ? DIR_NODE_W : NODE_W;
    node.x = x;
    node.y = y;

    if (node.collapsed || node.childIds.length === 0) {
      return y + NODE_H + V_GAP;
    }

    let childY = y;
    for (const cid of node.childIds) {
      const child = this.nodes.get(cid);
      if (child) {
        childY = this.layoutSubtreeH(child, x + w + H_GAP, childY);
      }
    }

    const firstChild = this.nodes.get(node.childIds[0]);
    const lastChild = this.nodes.get(node.childIds[node.childIds.length - 1]);
    if (firstChild && lastChild) {
      node.y = (firstChild.y + lastChild.y) / 2;
    }

    return Math.max(childY, node.y + NODE_H + V_GAP);
  }

  /* 从上到下 (vertical) */
  private layoutSubtreeV(node: WfNode, x: number, y: number): number {
    const w = node.isDir ? DIR_NODE_W : NODE_W;
    node.x = x;
    node.y = y;

    if (node.collapsed || node.childIds.length === 0) {
      return x + w + H_GAP;
    }

    let childX = x;
    for (const cid of node.childIds) {
      const child = this.nodes.get(cid);
      if (child) {
        childX = this.layoutSubtreeV(child, childX, y + NODE_H + V_GAP + 20);
      }
    }

    const firstChild = this.nodes.get(node.childIds[0]);
    const lastChild = this.nodes.get(node.childIds[node.childIds.length - 1]);
    if (firstChild && lastChild) {
      const fw = firstChild.isDir ? DIR_NODE_W : NODE_W;
      const lw = lastChild.isDir ? DIR_NODE_W : NODE_W;
      node.x = (firstChild.x + fw / 2 + lastChild.x + lw / 2) / 2 - w / 2;
    }

    return Math.max(childX, node.x + w + H_GAP);
  }

  /* ========== 渲染 ========== */
  private renderAll() {
    this.nodesLayer.innerHTML = '';
    // Clear SVG properly (innerHTML can break SVG in some engines)
    while (this.svgLayer.firstChild) this.svgLayer.removeChild(this.svgLayer.firstChild);
    this.nodeIndex = 0;

    for (const node of this.nodes.values()) {
      this.createNodeEl(node);
    }

    for (const edge of this.edges) {
      this.createEdgeEl(edge);
    }

    console.log(`[renderAll] nodes=${this.nodes.size}, edges=${this.edges.length}, svgChildren=${this.svgLayer.childNodes.length}`);
    this.updateMinimap();
  }

  private nodeIndex = 0;

  private createNodeEl(node: WfNode) {
    const el = document.createElement('div');
    el.className = `wf-node${node.isDir ? ' dir' : ''}`;
    el.dataset.nodeId = node.id;

    const icon = this.getIcon(node);
    const ext = node.isDir ? 'folder' : node.name.split('.').pop() || 'file';
    const color = this.getTypeColor(node.name, node.isDir);

    // Staggered entrance animation
    el.style.animationDelay = `${this.nodeIndex * 40}ms`;
    this.nodeIndex++;

    el.innerHTML = `
      <div class="node-accent" style="background:${color}"></div>
      <div class="node-header">
        <span class="node-icon">${icon}</span>
        <span class="node-name" title="${node.path}">${node.name}</span>
      </div>
      <div class="node-body">
        <span class="node-type" style="color:${color};border:1px solid ${color}33;background:${color}15">${ext}</span>
        ${node.isDir ? `<span style="opacity:0.5">▸ click to expand</span>` : ''}
      </div>
      <div class="node-port left" style="background:${color}"></div>
      <div class="node-port right" style="background:${color}"></div>
    `;

    // Drag + Click
    let startX = 0, startY = 0, didDrag = false;
    let allowHtmlDrag = false;

    el.setAttribute('draggable', 'true');
    el.addEventListener('dragstart', (e) => {
      if (!allowHtmlDrag) { e.preventDefault(); return; }
      if (e.dataTransfer) {
        e.dataTransfer.setData('text/plain', node.path);
        e.dataTransfer.effectAllowed = 'copy';
      }
    });

    el.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      startX = e.clientX;
      startY = e.clientY;
      didDrag = false;
      allowHtmlDrag = false;
      this.dragNodeId = node.id;
      const rect = el.getBoundingClientRect();
      this.dragOffsetX = e.clientX - rect.left;
      this.dragOffsetY = e.clientY - rect.top;
      this.selectNode(node.id);
    });

    el.addEventListener('mousemove', (e) => {
      if (this.dragNodeId === node.id && !didDrag) {
        if (Math.abs(e.clientX - startX) > 4 || Math.abs(e.clientY - startY) > 4) {
          didDrag = true;
          allowHtmlDrag = true;
        }
      }
    });

    el.addEventListener('mouseup', (e) => {
      if (this.dragNodeId === node.id && !didDrag) {
        // 单击（未拖拽）
        if (node.isDir) {
          this.toggleCollapse(node.id);
        } else {
          this.showDetail(node.id);
        }
      }
      this.dragNodeId = null;
    });

    // Right-click
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.selectedNodeId = node.id;
      this.selectNode(node.id);
      const menu = document.getElementById('context-menu')!;
      menu.style.left = `${e.clientX}px`;
      menu.style.top = `${e.clientY}px`;
      menu.classList.remove('hidden');
    });

    this.nodesLayer.appendChild(el);
    node.el = el;
    this.positionNode(node);
  }

  private positionNode(node: WfNode) {
    if (!node.el) return;
    node.el.style.left = `${node.x}px`;
    node.el.style.top = `${node.y}px`;
  }

  private createEdgeEl(edge: WfEdge) {
    const from = this.nodes.get(edge.from);
    const to = this.nodes.get(edge.to);
    if (!from || !to) return;

    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    const d = this.calcCurve(from, to);
    path.setAttribute('d', d);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', '#4a6a8a');
    path.setAttribute('stroke-width', '2');
    this.svgLayer.appendChild(path);
    edge.pathEl = path;
  }

  private calcCurve(from: WfNode, to: WfNode): string {
    if (this.layoutDir === 'v') {
      const fw = from.isDir ? DIR_NODE_W : NODE_W;
      const tw = to.isDir ? DIR_NODE_W : NODE_W;
      const x1 = from.x + fw / 2;
      const y1 = from.y + NODE_H;
      const x2 = to.x + tw / 2;
      const y2 = to.y;
      const cy = (y1 + y2) / 2;
      return `M ${x1} ${y1} C ${x1} ${cy}, ${x2} ${cy}, ${x2} ${y2}`;
    }
    const fw = from.isDir ? DIR_NODE_W : NODE_W;
    const x1 = from.x + fw;
    const y1 = from.y + NODE_H / 2;
    const x2 = to.x;
    const y2 = to.y + NODE_H / 2;
    const cx = (x1 + x2) / 2;
    return `M ${x1} ${y1} C ${cx} ${y1}, ${cx} ${y2}, ${x2} ${y2}`;
  }

  private updateEdges() {
    for (const edge of this.edges) {
      const from = this.nodes.get(edge.from);
      const to = this.nodes.get(edge.to);
      if (from && to && edge.pathEl) {
        edge.pathEl.setAttribute('d', this.calcCurve(from, to));
      }
    }
  }

  /* ========== 选择/高亮 ========== */
  private selectNode(id: string) {
    document.querySelectorAll('.wf-node.selected').forEach(el => el.classList.remove('selected'));
    this.edges.forEach(e => e.pathEl?.classList.remove('highlighted'));
    const node = this.nodes.get(id);
    if (node?.el) {
      node.el.classList.add('selected');
      this.selectedNodeId = id;
    }
  }

  private highlightConnections(id: string) {
    this.edges.forEach(e => e.pathEl?.classList.remove('highlighted'));
    for (const edge of this.edges) {
      if (edge.from === id || edge.to === id) {
        edge.pathEl?.classList.add('highlighted');
      }
    }
  }

  /* ========== 搜索/过滤 ========== */
  private applySearchFilter() {
    const query = this.searchQuery.toLowerCase().trim();
    const filter = this.activeFilter;
    let hitCount = 0;

    for (const node of this.nodes.values()) {
      if (!node.el) continue;
      if (node.el.style.display === 'none' && node.parentId) continue; // collapsed child

      const nameMatch = !query || node.name.toLowerCase().includes(query);
      const catMatch = filter === 'all' || this.getTypeCategory(node.name, node.isDir) === filter;
      const isHit = nameMatch && catMatch;

      if (query || filter !== 'all') {
        node.el.classList.toggle('dimmed', !isHit);
        node.el.classList.toggle('search-hit', isHit && !!query);
      } else {
        node.el.classList.remove('dimmed', 'search-hit');
      }

      if (isHit) hitCount++;
    }

    // Dim/undim edges
    for (const edge of this.edges) {
      if (!edge.pathEl) continue;
      const from = this.nodes.get(edge.from);
      const to = this.nodes.get(edge.to);
      const bothHit = from?.el && to?.el && !from.el.classList.contains('dimmed') && !to.el.classList.contains('dimmed');
      edge.pathEl.style.opacity = (query || filter !== 'all') ? (bothHit ? '1' : '0.1') : '1';
    }

    const resultsEl = document.getElementById('search-results')!;
    if (query || filter !== 'all') {
      resultsEl.textContent = `${hitCount} match${hitCount !== 1 ? 'es' : ''}`;
    } else {
      resultsEl.textContent = '';
    }
  }

  private clearSearch() {
    this.searchQuery = '';
    this.activeFilter = 'all';
    (document.getElementById('search-input') as HTMLInputElement).value = '';
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    for (const node of this.nodes.values()) {
      node.el?.classList.remove('dimmed', 'search-hit');
    }
    for (const edge of this.edges) {
      if (edge.pathEl) edge.pathEl.style.opacity = '1';
    }
    document.getElementById('search-results')!.textContent = '';
  }

  /* ========== AI Chat ========== */
  private async loadAiConfig() {
    try {
      const cfg = await window.xpro.loadConfig();
      if (cfg?.ai) {
        this.aiConfig = { ...this.aiConfig, ...cfg.ai };
      }
      if (cfg?.apiProfiles) {
        this.apiProfiles = cfg.apiProfiles;
      }
      if (cfg?.activeProfile) {
        this.activeProfile = cfg.activeProfile;
        const p = this.apiProfiles.find(x => x.name === this.activeProfile);
        if (p) this.applyProfile(p, true);
      }
    } catch {}
  }

  private async saveAiConfig() {
    try {
      const cfg = await window.xpro.loadConfig() || {};
      cfg.ai = this.aiConfig;
      cfg.apiProfiles = this.apiProfiles;
      cfg.activeProfile = this.activeProfile;
      await window.xpro.saveConfig(cfg);
    } catch {}
  }

  private applyProfile(p: { name: string; baseUrl: string; apiKey: string; model: string; provider: string }, silent?: boolean) {
    this.activeProfile = p.name;
    const isAnt = p.provider === 'anthropic';
    if (isAnt) {
      this.aiConfig.anthropicKey = p.apiKey;
      this.aiConfig.anthropicBase = p.baseUrl || 'https://api.anthropic.com';
    } else {
      this.aiConfig.openaiKey = p.apiKey;
      this.aiConfig.openaiBase = p.baseUrl || 'https://api.openai.com/v1';
    }
    // Update toolbar selectors
    const providerSel = document.getElementById('ai-provider') as HTMLSelectElement;
    const modelInput = document.getElementById('ai-model') as HTMLInputElement;
    if (providerSel) providerSel.value = p.provider || 'openai';
    if (modelInput && p.model) modelInput.value = p.model;
    if (!silent) this.aiAddSystem(`Switched to "${p.name}" (${p.model})`);
  }

  private aiAddMsg(role: string, content: string) {
    const container = document.getElementById('ai-messages')!;
    const div = document.createElement('div');
    div.className = `ai-msg ${role}`;

    const roleLabel = document.createElement('div');
    roleLabel.className = 'msg-role';
    roleLabel.textContent = role === 'user' ? 'You' : role === 'assistant' ? 'AI' : 'System';
    div.appendChild(roleLabel);

    const body = document.createElement('div');
    body.textContent = content;
    div.appendChild(body);

    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
  }

  private aiAddSystem(text: string) {
    const container = document.getElementById('ai-messages')!;
    const div = document.createElement('div');
    div.className = 'ai-msg system';
    div.textContent = text;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
  }

  private aiUpdateLast(content: string) {
    const container = document.getElementById('ai-messages')!;
    const last = container.querySelector('.ai-msg.assistant:last-child .ai-body');
    if (last) last.textContent = content;
  }

  private aiRequestId = 0;
  private aiEventHandler: ((rid: string, evt: any) => void) | null = null;
  private aiRunning = false;
  private aiSessionId = `session_${Date.now()}`;

  private setAiRunning(running: boolean) {
    this.aiRunning = running;
    const btn = document.getElementById('btn-ai-send') as HTMLButtonElement;
    if (!btn) return;
    const SEND_SVG = '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M1 1.5l14 6.5-14 6.5V9l8-1-8-1V1.5z"/></svg>';
    const STOP_SVG = '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><rect x="3" y="3" width="10" height="10" rx="2"/></svg>';
    btn.innerHTML = running ? STOP_SVG : SEND_SVG;
    btn.title = running ? 'Stop' : 'Send';
    btn.classList.toggle('ai-stop', running);
  }

  private async aiSend(userText: string) {
    const provider = (document.getElementById('ai-provider') as HTMLSelectElement).value;
    const model = (document.getElementById('ai-model') as HTMLInputElement).value.trim();

    // Check API key
    if (provider === 'openai' && !this.aiConfig.openaiKey) {
      this.aiAddSystem('Please set your OpenAI API Key first (click Settings)');
      return;
    }
    if (provider === 'anthropic' && !this.aiConfig.anthropicKey) {
      this.aiAddSystem('Please set your Anthropic API Key first (click Settings)');
      return;
    }

    // Check for annotation attachment
    const aiPanel = document.getElementById('ai-panel')!;
    const annotationImage = aiPanel.dataset.annotationImage;
    const annotationCode = aiPanel.dataset.annotationCode;
    const annotationFile = aiPanel.dataset.annotationFile;

    let userContent: any = userText;
    let displayText = userText;

    if (annotationImage) {
      console.log('[AI] Annotation detected: imageLen=', annotationImage.length, 'code=', (annotationCode || '').length, 'file=', annotationFile);
      const fileName = annotationFile?.split(/[\\/]/).pop() || 'unknown';
      const userRequest = userText.replace(/^\[.*?\]\n.*?\n\n/, '').trim();
      const isLive = annotationFile?.startsWith('http');
      const contextLines = [
        `[The user circled/highlighted parts of the preview page with red pen in the attached screenshot]`,
        ``,
      ];
      if (isLive) {
        contextLines.push(`Live preview URL: ${annotationFile}`);
        contextLines.push(`The screenshot shows the actual rendered page. Use read_file and edit_file tools to find and modify the relevant source files in the project.`);
      } else {
        contextLines.push(`File path: ${annotationFile}`);
        if (annotationCode) {
          contextLines.push(`Full code of this file (${fileName}):`);
          contextLines.push('```');
          contextLines.push(annotationCode);
          contextLines.push('```');
        }
      }
      contextLines.push(``);
      contextLines.push(`User request: ${userRequest || 'Please modify based on my circled area'}`);
      const contextText = contextLines.join('\n');

      if (provider === 'anthropic') {
        userContent = [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: annotationImage } },
          { type: 'text', text: contextText },
        ];
      } else {
        userContent = [
          { type: 'image_url', image_url: { url: `data:image/png;base64,${annotationImage}`, detail: 'high' } },
          { type: 'text', text: contextText },
        ];
      }
      const label = isLive ? annotationFile : fileName;
      displayText = `\ud83d\udcce [${label}] ${userRequest || 'Please modify based on my circled area'}`;

      // Clean up annotation data
      delete aiPanel.dataset.annotationImage;
      delete aiPanel.dataset.annotationCode;
      delete aiPanel.dataset.annotationFile;
      const indicator = document.getElementById('annotation-indicator');
      if (indicator) indicator.style.display = 'none';
    }

    // Add user message
    this.aiMessages.push({ role: 'user', content: userContent });
    this.aiAddMsg('user', displayText);

    // ── Memory Recall: inject relevant memories into system prompt ──
    let memoryBlock = '';
    if (this.rootFolder) {
      try {
        const recallResult = await window.xpro.memoryRecall(this.rootFolder, userText);
        if (recallResult.ok && recallResult.data && recallResult.data.length > 0) {
          const memLines = recallResult.data.map((m: any) => `- [${m.type}] ${m.content}`);
          memoryBlock = [
            ``,
            `## Project Memory (from previous sessions)`,
            ...memLines,
            ``,
          ].join('\n');
          this.updateMemoryIndicator();
        }
      } catch (e) {
        console.warn('[Memory] Recall failed:', e);
      }
    }

    // System prompt depends on AI mode (Ask vs Agent)
    const currentMode = AiService.getMode();
    const systemPrompt = currentMode === 'ask'
      ? AiService.getAskSystemPrompt(this.rootFolder, this.lang)
      : AiService.getAgentSystemPrompt(this.rootFolder, this.lang, memoryBlock);

    this.setAiRunning(true);

    const container = document.getElementById('ai-messages')!;

    // Create a status line for thinking
    const statusDiv = document.createElement('div');
    statusDiv.className = 'ai-msg tool-status';
    statusDiv.textContent = 'Thinking...';
    container.appendChild(statusDiv);
    container.scrollTop = container.scrollHeight;

    const config: any = { model: model || 'gpt-4o', provider, lang: this.lang, thinking: this.aiConfig.thinking };
    if (provider === 'openai') {
      config.apiKey = this.aiConfig.openaiKey;
      config.baseUrl = this.aiConfig.openaiBase;
    } else {
      config.apiKey = this.aiConfig.anthropicKey;
      config.baseUrl = this.aiConfig.anthropicBase;
    }

    const messages = [
      { role: 'system', content: systemPrompt },
      ...this.aiMessages,
    ];

    const reqId = `req_${++this.aiRequestId}_${Date.now()}`;
    let textAccum = '';

    // Create a response wrapper: [AI text] then [tool log] below it
    const responseWrapper = document.createElement('div');
    responseWrapper.className = 'ai-msg assistant';
    const roleLabel = document.createElement('div');
    roleLabel.className = 'msg-role';
    roleLabel.textContent = 'AI';
    responseWrapper.appendChild(roleLabel);
    const textEl = document.createElement('div');
    textEl.className = 'ai-body';
    responseWrapper.appendChild(textEl);
    const toolLog = document.createElement('div');
    toolLog.className = 'tool-log';
    responseWrapper.appendChild(toolLog);
    container.appendChild(responseWrapper);

    const addToolLine = (cls: string, html: string) => {
      const line = document.createElement('div');
      line.className = `tool-line ${cls}`;
      line.innerHTML = html;
      toolLog.appendChild(line);
      container.scrollTop = container.scrollHeight;
    };

    // Listen for tool events
    const handler = (_rid: string, evt: any) => {
      if (_rid !== reqId) return;
      switch (evt.type) {
        case 'thinking':
          statusDiv.textContent = 'Thinking...';
          break;

        case 'tool_call': {
          const agentTag = evt.agentName ? `<span class="tl-agent">[${this.escHtml(evt.agentName.slice(0, 20))}]</span> ` : '';
          const argSnippet = evt.toolArgs
            ? Object.entries(evt.toolArgs).filter(([k]) => k !== 'task').map(([k, v]) => {
                const vs = String(v);
                return `${k}=${vs.length > 60 ? vs.slice(0, 60) + '…' : vs}`;
              }).join(' ')
            : '';
          const displayName = evt.toolName === 'sub_agent' ? '⚡ sub_agent' : evt.toolName;
          addToolLine('call', `<span class="tl-icon">▸</span> ${agentTag}${displayName} <span class="tl-dim">${this.escHtml(argSnippet)}</span>`);
          statusDiv.textContent = evt.agentName ? `[${evt.agentName.slice(0, 20)}] ${evt.toolName}...` : `${evt.toolName}...`;
          break;
        }

        case 'tool_result': {
          const ok = evt.toolOk;
          const agentTag = evt.agentName ? `<span class="tl-agent">[${this.escHtml(evt.agentName.slice(0, 20))}]</span> ` : '';
          const preview = (evt.toolResult || '').split('\n')[0].slice(0, 80);
          addToolLine(ok ? 'ok' : 'err', `<span class="tl-badge ${ok ? 'ok' : 'err'}">${ok ? '✓' : '✗'}</span> ${agentTag}${this.escHtml(preview)}`);
          statusDiv.textContent = 'Thinking...';
          break;
        }

        case 'text': {
          const cleanEvtText = (evt.text || '').replace(/\[GOAL_COMPLETE\]/g, '').trim();
          if (!cleanEvtText) break;
          textAccum += cleanEvtText;
          textEl.textContent = textAccum;
          container.scrollTop = container.scrollHeight;
          break;
        }

        case 'done': {
          statusDiv.remove();
          let finalText = textAccum ? textAccum : (evt.text || '');
          finalText = finalText.replace(/\[GOAL_COMPLETE\]/g, '').trim();
          if (!textAccum && evt.text) textAccum = evt.text;
          if (finalText) {
            textEl.textContent = finalText;
          }
          // Restore full conversation history (includes tool calls & results)
          if (evt.conversationHistory && evt.conversationHistory.length > 0) {
            // Replace aiMessages with full history (skip system prompt)
            this.aiMessages = evt.conversationHistory.filter((m: any) => m.role !== 'system');
            console.log(`[AI] Restored ${this.aiMessages.length} messages with tool context`);
          } else if (finalText) {
            this.aiMessages.push({ role: 'assistant', content: finalText });
          }
          // Remove empty tool log if no tools were called
          if (toolLog.children.length === 0) toolLog.remove();
          // Remove empty text if no text was produced
          if (!textEl.textContent) textEl.remove();
          this.setAiRunning(false);
          container.scrollTop = container.scrollHeight;

          // ── Memory Ingestion: extract and store memories from this conversation ──
          this.ingestMemories(config);
          break;
        }

        case 'token_usage': {
          this.totalInputTokens += (evt.inputTokens || 0);
          this.totalOutputTokens += (evt.outputTokens || 0);
          this.updateTokenDisplay();
          break;
        }

        case 'error': {
          statusDiv.remove();
          textEl.innerHTML = `<span style="color:#f87171">Error: ${this.escHtml(evt.error || 'unknown')}</span>`;
          if (toolLog.children.length === 0) toolLog.remove();
          container.scrollTop = container.scrollHeight;
          this.setAiRunning(false);
          break;
        }
      }
    };

    this.aiEventHandler = handler;
    try {
      await window.xpro.aiChatWithTools(provider, config, messages, reqId);
    } catch (err: any) {
      statusDiv.remove();
      this.aiAddSystem(`Error: ${err.message || err}`);
      this.aiEventHandler = null;
      this.setAiRunning(false);
    }
  }

  /** Ingest memories from the current conversation (runs in background). */
  private async ingestMemories(config: any) {
    if (!this.rootFolder) {
      console.log('[Memory] Skipped: no rootFolder');
      return;
    }
    if (this.aiMessages.length < 2) {
      console.log('[Memory] Skipped: too few messages', this.aiMessages.length);
      return;
    }
    try {
      // Extract readable text from complex conversation history
      const GOAL_CHECK_PREFIX = 'IMPORTANT: Review the user\'s original request';
      const msgs: Array<{role: string; content: string}> = [];
      for (const m of this.aiMessages) {
        if (m.role !== 'user' && m.role !== 'assistant') continue;
        let text = '';
        if (typeof m.content === 'string') {
          text = m.content;
        } else if (Array.isArray(m.content as any)) {
          // Anthropic format: extract text blocks only
          text = (m.content as any[])
            .filter((b: any) => b.type === 'text' && b.text)
            .map((b: any) => b.text)
            .join('\n');
        } else if (m.content == null && (m as any).tool_calls) {
          // OpenAI tool-call-only message, skip
          continue;
        }
        // Skip goal check prompts and empty messages
        if (!text || text.startsWith(GOAL_CHECK_PREFIX)) continue;
        msgs.push({ role: m.role, content: text });
      }
      if (msgs.length < 2) {
        console.log('[Memory] Skipped: filtered messages < 2');
        return;
      }

      console.log(`[Memory] Ingesting ${msgs.length} messages for project: ${this.rootFolder}`);
      console.log(`[Memory] Config: model=${config.model}, baseUrl=${config.baseUrl}, hasKey=${!!config.apiKey}`);
      const result = await window.xpro.memoryIngest(this.rootFolder, config, msgs, this.aiSessionId);
      console.log('[Memory] Ingest result:', JSON.stringify(result));
      if (result.ok && result.stored > 0) {
        this.aiAddSystem(`🧠 Memory: extracted ${result.stored} new memories`);
      } else if (!result.ok) {
        this.aiAddSystem(`🧠 Memory extraction failed: ${result.error || 'unknown error'}`);
      } else {
        this.aiAddSystem(`🧠 Memory: 0 stored. ${result.error || 'Conversation may be too short or trivial.'}`);
      }
      this.updateMemoryIndicator();
    } catch (e: any) {
      console.warn('[Memory] Ingestion failed:', e);
      this.aiAddSystem(`🧠 Memory ingestion error: ${e.message || e}`);
    }
  }

  /** Update the memory indicator badge to show checkpoint + memory count. */
  private async updateMemoryIndicator() {
    const countEl = document.getElementById('memory-count');
    const btn = document.getElementById('btn-memory');
    const cpCount = CheckpointService.getAll().length;
    let memCount = 0;
    if (this.rootFolder) {
      try {
        const stats = await window.xpro.memoryStats(this.rootFolder);
        if (stats.ok && stats.data) memCount = stats.data.active || 0;
      } catch {}
    }
    const n = cpCount + memCount;
    if (countEl) countEl.textContent = String(n);
    if (btn) {
      btn.classList.toggle('has-memories', n > 0);
      const isZh = this.lang === 'zh';
      btn.title = n > 0
        ? (isZh ? `${cpCount} 变更, ${memCount} 记忆` : `${cpCount} changes, ${memCount} memories`)
        : (isZh ? '记忆 (空)' : 'Memory (empty)');
    }
  }

  /** Format token count for display (e.g. 1234 -> 1.2k) */
  private formatTokens(n: number): string {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
    return String(n);
  }

  /** Update the token usage display */
  private updateTokenDisplay() {
    const inEl = document.getElementById('token-in');
    const outEl = document.getElementById('token-out');
    if (inEl) inEl.textContent = this.formatTokens(this.totalInputTokens);
    if (outEl) outEl.textContent = this.formatTokens(this.totalOutputTokens);
  }

  /** Show unified memory panel: file changes with diff + LLM memories. */
  private async showMemoryPanel() {
    const isZh = this.lang === 'zh';
    const checkpoints = CheckpointService.getAll().reverse();

    // Fetch LLM memories
    let memories: any[] = [];
    if (this.rootFolder) {
      try {
        const res = await window.xpro.memoryList(this.rootFolder);
        if (res.ok && res.data) memories = res.data;
      } catch {}
    }

    // Remove existing panel
    document.getElementById('memory-panel-overlay')?.remove();

    const overlay = document.createElement('div');
    overlay.id = 'memory-panel-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;';

    const panel = document.createElement('div');
    panel.style.cssText = 'background:var(--canvas-bg);border:1px solid var(--detail-border);border-radius:10px;padding:20px;width:660px;max-height:78vh;overflow-y:auto;box-shadow:0 8px 32px rgba(0,0,0,0.5);';

    // Header
    const header = document.createElement('div');
    header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;';
    header.innerHTML = `<h3 style="margin:0;font-size:15px;color:var(--node-text)">🧠 ${isZh ? '记忆与变更' : 'Memories & Changes'}</h3>`;
    const closeBtn = document.createElement('button');
    closeBtn.textContent = '✕';
    closeBtn.style.cssText = 'background:none;border:none;color:var(--node-text-dim);font-size:16px;cursor:pointer;';
    closeBtn.onclick = () => overlay.remove();
    header.appendChild(closeBtn);
    panel.appendChild(header);

    /* ── Section 1: File Changes ── */
    const changeTitle = document.createElement('div');
    changeTitle.style.cssText = 'font-size:12px;font-weight:600;color:var(--node-text);margin-bottom:8px;padding-bottom:4px;border-bottom:1px solid rgba(255,255,255,0.08);display:flex;justify-content:space-between;align-items:center;';
    changeTitle.innerHTML = isZh ? `文件变更 (${checkpoints.length})` : `File Changes (${checkpoints.length})`;
    panel.appendChild(changeTitle);


    if (checkpoints.length === 0) {
      const emptyMsg = document.createElement('div');
      emptyMsg.style.cssText = 'color:var(--node-text-dim);font-size:11px;text-align:center;padding:12px;';
      emptyMsg.textContent = isZh ? '暂无变更。AI 修改文件后自动记录。' : 'No changes yet.';
      panel.appendChild(emptyMsg);
    } else {
      // Group by category
      const hasCategories = checkpoints.some(cp => cp.category);
      const groups: Map<string, typeof checkpoints> = new Map();
      if (hasCategories) {
        for (const cp of checkpoints) {
          const cat = cp.category || (isZh ? '未分类' : 'Uncategorized');
          if (!groups.has(cat)) groups.set(cat, []);
          groups.get(cat)!.push(cp);
        }
      } else {
        groups.set('', checkpoints);
      }

      const catColors = ['#60a5fa', '#fbbf24', '#a78bfa', '#34d399', '#fb923c', '#f472b6', '#94a3b8'];
      let catIdx = 0;

      for (const [category, cps] of groups) {
        // Category header
        if (category) {
          const catHeader = document.createElement('div');
          const color = catColors[catIdx % catColors.length];
          catIdx++;
          catHeader.style.cssText = `font-size:11px;font-weight:600;color:${color};margin:10px 0 4px;padding:3px 8px;background:${color}15;border-left:3px solid ${color};border-radius:0 4px 4px 0;`;
          catHeader.textContent = `${category} (${cps.length})`;
          panel.appendChild(catHeader);
        }

        for (const cp of cps) {
          panel.appendChild(this.renderCheckpointItem(cp, isZh, overlay));
        }
      }
    }

    /* ── Section 2: LLM Memories ── */
    const memTitle = document.createElement('div');
    memTitle.style.cssText = 'font-size:12px;font-weight:600;color:var(--node-text);margin:16px 0 8px;padding-bottom:4px;border-bottom:1px solid rgba(255,255,255,0.08);';
    memTitle.textContent = isZh ? `项目记忆 (${memories.length})` : `Project Memories (${memories.length})`;
    panel.appendChild(memTitle);

    if (memories.length === 0) {
      const emptyMem = document.createElement('div');
      emptyMem.style.cssText = 'color:var(--node-text-dim);font-size:11px;text-align:center;padding:12px;';
      emptyMem.textContent = isZh ? '暂无记忆。与 AI 对话后自动积累。' : 'No memories yet. Chat with AI to build memory.';
      panel.appendChild(emptyMem);
    } else {
      const typeColors: Record<string, string> = { fact: '#60a5fa', event: '#fbbf24', instruction: '#a78bfa', task: '#34d399' };
      for (const mem of memories) {
        const memItem = document.createElement('div');
        memItem.className = 'mem-memory-item';
        const left = document.createElement('div');
        left.style.cssText = 'flex:1;';
        left.innerHTML = `<span class="mem-type-badge" style="color:${typeColors[mem.type] || '#94a3b8'}">${mem.type}</span> ${this.escHtml(mem.content)}`;
        memItem.appendChild(left);
        const delBtn = document.createElement('button');
        delBtn.textContent = '✕';
        delBtn.className = 'mem-del-btn';
        delBtn.onclick = async () => {
          await window.xpro.memoryForget(this.rootFolder, mem.id);
          memItem.remove();
          this.updateMemoryIndicator();
        };
        memItem.appendChild(delBtn);
        panel.appendChild(memItem);
      }
    }

    // Clear all button
    if (checkpoints.length > 0 || memories.length > 0) {
      const clearDiv = document.createElement('div');
      clearDiv.style.cssText = 'display:flex;gap:8px;margin-top:12px;';
      if (checkpoints.length > 0) {
        const clearCpBtn = document.createElement('button');
        clearCpBtn.textContent = isZh ? '清除变更记录' : 'Clear Changes';
        clearCpBtn.style.cssText = 'flex:1;padding:6px;background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.2);border-radius:6px;color:#f87171;font-size:11px;cursor:pointer;';
        clearCpBtn.onclick = () => { CheckpointService.clear(); overlay.remove(); this.updateMemoryIndicator(); };
        clearDiv.appendChild(clearCpBtn);
      }
      if (memories.length > 0) {
        const clearMemBtn = document.createElement('button');
        clearMemBtn.textContent = isZh ? '清除所有记忆' : 'Clear Memories';
        clearMemBtn.style.cssText = 'flex:1;padding:6px;background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.2);border-radius:6px;color:#f87171;font-size:11px;cursor:pointer;';
        clearMemBtn.onclick = async () => { await window.xpro.memoryClear(this.rootFolder); overlay.remove(); this.updateMemoryIndicator(); };
        clearDiv.appendChild(clearMemBtn);
      }
      panel.appendChild(clearDiv);
    }

    overlay.appendChild(panel);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
  }

  /** Auto-categorize uncategorized checkpoints via AI */
  private async autoCategorize(config: any) {
    const uncategorized = CheckpointService.getUncategorized();
    if (uncategorized.length < 2) return;
    const changes = uncategorized.map(cp => ({
      id: cp.id,
      label: cp.label,
      filePath: cp.snapshots[0]?.path || '',
    }));
    try {
      const res = await window.xpro.memoryCategorize(config, changes);
      if (res.ok && res.mapping) {
        CheckpointService.updateCategories(res.mapping);
        console.log(`[AutoCategorize] Categorized ${Object.keys(res.mapping).length} changes`);
      }
    } catch (e) {
      console.warn('[AutoCategorize] Failed:', e);
    }
  }

  /** Render a single checkpoint item for the memory panel */
  private renderCheckpointItem(cp: any, isZh: boolean, overlay: HTMLElement): HTMLElement {
    const snap = cp.snapshots[0];
    const fileName = snap ? (snap.path.split(/[\\/]/).pop() || snap.path) : '';
    const time = new Date(cp.timestamp);
    const timeStr = `${time.getHours().toString().padStart(2, '0')}:${time.getMinutes().toString().padStart(2, '0')}:${time.getSeconds().toString().padStart(2, '0')}`;

    const item = document.createElement('div');
    item.className = 'mem-change-item';

    const row = document.createElement('div');
    row.className = 'mem-change-row';

    const dot = document.createElement('span');
    dot.className = 'mem-dot' + (cp.applied ? '' : ' rolled-back');
    row.appendChild(dot);

    const titleEl = document.createElement('span');
    titleEl.className = 'mem-change-title';
    titleEl.textContent = cp.label;
    titleEl.title = snap?.path || '';
    row.appendChild(titleEl);

    const timeEl = document.createElement('span');
    timeEl.className = 'mem-time';
    timeEl.textContent = timeStr;
    row.appendChild(timeEl);

    const expandBtn = document.createElement('button');
    expandBtn.className = 'mem-expand-btn';
    expandBtn.textContent = '▸';
    expandBtn.title = isZh ? '查看代码差异' : 'View diff';
    row.appendChild(expandBtn);

    const actionBtn = document.createElement('button');
    if (cp.applied) {
      actionBtn.className = 'mem-action-btn rollback';
      actionBtn.textContent = isZh ? '撤回' : 'Undo';
    } else {
      actionBtn.className = 'mem-action-btn redo';
      actionBtn.textContent = isZh ? '恢复' : 'Redo';
    }
    row.appendChild(actionBtn);

    const delBtn = document.createElement('button');
    delBtn.className = 'mem-action-btn';
    delBtn.textContent = '✕';
    delBtn.title = isZh ? '删除此记录' : 'Delete';
    delBtn.style.cssText = 'background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.2);color:#f87171;font-size:10px;padding:1px 6px;margin-left:4px;border-radius:4px;cursor:pointer;';
    delBtn.addEventListener('click', () => {
      CheckpointService.remove(cp.id);
      overlay.remove();
      this.updateMemoryIndicator();
      this.showMemoryPanel();
    });
    row.appendChild(delBtn);

    item.appendChild(row);

    const diffContainer = document.createElement('div');
    diffContainer.className = 'mem-diff-container hidden';
    item.appendChild(diffContainer);

    expandBtn.addEventListener('click', () => {
      const isHidden = diffContainer.classList.contains('hidden');
      if (isHidden) {
        expandBtn.textContent = '▾';
        diffContainer.classList.remove('hidden');
        if (!diffContainer.dataset.rendered && snap) {
          diffContainer.dataset.rendered = '1';
          const oldC = snap.content || '';
          const newC = snap.newContent || '';
          const fileHeader = document.createElement('div');
          fileHeader.className = 'mem-diff-file-header';
          fileHeader.textContent = fileName;
          diffContainer.appendChild(fileHeader);
          const diff = ApprovalService.computeCompactDiff(oldC, newC, 3);
          if (diff.length === 0) {
            diffContainer.innerHTML += `<div class="mem-diff-empty">${isZh ? '无可见差异' : 'No visible changes'}</div>`;
          } else {
            const diffHtml = diff.map((d: any) =>
              `<div class="diff-line ${d.type}">${this.escHtml(d.content)}</div>`
            ).join('');
            diffContainer.innerHTML += diffHtml;
          }
        }
      } else {
        expandBtn.textContent = '▸';
        diffContainer.classList.add('hidden');
      }
    });

    actionBtn.addEventListener('click', async () => {
      if (cp.applied) {
        const result = await CheckpointService.rollback(cp.id);
        if (result.ok) {
          this.aiAddSystem(isZh ? `已撤回 ${result.restored.length} 个文件` : `Undone ${result.restored.length} file(s)`);
          if (this.editingPath && result.restored.includes(this.editingPath)) this.refreshOpenFile();
        }
      } else {
        const result = await CheckpointService.redo(cp.id);
        if (result.ok) {
          this.aiAddSystem(isZh ? `已恢复 ${result.restored.length} 个文件` : `Re-applied ${result.restored.length} file(s)`);
          if (this.editingPath && result.restored.includes(this.editingPath)) this.refreshOpenFile();
        }
      }
      overlay.remove();
      this.updateMemoryIndicator();
      this.showMemoryPanel();
    });

    return item;
  }

  private escHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /* ========== Terminal (real CMD) ========== */
  private shellStarted = false;
  private cmdHistory: string[] = [];
  private cmdHistoryIdx = -1;
  private termInputBuf = '';

  /** Get or create the blinking cursor element at end of terminal */
  private termEnsureCursor() {
    const output = document.getElementById('terminal-output')!;
    let cursor = output.querySelector('.term-cursor') as HTMLSpanElement;
    if (!cursor) {
      cursor = document.createElement('span');
      cursor.className = 'term-cursor';
      output.appendChild(cursor);
    }
    cursor.textContent = this.termInputBuf;
    output.scrollTop = output.scrollHeight;
  }

  /** Update the cursor element to reflect current input buffer */
  private termUpdateCursor() {
    const output = document.getElementById('terminal-output')!;
    let cursor = output.querySelector('.term-cursor') as HTMLSpanElement;
    if (!cursor) {
      this.termEnsureCursor();
      return;
    }
    cursor.textContent = this.termInputBuf;
    output.scrollTop = output.scrollHeight;
  }

  /** Remove cursor element (before appending command output) */
  private termRemoveCursor() {
    const output = document.getElementById('terminal-output')!;
    const cursor = output.querySelector('.term-cursor');
    if (cursor) cursor.remove();
  }

  /** ANSI color code to CSS color map */
  private static ANSI_COLORS: Record<string, string> = {
    '30': '#555', '31': '#f87171', '32': '#6ee7b7', '33': '#fbbf24',
    '34': '#60a5fa', '35': '#c084fc', '36': '#22d3ee', '37': '#e2e8f0',
    '90': '#888', '91': '#fca5a5', '92': '#86efac', '93': '#fde68a',
    '94': '#93c5fd', '95': '#d8b4fe', '96': '#67e8f9', '97': '#f8fafc',
  };

  private termAppend(text: string) {
    const output = document.getElementById('terminal-output')!;
    this.termRemoveCursor();

    // Parse ANSI escape codes: \x1b[<code>m
    const ansiRegex = /\x1b\[([0-9;]*)m/g;
    let lastIdx = 0;
    let currentColor = '';
    let match: RegExpExecArray | null;

    while ((match = ansiRegex.exec(text)) !== null) {
      // Append text before this escape code
      if (match.index > lastIdx) {
        const span = document.createElement('span');
        if (currentColor) span.style.color = currentColor;
        span.textContent = text.slice(lastIdx, match.index);
        output.appendChild(span);
      }
      // Parse the code
      const codes = match[1].split(';');
      for (const code of codes) {
        if (code === '0' || code === '') {
          currentColor = '';
        } else if (WorkflowCanvas.ANSI_COLORS[code]) {
          currentColor = WorkflowCanvas.ANSI_COLORS[code];
        }
      }
      lastIdx = match.index + match[0].length;
    }

    // Append remaining text
    if (lastIdx < text.length) {
      const span = document.createElement('span');
      if (currentColor) span.style.color = currentColor;
      span.textContent = text.slice(lastIdx);
      output.appendChild(span);
    }

    this.termEnsureCursor();
    output.scrollTop = output.scrollHeight;

    // Detect dev server URLs in terminal output (strip ANSI codes first)
    const plainText = text.replace(/\x1b\[[0-9;]*m/g, '');
    const urlMatch = plainText.match(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::\]):\d+/i);
    if (urlMatch) {
      let url = urlMatch[0];
      // Normalize 0.0.0.0 / [::] to localhost
      url = url.replace(/0\.0\.0\.0|\[::\]/, 'localhost');
      console.log('[LivePreview] URL detected:', url, 'current:', this.liveServerUrl);
      if (url !== this.liveServerUrl) {
        this.liveServerUrl = url;
        console.log('[LivePreview] Opening preview for:', url);
        this.showLivePreview(url);
      }
    }
  }

  private liveHistory: string[] = [];
  private liveHistoryIdx = -1;

  private showLivePreview(url: string) {
    const banner = document.getElementById('live-preview-banner')!;
    const urlSpan = document.getElementById('live-preview-url')!;
    urlSpan.textContent = url;
    banner.classList.remove('hidden');

    // Show in detail panel's preview iframe
    const panel = document.getElementById('detail-panel')!;
    const previewPane = document.getElementById('preview-pane')!;
    const frame = document.getElementById('preview-frame') as HTMLIFrameElement;
    const editorPane = document.getElementById('editor-pane')!;

    panel.classList.remove('hidden');
    panel.classList.add('has-preview', 'live-mode');
    previewPane.classList.remove('hidden');
    editorPane.classList.add('hidden');

    // Show toolbar Preview button
    document.getElementById('btn-preview')?.classList.remove('hidden');

    // Show URL bar, hide title
    const urlBar = document.getElementById('url-bar')!;
    const urlInput = document.getElementById('url-input') as HTMLInputElement;
    const detailTitle = document.getElementById('detail-title')!;
    detailTitle.classList.add('hidden');
    urlBar.classList.remove('hidden');
    urlInput.value = url;

    document.getElementById('detail-save')!.classList.add('hidden');
    document.getElementById('detail-modified')!.classList.add('hidden');

    // Track history
    this.liveHistory = [url];
    this.liveHistoryIdx = 0;

    // Remove sandbox for live server (localhost is trusted)
    frame.removeAttribute('sandbox');
    frame.removeAttribute('srcdoc');
    frame.src = url;
  }

  private navigateLivePreview(url: string, addToHistory = true) {
    const frame = document.getElementById('preview-frame') as HTMLIFrameElement;
    const urlInput = document.getElementById('url-input') as HTMLInputElement;
    const urlSpan = document.getElementById('live-preview-url')!;

    urlInput.value = url;
    urlSpan.textContent = url;
    frame.src = url;

    if (addToHistory) {
      // Trim forward history
      this.liveHistory = this.liveHistory.slice(0, this.liveHistoryIdx + 1);
      this.liveHistory.push(url);
      this.liveHistoryIdx = this.liveHistory.length - 1;
    }
  }

  /** Debounced refresh of the live server iframe (300ms) */
  private refreshLivePreview() {
    if (!this.liveServerUrl) return;
    if (this.liveRefreshTimer) clearTimeout(this.liveRefreshTimer);
    this.liveRefreshTimer = setTimeout(() => {
      const frame = document.getElementById('preview-frame') as HTMLIFrameElement;
      if (this.liveServerUrl && frame) {
        frame.src = this.liveServerUrl;
      }
    }, 300);
  }

  private closeLivePreview() {
    this.liveServerUrl = null;
    this.liveHistory = [];
    this.liveHistoryIdx = -1;
    const banner = document.getElementById('live-preview-banner')!;
    banner.classList.add('hidden');

    const panel = document.getElementById('detail-panel')!;
    const previewPane = document.getElementById('preview-pane')!;
    const frame = document.getElementById('preview-frame') as HTMLIFrameElement;
    const editorPane = document.getElementById('editor-pane')!;

    // Restore title, hide URL bar
    document.getElementById('detail-title')!.classList.remove('hidden');
    document.getElementById('url-bar')!.classList.add('hidden');

    panel.classList.add('hidden');
    panel.classList.remove('has-preview', 'live-mode');
    previewPane.classList.add('hidden');
    editorPane.classList.remove('hidden');
    frame.src = '';
    frame.removeAttribute('srcdoc');
    // Restore sandbox for normal file preview
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-modals');
    this.editingPath = null;

    // Hide toolbar Preview button
    document.getElementById('btn-preview')?.classList.add('hidden');
  }

  private async ensureShell() {
    if (this.shellStarted) return;
    this.shellStarted = true;
    const cwd = this.rootFolder || undefined;
    await window.xpro.shellStart(cwd);
  }

  private async termExec(cmd: string) {
    await this.ensureShell();

    // 记录历史
    if (cmd.trim()) {
      this.cmdHistory.push(cmd);
      this.cmdHistoryIdx = this.cmdHistory.length;
    }

    // 发送到 CMD（加回车）
    await window.xpro.shellWrite(cmd + '\r\n');
  }

  /* ========== 折叠/展开（懒加载） ========== */
  private async toggleCollapse(id: string) {
    const node = this.nodes.get(id);
    if (!node || !node.isDir) return;

    // 首次展开：从磁盘加载子目录内容
    if (!node.loaded) {
      const entries = await this.readOneLevel(node.path);
      for (const entry of entries) {
        this.addNode(entry, node.id);
      }
      node.loaded = true;
      // 渲染新增的子节点和连线
      for (const cid of node.childIds) {
        const child = this.nodes.get(cid);
        if (child && !child.el) this.createNodeEl(child);
      }
      for (const edge of this.edges) {
        if (edge.from === id && !edge.pathEl) this.createEdgeEl(edge);
      }
      // 更新父节点显示（子节点数量）
      this.updateNodeLabel(node);
    }

    node.collapsed = !node.collapsed;
    this.setChildVisibility(node, !node.collapsed);
    this.updateNodeLabel(node);
    this.autoLayout();
    this.updateVisiblePositions();
    this.updateEdges();
    this.updateMinimap();
    document.getElementById('node-count')!.textContent = `${this.nodes.size} nodes`;
  }

  private updateNodeLabel(node: WfNode) {
    if (!node.el) return;
    const body = node.el.querySelector('.node-body');
    if (!body) return;
    const arrow = node.collapsed ? '▸' : '▾';
    const ext = 'folder';
    body.innerHTML = `
      <span class="node-type">${ext}</span>
      <span style="margin-left:4px;opacity:0.5">${arrow} ${node.childIds.length} items</span>
    `;
  }

  private setChildVisibility(node: WfNode, visible: boolean) {
    for (const cid of node.childIds) {
      const child = this.nodes.get(cid);
      if (!child) continue;
      if (child.el) child.el.style.display = visible ? '' : 'none';
      // hide edges
      for (const edge of this.edges) {
        if (edge.from === node.id && edge.to === cid) {
          if (edge.pathEl) edge.pathEl.style.display = visible ? '' : 'none';
        }
      }
      if (!visible || child.collapsed) {
        this.setChildVisibility(child, false);
      } else {
        this.setChildVisibility(child, true);
      }
    }
  }

  private updateVisiblePositions() {
    for (const node of this.nodes.values()) {
      if (node.el && node.el.style.display !== 'none') {
        this.positionNode(node);
      }
    }
  }

  /* ========== 文件详情 ========== */
  private static TEXT_EXTS = new Set([
    'ts', 'js', 'tsx', 'jsx', 'mjs', 'cjs',
    'json', 'json5', 'jsonc',
    'html', 'htm', 'xml', 'svg',
    'css', 'scss', 'less', 'sass',
    'md', 'markdown', 'txt', 'text', 'log',
    'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf',
    'rs', 'py', 'pyw', 'rb', 'go', 'java', 'kt', 'kts',
    'c', 'h', 'cpp', 'cc', 'cxx', 'hpp', 'hxx',
    'cs', 'fs', 'fsx', 'swift', 'scala', 'clj',
    'sh', 'bash', 'zsh', 'fish', 'bat', 'cmd', 'ps1',
    'sql', 'graphql', 'gql',
    'env', 'editorconfig', 'gitignore', 'gitattributes', 'dockerignore',
    'dockerfile', 'makefile', 'cmake',
    'lock', 'properties', 'gradle',
    'vue', 'svelte', 'astro',
    'r', 'R', 'lua', 'dart', 'ex', 'exs', 'erl', 'hrl',
    'tf', 'hcl', 'proto',
  ]);

  private isTextFile(name: string): boolean {
    const lower = name.toLowerCase();
    // 无扩展名的常见文本文件
    const basenames = ['makefile', 'dockerfile', 'rakefile', 'gemfile', 'procfile',
      'readme', 'license', 'changelog', 'authors', 'contributors',
      '.gitignore', '.gitattributes', '.editorconfig', '.env', '.npmrc',
      '.prettierrc', '.eslintrc', '.babelrc', 'cargo.toml', 'cargo.lock'];
    if (basenames.includes(lower)) return true;

    const ext = lower.split('.').pop() || '';
    return WorkflowCanvas.TEXT_EXTS.has(ext);
  }

  /* ========== Auto-refresh on external file change ========== */

  private async refreshOpenFile() {
    if (!this.editingPath) return;
    try {
      const result = await window.xpro.readFile(this.editingPath);
      if (!result.ok || result.data == null) return;

      const editor = document.getElementById('detail-editor') as HTMLTextAreaElement;
      const cursorPos = editor.selectionStart;
      editor.value = result.data;
      this.originalContent = result.data;
      this.isModified = false;
      document.getElementById('detail-save')!.classList.add('hidden');
      document.getElementById('detail-modified')!.classList.add('hidden');

      // Restore cursor position as close as possible
      editor.selectionStart = editor.selectionEnd = Math.min(cursorPos, result.data.length);

      // Refresh preview
      if (this.isPreviewable(this.editingPath)) {
        const ext = this.editingPath.split('.').pop()?.toLowerCase() || '';
        this.updatePreview(result.data, ext, this.editingPath);
      }
    } catch (err) {
      console.error('[refreshOpenFile]', err);
    }
  }

  /* ========== Annotation helpers ========== */

  private resizeAnnotateCanvas() {
    const canvas = document.getElementById('annotate-canvas') as HTMLCanvasElement;
    const container = document.getElementById('preview-container')!;
    canvas.width = container.clientWidth;
    canvas.height = container.clientHeight;
  }

  private clearAnnotateCanvas() {
    const canvas = document.getElementById('annotate-canvas') as HTMLCanvasElement;
    const ctx = canvas.getContext('2d');
    if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  private async captureAnnotation() {
    const canvas = document.getElementById('annotate-canvas') as HTMLCanvasElement;
    const container = document.getElementById('preview-container')!;

    try {
      const w = container.clientWidth;
      const h = container.clientHeight;

      const composite = document.createElement('canvas');
      composite.width = w;
      composite.height = h;
      const compCtx = composite.getContext('2d')!;

      compCtx.fillStyle = '#fff';
      compCtx.fillRect(0, 0, w, h);

      // Capture full window screenshot, then crop to preview container region
      const rect = container.getBoundingClientRect();
      let captured = false;

      try {
        console.log('[Annotate] Requesting full page capture...');
        const result = await (window as any).xpro.captureRect({ x: 0, y: 0, width: 0, height: 0 });
        console.log('[Annotate] Capture result: ok=', result.ok, 'dataLen=', result.data?.length || 0,
          'imgSize=', result.imgWidth, 'x', result.imgHeight, 'contentSize=', result.contentWidth, 'x', result.contentHeight);

        if (result.ok && result.data && result.data.length > 100) {
          const fullImg = new Image();
          await new Promise<void>((resolve) => {
            fullImg.onload = () => {
              // Calculate scale: physical pixels / CSS pixels
              const scaleX = result.imgWidth / result.contentWidth;
              const scaleY = result.imgHeight / result.contentHeight;

              // Crop region in physical pixels
              const sx = Math.round(rect.left * scaleX);
              const sy = Math.round(rect.top * scaleY);
              const sw = Math.round(rect.width * scaleX);
              const sh = Math.round(rect.height * scaleY);

              console.log('[Annotate] Cropping: CSS rect=', Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), 'x', Math.round(rect.height),
                '-> physical=', sx, sy, sw, 'x', sh, 'scale=', scaleX.toFixed(2), scaleY.toFixed(2));

              // Draw cropped region onto composite
              compCtx.drawImage(fullImg, sx, sy, sw, sh, 0, 0, w, h);
              resolve();
            };
            fullImg.onerror = () => { console.warn('[Annotate] Full image load failed'); resolve(); };
            fullImg.src = `data:image/png;base64,${result.data}`;
          });
          captured = true;
          console.log('[Annotate] Native capture + crop succeeded');
        }
      } catch (e) {
        console.warn('[Annotate] Native capture failed, trying DOM fallback:', e);
      }

      // Fallback: try DOM serialization for same-origin iframes
      if (!captured) {
        try {
          const frame = document.getElementById('preview-frame') as HTMLIFrameElement;
          const iframeDoc = frame.contentDocument || frame.contentWindow?.document;
          if (iframeDoc) {
            const svgData = new XMLSerializer().serializeToString(iframeDoc.documentElement);
            const svgBlob = new Blob(
              [`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
                <foreignObject width="100%" height="100%">
                  <div xmlns="http://www.w3.org/1999/xhtml">${svgData}</div>
                </foreignObject>
              </svg>`],
              { type: 'image/svg+xml;charset=utf-8' }
            );
            const url = URL.createObjectURL(svgBlob);
            const img = new Image();
            await new Promise<void>((resolve) => {
              img.onload = () => { compCtx.drawImage(img, 0, 0, w, h); URL.revokeObjectURL(url); resolve(); };
              img.onerror = () => { URL.revokeObjectURL(url); resolve(); };
              img.src = url;
            });
          }
        } catch {
          // Both methods failed — canvas stays white
        }
      }

      // Draw annotation strokes on top
      compCtx.drawImage(canvas, 0, 0);

      // Resize to max 1200px width to reduce base64 size for API
      const MAX_W = 1200;
      let finalCanvas = composite;
      if (w > MAX_W) {
        const ratio = MAX_W / w;
        const rw = Math.round(w * ratio);
        const rh = Math.round(h * ratio);
        const resized = document.createElement('canvas');
        resized.width = rw;
        resized.height = rh;
        const rCtx = resized.getContext('2d')!;
        rCtx.drawImage(composite, 0, 0, rw, rh);
        finalCanvas = resized;
      }
      const base64 = finalCanvas.toDataURL('image/png').split(',')[1];
      const editor = document.getElementById('detail-editor') as HTMLTextAreaElement;

      console.log('[Annotate] Composite done, base64 length:', base64.length);

      // Silently attach to AI panel — will be included when user sends next message
      const aiPanel = document.getElementById('ai-panel')!;
      aiPanel.dataset.annotationImage = base64;
      aiPanel.dataset.annotationCode = editor?.value || '';
      aiPanel.dataset.annotationFile = this.editingPath || this.liveServerUrl || 'unknown';

      this.showAnnotationAttached(base64);
    } catch (err: any) {
      console.error('Annotation capture failed:', err);
    }
  }

  private showAnnotationAttached(base64?: string) {
    // Add a visual indicator above the AI input showing the attachment
    let indicator = document.getElementById('annotation-indicator');
    if (!indicator) {
      indicator = document.createElement('div');
      indicator.id = 'annotation-indicator';
      indicator.style.cssText = `
        display: flex; align-items: center; gap: 8px;
        padding: 6px 12px; background: rgba(34,197,94,0.15);
        border: 1px solid rgba(34,197,94,0.3); border-radius: 6px;
        margin: 6px 12px 0; font-size: 12px; color: #4ade80;
      `;
      const inputRow = document.getElementById('ai-input-row')!;
      inputRow.parentElement!.insertBefore(indicator, inputRow);
    }
    const filePath = this.editingPath || this.liveServerUrl || 'unknown';
    const displayName = this.liveServerUrl && !this.editingPath ? this.liveServerUrl : filePath.split(/[\\/]/).pop();
    const thumbHtml = base64
      ? `<img src="data:image/png;base64,${base64}" style="height:40px;border-radius:4px;border:1px solid rgba(255,255,255,0.2);flex-shrink:0" />`
      : '';
    const label = this.lang === 'zh' ? '\u5df2\u9644\u52a0\u6807\u6ce8\u622a\u56fe' : 'Annotation attached';
    indicator.innerHTML = `
      ${thumbHtml}
      <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">\ud83d\udcce ${label} \u2014 ${displayName}</span>
      <button id="remove-annotation" style="background:none;border:none;color:#f87171;cursor:pointer;font-size:14px;flex-shrink:0" title="Remove">✕</button>
    `;
    indicator.style.display = 'flex';
    document.getElementById('remove-annotation')!.addEventListener('click', () => {
      this.removeAnnotation();
    });
  }

  private removeAnnotation() {
    const aiPanel = document.getElementById('ai-panel')!;
    delete aiPanel.dataset.annotationImage;
    delete aiPanel.dataset.annotationCode;
    delete aiPanel.dataset.annotationFile;
    const indicator = document.getElementById('annotation-indicator');
    if (indicator) indicator.style.display = 'none';
    const aiInput = document.getElementById('ai-input') as HTMLTextAreaElement;
    aiInput.value = '';
  }

  private static PREVIEW_EXTS = new Set(['html', 'htm', 'svg', 'css', 'scss', 'less', 'js', 'jsx', 'ts', 'tsx', 'vue', 'svelte', 'md', 'markdown']);

  private isPreviewable(name: string): boolean {
    const ext = name.split('.').pop()?.toLowerCase() || '';
    return WorkflowCanvas.PREVIEW_EXTS.has(ext);
  }

  private buildPreviewHtml(content: string, ext: string, filePath: string): string {
    // Resolve the base directory for relative resource paths
    const baseDir = filePath.replace(/\\/g, '/').replace(/\/[^/]+$/, '/');
    const baseTag = `<base href="file:///${baseDir}">`;

    if (ext === 'html' || ext === 'htm') {
      // Inject <base> so relative paths (images, css, js) resolve correctly
      if (content.includes('<head>')) {
        return content.replace('<head>', `<head>${baseTag}`);
      } else if (content.includes('<html>')) {
        return content.replace('<html>', `<html><head>${baseTag}</head>`);
      }
      return `<html><head>${baseTag}</head><body>${content}</body></html>`;
    }

    if (ext === 'svg') {
      return `<html><head>${baseTag}<style>body{margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#f0f0f0}</style></head><body>${content}</body></html>`;
    }

    if (ext === 'css' || ext === 'scss' || ext === 'less') {
      return `<html><head>${baseTag}<style>${content}</style></head><body>
        <div style="padding:24px;font-family:system-ui">
          <h1>CSS Preview</h1>
          <p>This is a paragraph to demonstrate styling.</p>
          <button>Button</button>
          <input type="text" placeholder="Input field" />
          <div class="container"><div class="box">Box 1</div><div class="box">Box 2</div><div class="box">Box 3</div></div>
          <ul><li>List item 1</li><li>List item 2</li><li>List item 3</li></ul>
          <a href="#">Link example</a>
        </div></body></html>`;
    }

    if (ext === 'md' || ext === 'markdown') {
      // Simple markdown rendering
      const html = content
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/^### (.+)$/gm, '<h3>$1</h3>')
        .replace(/^## (.+)$/gm, '<h2>$1</h2>')
        .replace(/^# (.+)$/gm, '<h1>$1</h1>')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g, '<em>$1</em>')
        .replace(/`(.+?)`/g, '<code style="background:#e0e0e0;padding:1px 4px;border-radius:3px">$1</code>')
        .replace(/^- (.+)$/gm, '<li>$1</li>')
        .replace(/\n\n/g, '<br><br>')
        .replace(/\n/g, '<br>');
      return `<html><head><style>body{padding:24px;font-family:system-ui;line-height:1.6;max-width:800px;margin:0 auto}code{background:#f0f0f0;padding:1px 4px;border-radius:3px}h1,h2,h3{margin-top:16px}</style></head><body>${html}</body></html>`;
    }

    // JS/TS/JSX/TSX — show a placeholder with console output capture
    return `<html><head>${baseTag}<style>
      body{margin:0;padding:16px;font-family:monospace;font-size:13px;background:#1e1e2e;color:#cdd6f4}
      #console{white-space:pre-wrap;word-break:break-all}
      .log{color:#a6e3a1}.err{color:#f38ba8}.warn{color:#f9e2af}
    </style></head><body>
    <div style="color:#6c7086;margin-bottom:8px">// Console Output</div>
    <div id="console"></div>
    <script>
      const c=document.getElementById('console');
      const orig={log:console.log,error:console.error,warn:console.warn};
      function append(cls,args){const d=document.createElement('div');d.className=cls;d.textContent=[...args].map(a=>typeof a==='object'?JSON.stringify(a,null,2):String(a)).join(' ');c.appendChild(d)}
      console.log=(...a)=>{orig.log(...a);append('log',a)};
      console.error=(...a)=>{orig.error(...a);append('err',a)};
      console.warn=(...a)=>{orig.warn(...a);append('warn',a)};
      try{${content}}catch(e){console.error(e.message)}
    </script></body></html>`;
  }

  private updatePreview(content: string, ext: string, filePath: string) {
    const previewPane = document.getElementById('preview-pane')!;
    const frame = document.getElementById('preview-frame') as HTMLIFrameElement;
    const panel = document.getElementById('detail-panel')!;

    if (this.isPreviewable(filePath.split('.').pop()?.toLowerCase() || '')) {
      previewPane.classList.remove('hidden');
      panel.classList.add('has-preview');
      const html = this.buildPreviewHtml(content, ext, filePath);
      frame.srcdoc = html;
    } else {
      previewPane.classList.add('hidden');
      panel.classList.remove('has-preview');
      frame.srcdoc = '';
    }
  }

  private async showDetail(id: string) {
    const node = this.nodes.get(id);
    if (!node || node.isDir) return;

    const panel = document.getElementById('detail-panel')!;
    const title = document.getElementById('detail-title')!;
    const editor = document.getElementById('detail-editor') as HTMLTextAreaElement;
    const binary = document.getElementById('detail-binary')!;
    const saveBtn = document.getElementById('detail-save')!;
    const modLabel = document.getElementById('detail-modified')!;
    const previewPane = document.getElementById('preview-pane')!;

    const ext = node.name.split('.').pop()?.toLowerCase() || '';
    title.textContent = `${node.name} — ${node.path}`;
    panel.classList.remove('hidden');
    this.editingPath = node.path;
    this.isModified = false;
    saveBtn.classList.add('hidden');
    modLabel.classList.add('hidden');

    // Reset preview and clear old annotation
    previewPane.classList.add('hidden');
    panel.classList.remove('has-preview');
    this.removeAnnotation();
    this.annotating = false;
    document.getElementById('preview-annotate')?.classList.remove('active');
    document.getElementById('annotate-canvas')?.classList.add('hidden');
    document.getElementById('annotate-clear')?.classList.add('hidden');
    const lbl = document.getElementById('annotate-label');
    if (lbl) lbl.textContent = WorkflowCanvas.i18n[this.lang]?.annotate || 'Edit';

    if (!this.isTextFile(node.name)) {
      editor.style.display = 'none';
      binary.className = 'show';
      binary.innerHTML = `<div style="font-size:32px;margin-bottom:12px">📦</div>
        <div>Binary file (.${ext})</div>
        <div style="margin-top:4px;font-size:11px">This file type cannot be previewed as text.</div>`;
      return;
    }

    editor.style.display = '';
    binary.className = '';
    editor.value = 'Loading...';
    editor.readOnly = true;

    try {
      const result = await window.xpro.readFile(node.path);
      if (result.ok && result.data != null) {
        const sample = result.data.slice(0, 1000);
        let nullCount = 0;
        for (let i = 0; i < sample.length; i++) {
          const code = sample.charCodeAt(i);
          if (code === 0 || (code < 32 && code !== 9 && code !== 10 && code !== 13)) nullCount++;
        }
        if (nullCount > sample.length * 0.1) {
          editor.style.display = 'none';
          binary.className = 'show';
          binary.innerHTML = `<div style="font-size:32px;margin-bottom:12px">⚠️</div><div>Binary content detected</div>`;
        } else {
          this.originalContent = result.data;
          editor.value = result.data;
          editor.readOnly = false;
          editor.setSelectionRange(0, 0);
          editor.scrollTop = 0;

          // Show preview for frontend files
          if (this.isPreviewable(node.name)) {
            this.updatePreview(result.data, ext, node.path);
          }
        }
      } else {
        editor.value = `Error: ${result.error || 'Cannot read file'}`;
      }
    } catch (err: any) {
      editor.value = `Error: ${err.message || err}`;
    }
  }

  private markModified() {
    if (this.isModified) return;
    this.isModified = true;
    document.getElementById('detail-save')!.classList.remove('hidden');
    document.getElementById('detail-modified')!.classList.remove('hidden');
  }

  private async saveCurrentFile() {
    if (!this.editingPath || !this.isModified) return;
    const editor = document.getElementById('detail-editor') as HTMLTextAreaElement;
    const content = editor.value;
    const result = await window.xpro.writeFile(this.editingPath, content);
    if (result.ok) {
      this.originalContent = content;
      this.isModified = false;
      document.getElementById('detail-save')!.classList.add('hidden');
      document.getElementById('detail-modified')!.classList.add('hidden');
      this.refreshLivePreview();
    } else {
      alert(`Save failed: ${result.error}`);
    }
  }

  /* ========== 适应视图 ========== */
  fitView() {
    const allNodes = Array.from(this.nodes.values());
    if (allNodes.length === 0) return;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of allNodes) {
      if (n.el && n.el.style.display === 'none') continue;
      const w = n.isDir ? DIR_NODE_W : NODE_W;
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + w);
      maxY = Math.max(maxY, n.y + NODE_H);
    }

    const padding = 60;
    const contentW = maxX - minX + padding * 2;
    const contentH = maxY - minY + padding * 2;
    const vw = this.viewport.clientWidth;
    const vh = this.viewport.clientHeight;

    this.scale = Math.min(1, Math.min(vw / contentW, vh / contentH));
    this.panX = (vw - contentW * this.scale) / 2 - minX * this.scale + padding * this.scale;
    this.panY = (vh - contentH * this.scale) / 2 - minY * this.scale + padding * this.scale;

    this.applyTransform();
    document.getElementById('zoom-level')!.textContent = `${Math.round(this.scale * 100)}%`;
  }

  /* ========== Minimap ========== */
  private updateMinimap() {
    const minimapCanvas = document.getElementById('minimap-canvas') as HTMLCanvasElement;
    if (!minimapCanvas) return;
    const ctx = minimapCanvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    minimapCanvas.width = 180 * dpr;
    minimapCanvas.height = 120 * dpr;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, 180, 120);

    const allNodes = Array.from(this.nodes.values()).filter(n => n.el && n.el.style.display !== 'none');
    if (allNodes.length === 0) return;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of allNodes) {
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + NODE_W);
      maxY = Math.max(maxY, n.y + NODE_H);
    }

    const pad = 10;
    const rangeW = maxX - minX + pad * 2;
    const rangeH = maxY - minY + pad * 2;
    const s = Math.min(160 / rangeW, 100 / rangeH);
    const offX = (180 - rangeW * s) / 2;
    const offY = (120 - rangeH * s) / 2;

    // edges
    ctx.strokeStyle = 'rgba(71,85,105,0.5)';
    ctx.lineWidth = 0.5;
    for (const edge of this.edges) {
      const from = this.nodes.get(edge.from);
      const to = this.nodes.get(edge.to);
      if (!from || !to) continue;
      ctx.beginPath();
      ctx.moveTo(offX + (from.x - minX + pad) * s, offY + (from.y - minY + pad) * s);
      ctx.lineTo(offX + (to.x - minX + pad) * s, offY + (to.y - minY + pad) * s);
      ctx.stroke();
    }

    // nodes
    for (const n of allNodes) {
      ctx.fillStyle = this.getTypeColor(n.name, n.isDir);
      ctx.globalAlpha = 0.8;
      const nx = offX + (n.x - minX + pad) * s;
      const ny = offY + (n.y - minY + pad) * s;
      const nw = Math.max(3, NODE_W * s * 0.8);
      const nh = Math.max(2, NODE_H * s * 0.6);
      ctx.fillRect(nx, ny, nw, nh);
    }
    ctx.globalAlpha = 1;
  }

  /* ========== File type colors ========== */
  private getTypeColor(name: string, isDir: boolean): string {
    if (isDir) return '#2563eb';
    const ext = name.split('.').pop()?.toLowerCase() || '';
    const colors: Record<string, string> = {
      ts: '#3178c6', tsx: '#3178c6', js: '#f7df1e', jsx: '#f7df1e', mjs: '#f7df1e',
      py: '#3572a5', pyw: '#3572a5',
      html: '#e44d26', htm: '#e44d26',
      css: '#264de4', scss: '#cd6799', less: '#1d365d', sass: '#cd6799',
      json: '#a8b9cc', json5: '#a8b9cc',
      md: '#519aba', markdown: '#519aba', txt: '#519aba',
      rs: '#dea584', go: '#00add8', java: '#b07219', kt: '#a97bff',
      c: '#555555', cpp: '#f34b7d', h: '#555555', hpp: '#f34b7d',
      cs: '#178600', swift: '#ffac45', rb: '#cc342d',
      sh: '#89e051', bash: '#89e051', bat: '#c1f12e', ps1: '#012456',
      yaml: '#cb171e', yml: '#cb171e', toml: '#9c4121',
      sql: '#e38c00', graphql: '#e535ab',
      vue: '#41b883', svelte: '#ff3e00', astro: '#ff5d01',
      png: '#a855f7', jpg: '#a855f7', jpeg: '#a855f7', gif: '#a855f7', svg: '#a855f7', ico: '#a855f7', webp: '#a855f7',
      lock: '#6b7280', gitignore: '#6b7280', env: '#6b7280', editorconfig: '#6b7280',
      dockerfile: '#384d54', makefile: '#427819',
    };
    return colors[ext] || '#64748b';
  }

  private getTypeCategory(name: string, isDir: boolean): string {
    if (isDir) return 'dir';
    const ext = name.split('.').pop()?.toLowerCase() || '';
    if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'].includes(ext)) return 'js';
    if (['py', 'pyw'].includes(ext)) return 'py';
    if (['css', 'scss', 'less', 'sass'].includes(ext)) return 'style';
    if (['md', 'markdown', 'txt', 'text', 'log', 'readme', 'license'].includes(ext)) return 'doc';
    return 'other';
  }

  /* ========== Helpers ========== */
  private getIcon(node: WfNode): string {
    if (node.isDir) return '📁';
    const ext = node.name.split('.').pop()?.toLowerCase() || '';
    const icons: Record<string, string> = {
      ts: '🟦', tsx: '🟦', js: '🟨', jsx: '🟨', mjs: '🟨',
      json: '📋', json5: '📋',
      html: '🌐', htm: '🌐', xml: '📰',
      css: '🎨', scss: '🎨', less: '🎨', sass: '🎨',
      rs: '🦀', py: '🐍', rb: '💎', go: '🔵',
      java: '☕', kt: '🟣', swift: '🍎',
      c: '⚙️', cpp: '⚙️', h: '⚙️', hpp: '⚙️',
      cs: '🟢', md: '📝', txt: '📄',
      toml: '🔧', yaml: '🔧', yml: '🔧', ini: '🔧', cfg: '🔧',
      lock: '🔒', gitignore: '👁', env: '�',
      png: '🖼️', jpg: '🖼️', jpeg: '🖼️', gif: '🖼️', svg: '🎭', ico: '🖼️', webp: '🖼️',
      sh: '🐚', bash: '🐚', bat: '🖥️', ps1: '🖥️',
      sql: '🗃️', graphql: '🔗',
      vue: '💚', svelte: '🧡', astro: '🚀',
      dockerfile: '🐋', makefile: '🏗️',
    };
    return icons[ext] || '📄';
  }

  /* ========== Approval Bar UI ========== */
  private updateApprovalBar() {
    const bar = document.getElementById('approval-bar')!;
    const pending = ApprovalService.getPending();
    if (pending.length === 0) {
      bar.classList.add('hidden');
      return;
    }
    bar.classList.remove('hidden');
    const text = document.getElementById('approval-text')!;
    text.textContent = this.lang === 'zh'
      ? `${pending.length} 个待审批变更`
      : `${pending.length} pending change${pending.length > 1 ? 's' : ''}`;
  }

  /* ========== Diff Modal ========== */
  private showDiffModal() {
    const modal = document.getElementById('diff-modal')!;
    const body = document.getElementById('diff-body')!;
    const pending = ApprovalService.getPending();

    if (pending.length === 0) {
      body.innerHTML = `<div style="text-align:center;color:var(--node-text-dim);padding:20px">${this.lang === 'zh' ? '没有待审批的变更' : 'No pending changes'}</div>`;
    } else {
      body.innerHTML = pending.map(change => {
        const fileName = change.path.split(/[\\/]/).pop() || change.path;
        const diff = ApprovalService.computeCompactDiff(change.oldContent, change.newContent);
        const diffHtml = diff.map(d =>
          `<div class="diff-line ${d.type}">${this.escHtml(d.content)}</div>`
        ).join('');
        return `
          <div class="diff-file-header">${this.escHtml(fileName)} <span style="color:var(--node-text-dim);font-weight:normal;font-size:11px">(${change.toolName})</span></div>
          <div style="margin-bottom:12px">${diffHtml || '<div style="color:var(--node-text-dim);font-size:11px;padding:4px 8px">No visible changes</div>'}</div>
          <div style="display:flex;gap:6px;margin-bottom:16px">
            <button class="approval-btn approve" onclick="document.dispatchEvent(new CustomEvent('approve-change', {detail:'${change.id}'}))">✓ Accept</button>
            <button class="approval-btn reject" onclick="document.dispatchEvent(new CustomEvent('reject-change', {detail:'${change.id}'}))">✗ Reject</button>
          </div>
        `;
      }).join('');
    }

    modal.classList.remove('hidden');

    // Listen for individual approve/reject
    const onApprove = async (e: any) => {
      await ApprovalService.approve(e.detail);
      this.showDiffModal(); // refresh
    };
    const onReject = (e: any) => {
      ApprovalService.reject(e.detail);
      this.showDiffModal();
    };
    document.removeEventListener('approve-change', onApprove);
    document.removeEventListener('reject-change', onReject);
    document.addEventListener('approve-change', onApprove);
    document.addEventListener('reject-change', onReject);
  }

  /* ========== Lint Bar UI ========== */
  private updateLintBar(results: any[]) {
    const bar = document.getElementById('lint-bar')!;
    const status = document.getElementById('lint-status')!;
    if (!results || results.length === 0) {
      bar.classList.add('hidden');
      return;
    }
    bar.classList.remove('hidden');
    bar.classList.remove('lint-ok', 'lint-warn', 'lint-error');

    const errors = results.reduce((s: number, r: any) => s + r.issues.filter((i: any) => i.severity === 'error').length, 0);
    const warnings = results.reduce((s: number, r: any) => s + r.issues.filter((i: any) => i.severity === 'warning').length, 0);

    if (errors > 0) {
      bar.classList.add('lint-error');
      status.textContent = `${errors} error${errors > 1 ? 's' : ''}${warnings > 0 ? `, ${warnings} warning${warnings > 1 ? 's' : ''}` : ''}`;
    } else if (warnings > 0) {
      bar.classList.add('lint-warn');
      status.textContent = `${warnings} warning${warnings > 1 ? 's' : ''}`;
    } else {
      bar.classList.add('lint-ok');
      status.textContent = this.lang === 'zh' ? '✓ 无 lint 问题' : '✓ No lint issues';
    }
  }

}
