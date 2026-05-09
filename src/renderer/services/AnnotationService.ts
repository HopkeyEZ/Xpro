/**
 * AnnotationService — 标注截图捕获与管理
 */

export interface AnnotationData {
  image: string;   // base64 PNG
  code: string;    // 源代码（如果是文件编辑模式）
  file: string;    // 文件路径或 live URL
}

class AnnotationServiceClass {
  private data: AnnotationData | null = null;
  private listeners: Array<(data: AnnotationData | null) => void> = [];

  /** 捕获标注截图 */
  async capture(container: HTMLElement, annotateCanvas: HTMLCanvasElement, code: string, filePath: string): Promise<AnnotationData | null> {
    try {
      const w = container.clientWidth;
      const h = container.clientHeight;

      const composite = document.createElement('canvas');
      composite.width = w;
      composite.height = h;
      const compCtx = composite.getContext('2d')!;
      compCtx.fillStyle = '#fff';
      compCtx.fillRect(0, 0, w, h);

      // Capture full window screenshot, then crop to container region
      const rect = container.getBoundingClientRect();
      let captured = false;

      try {
        const result = await (window as any).xpro.captureRect({ x: 0, y: 0, width: 0, height: 0 });
        if (result.ok && result.data && result.data.length > 100) {
          const fullImg = new Image();
          await new Promise<void>((resolve) => {
            fullImg.onload = () => {
              const scaleX = result.imgWidth / result.contentWidth;
              const scaleY = result.imgHeight / result.contentHeight;
              const sx = Math.round(rect.left * scaleX);
              const sy = Math.round(rect.top * scaleY);
              const sw = Math.round(rect.width * scaleX);
              const sh = Math.round(rect.height * scaleY);
              compCtx.drawImage(fullImg, sx, sy, sw, sh, 0, 0, w, h);
              resolve();
            };
            fullImg.onerror = () => resolve();
            fullImg.src = `data:image/png;base64,${result.data}`;
          });
          captured = true;
        }
      } catch (e) {
        console.warn('[Annotation] Native capture failed:', e);
      }

      // Fallback: DOM serialization
      if (!captured) {
        try {
          const frame = container.querySelector('iframe') as HTMLIFrameElement;
          const iframeDoc = frame?.contentDocument || frame?.contentWindow?.document;
          if (iframeDoc) {
            const html = new XMLSerializer().serializeToString(iframeDoc);
            const blob = new Blob([html], { type: 'text/html' });
            const url = URL.createObjectURL(blob);
            const fallbackImg = new Image();
            await new Promise<void>((resolve) => {
              fallbackImg.onload = () => { compCtx.drawImage(fallbackImg, 0, 0, w, h); resolve(); };
              fallbackImg.onerror = () => resolve();
              fallbackImg.src = url;
            });
            URL.revokeObjectURL(url);
            captured = true;
          }
        } catch { /* ignore */ }
      }

      // Draw annotation strokes on top
      compCtx.drawImage(annotateCanvas, 0, 0);

      // Resize to max 1200px
      const MAX_W = 1200;
      let finalCanvas = composite;
      if (w > MAX_W) {
        const ratio = MAX_W / w;
        const rw = Math.round(w * ratio);
        const rh = Math.round(h * ratio);
        const resized = document.createElement('canvas');
        resized.width = rw;
        resized.height = rh;
        resized.getContext('2d')!.drawImage(composite, 0, 0, rw, rh);
        finalCanvas = resized;
      }

      const base64 = finalCanvas.toDataURL('image/png').split(',')[1];
      this.data = { image: base64, code, file: filePath };
      this.notify();
      return this.data;
    } catch (err) {
      console.error('[Annotation] Capture failed:', err);
      return null;
    }
  }

  /** 获取当前标注数据 */
  getData(): AnnotationData | null {
    return this.data;
  }

  /** 清除标注 */
  clear() {
    this.data = null;
    this.notify();
  }

  /** 是否有标注 */
  hasAnnotation(): boolean {
    return this.data !== null;
  }

  subscribe(fn: (data: AnnotationData | null) => void) {
    this.listeners.push(fn);
    return () => { this.listeners = this.listeners.filter(l => l !== fn); };
  }

  private notify() {
    this.listeners.forEach(fn => fn(this.data));
  }
}

export const AnnotationService = new AnnotationServiceClass();
