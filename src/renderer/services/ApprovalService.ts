/**
 * ApprovalService — AI 修改代码的审批状态机
 * 支持 diff 预览、逐个 accept/reject、批量操作
 */

export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

export interface FileChange {
  id: string;
  path: string;
  oldContent: string;
  newContent: string;
  status: ApprovalStatus;
  timestamp: number;
  toolName: string; // write_file | edit_file
  description: string;
}

export interface DiffLine {
  type: 'add' | 'remove' | 'context';
  lineNumber: number;
  content: string;
}

class ApprovalServiceClass {
  private pendingChanges: FileChange[] = [];
  private history: FileChange[] = [];
  private enabled = true; // 是否启用审批（Agent 模式下可关闭）
  private listeners: Array<() => void> = [];

  /** 设置是否启用审批模式 */
  setEnabled(enabled: boolean) {
    this.enabled = enabled;
    this.notify();
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** 添加一个待审批的文件变更 */
  addChange(change: Omit<FileChange, 'id' | 'status' | 'timestamp'>): FileChange {
    const fc: FileChange = {
      ...change,
      id: `chg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      status: 'pending',
      timestamp: Date.now(),
    };
    this.pendingChanges.push(fc);
    this.notify();
    return fc;
  }

  /** 批准某个变更 — 实际写入文件 */
  async approve(changeId: string): Promise<boolean> {
    const change = this.pendingChanges.find(c => c.id === changeId);
    if (!change) return false;

    try {
      await (window as any).xpro.writeFile(change.path, change.newContent);
      change.status = 'approved';
      this.moveToHistory(changeId);
      this.notify();
      return true;
    } catch (e) {
      console.error('[Approval] Write failed:', e);
      return false;
    }
  }

  /** 拒绝某个变更 */
  reject(changeId: string) {
    const change = this.pendingChanges.find(c => c.id === changeId);
    if (!change) return;
    change.status = 'rejected';
    this.moveToHistory(changeId);
    this.notify();
  }

  /** 批准所有待审批变更 */
  async approveAll(): Promise<number> {
    let count = 0;
    const pending = [...this.pendingChanges];
    for (const change of pending) {
      if (await this.approve(change.id)) count++;
    }
    return count;
  }

  /** 拒绝所有 */
  rejectAll() {
    const pending = [...this.pendingChanges];
    for (const change of pending) {
      this.reject(change.id);
    }
  }

  /** 获取待审批列表 */
  getPending(): FileChange[] {
    return [...this.pendingChanges];
  }

  /** 获取历史记录 */
  getHistory(): FileChange[] {
    return [...this.history];
  }

  /** 计算简单 diff */
  computeDiff(oldContent: string, newContent: string): DiffLine[] {
    const oldLines = oldContent.split('\n');
    const newLines = newContent.split('\n');
    const diff: DiffLine[] = [];

    // 简单逐行比较 (非 LCS，适合小变更)
    const maxLen = Math.max(oldLines.length, newLines.length);
    let oi = 0, ni = 0;

    while (oi < oldLines.length || ni < newLines.length) {
      if (oi < oldLines.length && ni < newLines.length && oldLines[oi] === newLines[ni]) {
        diff.push({ type: 'context', lineNumber: ni + 1, content: newLines[ni] });
        oi++;
        ni++;
      } else if (oi < oldLines.length && (ni >= newLines.length || oldLines[oi] !== newLines[ni])) {
        diff.push({ type: 'remove', lineNumber: oi + 1, content: oldLines[oi] });
        oi++;
      } else {
        diff.push({ type: 'add', lineNumber: ni + 1, content: newLines[ni] });
        ni++;
      }
    }

    return diff;
  }

  /** 获取紧凑 diff（只显示变更区域 ± 3 行上下文） */
  computeCompactDiff(oldContent: string, newContent: string, contextLines = 3): DiffLine[] {
    const fullDiff = this.computeDiff(oldContent, newContent);
    const result: DiffLine[] = [];
    const changeIndices = fullDiff
      .map((d, i) => d.type !== 'context' ? i : -1)
      .filter(i => i >= 0);

    if (changeIndices.length === 0) return [];

    const included = new Set<number>();
    for (const idx of changeIndices) {
      for (let i = Math.max(0, idx - contextLines); i <= Math.min(fullDiff.length - 1, idx + contextLines); i++) {
        included.add(i);
      }
    }

    for (let i = 0; i < fullDiff.length; i++) {
      if (included.has(i)) result.push(fullDiff[i]);
    }
    return result;
  }

  /** 清除所有 */
  clear() {
    this.pendingChanges = [];
    this.history = [];
    this.notify();
  }

  subscribe(fn: () => void) {
    this.listeners.push(fn);
    return () => { this.listeners = this.listeners.filter(l => l !== fn); };
  }

  private moveToHistory(changeId: string) {
    const idx = this.pendingChanges.findIndex(c => c.id === changeId);
    if (idx >= 0) {
      this.history.push(this.pendingChanges[idx]);
      this.pendingChanges.splice(idx, 1);
    }
  }

  private notify() {
    this.listeners.forEach(fn => fn());
  }
}

export const ApprovalService = new ApprovalServiceClass();
