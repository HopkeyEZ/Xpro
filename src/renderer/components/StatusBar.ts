import type { EditorInstance } from './Editor';

export function initStatusBar(editor: EditorInstance): void {
  const langEl = document.getElementById('status-lang')!;
  const cursorEl = document.getElementById('status-cursor')!;

  editor.monacoEditor.onDidChangeCursorPosition((e) => {
    cursorEl.textContent = `Ln ${e.position.lineNumber}, Col ${e.position.column}`;
  });

  setInterval(() => {
    const tab = editor.getActiveTab();
    if (tab) {
      const langNames: Record<string, string> = {
        rust: 'Rust', python: 'Python', javascript: 'JavaScript', typescript: 'TypeScript',
        java: 'Java', c: 'C', cpp: 'C++', go: 'Go', html: 'HTML', css: 'CSS',
        json: 'JSON', toml: 'TOML', yaml: 'YAML', markdown: 'Markdown', sql: 'SQL',
        shell: 'Shell Script', plaintext: 'Plain Text',
      };
      langEl.textContent = langNames[tab.language] ?? tab.language;
    }
  }, 500);
}
