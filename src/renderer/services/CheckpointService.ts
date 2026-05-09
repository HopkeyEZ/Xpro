/**
 * CheckpointService — 记录 AI 对文件的每次修改，支持回滚
 * 每次 AI 调用 write_file 或 edit_file 时创建检查点
 */

export interface FileSnapshot {
  path: string;
  content: string;
  newContent?: string; // 修改后的内容（用于前进/redo）
  timestamp: number;
}

export interface Checkpoint {
  id: string;
  label: string;
  category?: string;         // AI 归类标签（如 "前端UI", "后端API", "样式" 等）
  timestamp: number;
  snapshots: FileSnapshot[]; // 修改前的文件快照
  applied: boolean;          // 是否已应用
}

class CheckpointServiceClass {
  private checkpoints: Checkpoint[] = [];
  private maxCheckpoints = 50;
  private listeners: Array<() => void> = [];
  private projectRoot: string = '';
  private saving = false;

  /** 设置项目根目录并加载已有检查点 */
  async setProjectRoot(root: string) {
    this.projectRoot = root;
    if (root) await this.load();
  }

  /** 在 AI 修改文件前调用，记录文件当前内容 */
  createCheckpoint(label: string, files: FileSnapshot[]): Checkpoint {
    const cp: Checkpoint = {
      id: `cp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      label,
      timestamp: Date.now(),
      snapshots: files,
      applied: true,
    };
    this.checkpoints.push(cp);
    // 限制总数
    if (this.checkpoints.length > this.maxCheckpoints) {
      this.checkpoints.shift();
    }
    this.notify();
    this.save();
    return cp;
  }

  /** 回滚到某个检查点 — 恢复修改前的文件内容 */
  async rollback(checkpointId: string): Promise<{ ok: boolean; restored: string[] }> {
    const idx = this.checkpoints.findIndex(c => c.id === checkpointId);
    if (idx === -1) return { ok: false, restored: [] };

    const cp = this.checkpoints[idx];
    const restored: string[] = [];

    for (const snap of cp.snapshots) {
      try {
        // 如果还没保存 newContent，先读取当前文件内容作为 newContent
        if (!snap.newContent) {
          const cur = await (window as any).xpro.readFile(snap.path);
          if (cur.ok && cur.data) snap.newContent = cur.data;
        }
        await (window as any).xpro.writeFile(snap.path, snap.content);
        restored.push(snap.path);
      } catch (e) {
        console.error('[Checkpoint] Failed to restore:', snap.path, e);
      }
    }

    // 标记此检查点及之后的为未应用
    for (let i = idx; i < this.checkpoints.length; i++) {
      this.checkpoints[i].applied = false;
    }

    this.notify();
    this.save();
    return { ok: true, restored };
  }

  /** 前进（redo）— 重新应用已回滚的检查点 */
  async redo(checkpointId: string): Promise<{ ok: boolean; restored: string[] }> {
    const idx = this.checkpoints.findIndex(c => c.id === checkpointId);
    if (idx === -1) return { ok: false, restored: [] };

    const cp = this.checkpoints[idx];
    if (cp.applied) return { ok: false, restored: [] }; // 已经是应用状态

    const restored: string[] = [];

    for (const snap of cp.snapshots) {
      if (!snap.newContent) continue;
      try {
        await (window as any).xpro.writeFile(snap.path, snap.newContent);
        restored.push(snap.path);
      } catch (e) {
        console.error('[Checkpoint] Failed to redo:', snap.path, e);
      }
    }

    // 标记此检查点及之前已回滚的为已应用
    for (let i = 0; i <= idx; i++) {
      this.checkpoints[i].applied = true;
    }

    this.notify();
    this.save();
    return { ok: true, restored };
  }

  /** 获取所有检查点（最新在后） */
  getAll(): Checkpoint[] {
    return [...this.checkpoints];
  }

  /** 获取最近 N 个检查点 */
  getRecent(n: number = 10): Checkpoint[] {
    return this.checkpoints.slice(-n);
  }

  /** 更新检查点标签 */
  updateLabel(checkpointId: string, label: string) {
    const cp = this.checkpoints.find(c => c.id === checkpointId);
    if (cp) {
      cp.label = label;
      this.notify();
      this.save();
    }
  }

  /** 批量更新分类 */
  updateCategories(mapping: Record<string, string>) {
    let changed = false;
    for (const [id, cat] of Object.entries(mapping)) {
      const cp = this.checkpoints.find(c => c.id === id);
      if (cp && cp.category !== cat) {
        cp.category = cat;
        changed = true;
      }
    }
    if (changed) {
      this.notify();
      this.save();
    }
  }

  /** 获取未分类的检查点 */
  getUncategorized(): Checkpoint[] {
    return this.checkpoints.filter(c => !c.category);
  }

  /** 删除单个检查点 */
  remove(checkpointId: string) {
    this.checkpoints = this.checkpoints.filter(c => c.id !== checkpointId);
    this.notify();
    this.save();
  }

  /** 清除所有检查点 */
  clear() {
    this.checkpoints = [];
    this.notify();
    this.save();
  }

  /** 订阅变更 */
  subscribe(fn: () => void) {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter(l => l !== fn);
    };
  }

  private notify() {
    this.listeners.forEach(fn => fn());
  }

  /** 持久化路径 */
  private get storagePath(): string {
    return this.projectRoot.replace(/\\/g, '/') + '/.xpro/checkpoints.json';
  }

  /** 保存到磁盘 */
  private async save() {
    if (!this.projectRoot || this.saving) return;
    this.saving = true;
    try {
      // 只保存最近的条目，避免文件过大
      const data = JSON.stringify(this.checkpoints.slice(-this.maxCheckpoints), null, 2);
      // 确保 .xpro 目录存在
      const dirPath = this.projectRoot.replace(/\\/g, '/') + '/.xpro';
      try { await (window as any).xpro.readDir(dirPath); } catch {
        // 目录不存在时 writeFile 会通过主进程 mkdir
      }
      await (window as any).xpro.writeFile(this.storagePath, data);
    } catch (e) {
      console.warn('[Checkpoint] Save failed:', e);
    } finally {
      this.saving = false;
    }
  }

  /** 从磁盘加载 */
  private async load() {
    if (!this.projectRoot) return;
    try {
      const result = await (window as any).xpro.readFile(this.storagePath);
      if (result.ok && result.data) {
        const parsed = JSON.parse(result.data);
        if (Array.isArray(parsed)) {
          this.checkpoints = parsed;
          console.log(`[Checkpoint] Loaded ${this.checkpoints.length} checkpoints from disk`);
          this.notify();
        }
      }
    } catch {
      // 文件不存在，首次使用
      this.checkpoints = [];
    }
  }
}

export const CheckpointService = new CheckpointServiceClass();
