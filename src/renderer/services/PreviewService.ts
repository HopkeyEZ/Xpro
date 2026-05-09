/**
 * PreviewService — 管理 Live Preview 和文件预览
 */

class PreviewServiceClass {
  private liveServerUrl: string | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private listeners: Array<(url: string | null) => void> = [];

  /** 设置 Live Server URL */
  setLiveUrl(url: string | null) {
    this.liveServerUrl = url;
    this.notify();
  }

  /** 获取当前 Live URL */
  getLiveUrl(): string | null {
    return this.liveServerUrl;
  }

  /** 是否有活跃的 Live Server */
  isLive(): boolean {
    return this.liveServerUrl !== null;
  }

  /** 刷新预览 */
  refresh(frame: HTMLIFrameElement) {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      if (frame && this.liveServerUrl) {
        frame.src = this.liveServerUrl;
      }
    }, 500);
  }

  /** 导航到 URL */
  navigate(frame: HTMLIFrameElement, url: string) {
    frame.src = url;
    this.liveServerUrl = url;
    this.notify();
  }

  /** 更新预览内容（静态文件模式） */
  updatePreviewContent(frame: HTMLIFrameElement, content: string, ext: string, filePath: string) {
    const htmlExts = ['html', 'htm'];
    const mdExts = ['md', 'markdown'];

    if (htmlExts.includes(ext)) {
      const blob = new Blob([content], { type: 'text/html' });
      frame.src = URL.createObjectURL(blob);
    } else if (mdExts.includes(ext)) {
      const htmlContent = this.renderMarkdown(content);
      const blob = new Blob([htmlContent], { type: 'text/html' });
      frame.src = URL.createObjectURL(blob);
    } else {
      const htmlContent = `<html><body><pre style="margin:20px;font-family:monospace;white-space:pre-wrap">${this.escapeHtml(content)}</pre></body></html>`;
      const blob = new Blob([htmlContent], { type: 'text/html' });
      frame.src = URL.createObjectURL(blob);
    }
  }

  private renderMarkdown(md: string): string {
    // Simple markdown rendering
    let html = md
      .replace(/^### (.+)$/gm, '<h3>$1</h3>')
      .replace(/^## (.+)$/gm, '<h2>$1</h2>')
      .replace(/^# (.+)$/gm, '<h1>$1</h1>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/`(.+?)`/g, '<code>$1</code>')
      .replace(/\n/g, '<br>');
    return `<html><body style="margin:20px;font-family:system-ui;line-height:1.6">${html}</body></html>`;
  }

  private escapeHtml(str: string): string {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  subscribe(fn: (url: string | null) => void) {
    this.listeners.push(fn);
    return () => { this.listeners = this.listeners.filter(l => l !== fn); };
  }

  private notify() {
    this.listeners.forEach(fn => fn(this.liveServerUrl));
  }
}

export const PreviewService = new PreviewServiceClass();
