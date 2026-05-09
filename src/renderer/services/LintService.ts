/**
 * LintService — AI 修改文件后自动运行 lint 检测
 * 支持 ESLint、TypeScript、Python 等常见工具
 */

export interface LintIssue {
  file: string;
  line: number;
  column: number;
  severity: 'error' | 'warning';
  message: string;
  rule?: string;
}

export interface LintResult {
  file: string;
  issues: LintIssue[];
  passed: boolean;
}

class LintServiceClass {
  private projectRoot: string = '';
  private enabled = true;
  private lastResults: LintResult[] = [];
  private listeners: Array<(results: LintResult[]) => void> = [];

  setProjectRoot(root: string) {
    this.projectRoot = root;
  }

  setEnabled(enabled: boolean) {
    this.enabled = enabled;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** 支持的文件扩展名 */
  private isSupportedExt(filePath: string): boolean {
    const ext = filePath.split('.').pop()?.toLowerCase() || '';
    return ['ts', 'tsx', 'js', 'jsx', 'py', 'css', 'scss', 'html', 'json'].includes(ext);
  }

  /** 对单个文件运行内置 lint 检查（读取文件内容并分析） */
  async lintFile(filePath: string): Promise<LintResult | null> {
    if (!this.enabled) return null;
    if (!this.isSupportedExt(filePath)) return null;

    try {
      const result = await (window as any).xpro.readFile(filePath);
      if (!result.ok || !result.data) return null;

      const issues = this.analyzeContent(filePath, result.data);
      const lintResult: LintResult = {
        file: filePath,
        issues,
        passed: issues.filter(i => i.severity === 'error').length === 0,
      };
      this.updateResults(lintResult);
      return lintResult;
    } catch (e) {
      console.warn('[Lint] Failed to lint:', filePath, e);
      return null;
    }
  }

  /** 内置轻量代码分析 */
  private analyzeContent(filePath: string, content: string): LintIssue[] {
    const ext = filePath.split('.').pop()?.toLowerCase() || '';
    const issues: LintIssue[] = [];
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      // JSON: syntax check
      if (ext === 'json' && i === 0) {
        try { JSON.parse(content); } catch (e: any) {
          issues.push({ file: filePath, line: 1, column: 1, severity: 'error', message: `Invalid JSON: ${e.message}`, rule: 'json-parse' });
        }
        break;
      }

      // console.log warnings (JS/TS)
      if (['ts', 'tsx', 'js', 'jsx'].includes(ext)) {
        if (/\bconsole\.(log|debug)\b/.test(line)) {
          issues.push({ file: filePath, line: lineNum, column: line.indexOf('console') + 1, severity: 'warning', message: 'Unexpected console statement', rule: 'no-console' });
        }
        // TODO/FIXME comments
        if (/\/\/\s*(TODO|FIXME|HACK|XXX)\b/i.test(line)) {
          const m = line.match(/\/\/\s*(TODO|FIXME|HACK|XXX)/i);
          issues.push({ file: filePath, line: lineNum, column: (m?.index || 0) + 1, severity: 'warning', message: `${m?.[1]} comment found`, rule: 'no-todo' });
        }
      }

      // Trailing whitespace
      if (line.length > 0 && line !== lines[lines.length - 1] && /\s+$/.test(line)) {
        issues.push({ file: filePath, line: lineNum, column: line.trimEnd().length + 1, severity: 'warning', message: 'Trailing whitespace', rule: 'no-trailing-spaces' });
      }

      // Very long lines
      if (line.length > 300) {
        issues.push({ file: filePath, line: lineNum, column: 300, severity: 'warning', message: `Line too long (${line.length} chars)`, rule: 'max-line-length' });
      }
    }

    return issues;
  }

  /** 对多个文件批量 lint */
  async lintFiles(filePaths: string[]): Promise<LintResult[]> {
    const results: LintResult[] = [];
    for (const fp of filePaths) {
      const r = await this.lintFile(fp);
      if (r) results.push(r);
    }
    return results;
  }

  /** 解析 ESLint JSON 输出 */
  private parseOutput(filePath: string, output: string): LintIssue[] {
    const issues: LintIssue[] = [];
    try {
      // Try ESLint JSON format
      const trimmed = output.trim();
      if (!trimmed || trimmed === '[]') return [];

      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        for (const file of parsed) {
          const messages = file.messages || [];
          for (const msg of messages) {
            issues.push({
              file: filePath,
              line: msg.line || 1,
              column: msg.column || 1,
              severity: msg.severity === 2 ? 'error' : 'warning',
              message: msg.message || '',
              rule: msg.ruleId || undefined,
            });
          }
        }
      }
    } catch {
      // Fallback: parse line-based output
      const lines = output.split('\n');
      for (const line of lines) {
        const match = line.match(/(\d+):(\d+)\s+(error|warning)\s+(.+?)(?:\s+(\S+))?$/);
        if (match) {
          issues.push({
            file: filePath,
            line: parseInt(match[1]),
            column: parseInt(match[2]),
            severity: match[3] as 'error' | 'warning',
            message: match[4],
            rule: match[5],
          });
        }
      }
    }
    return issues;
  }

  /** 获取最近的 lint 结果 */
  getResults(): LintResult[] {
    return [...this.lastResults];
  }

  /** 获取文件的错误数 */
  getErrorCount(filePath?: string): number {
    const results = filePath
      ? this.lastResults.filter(r => r.file === filePath)
      : this.lastResults;
    return results.reduce((sum, r) => sum + r.issues.filter(i => i.severity === 'error').length, 0);
  }

  /** 格式化 lint 结果为文本摘要 */
  formatSummary(results: LintResult[]): string {
    const errors = results.reduce((sum, r) => sum + r.issues.filter(i => i.severity === 'error').length, 0);
    const warnings = results.reduce((sum, r) => sum + r.issues.filter(i => i.severity === 'warning').length, 0);

    if (errors === 0 && warnings === 0) return '✓ No lint issues';
    const parts: string[] = [];
    if (errors > 0) parts.push(`${errors} error${errors > 1 ? 's' : ''}`);
    if (warnings > 0) parts.push(`${warnings} warning${warnings > 1 ? 's' : ''}`);
    return `⚠ ${parts.join(', ')}`;
  }

  subscribe(fn: (results: LintResult[]) => void) {
    this.listeners.push(fn);
    return () => { this.listeners = this.listeners.filter(l => l !== fn); };
  }

  private updateResults(result: LintResult) {
    const idx = this.lastResults.findIndex(r => r.file === result.file);
    if (idx >= 0) this.lastResults[idx] = result;
    else this.lastResults.push(result);
    this.listeners.forEach(fn => fn(this.lastResults));
  }
}

export const LintService = new LintServiceClass();
