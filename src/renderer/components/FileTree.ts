import type { EditorInstance } from './Editor';

interface TreeEntry {
  name: string;
  path: string;
  isDir: boolean;
  expanded?: boolean;
  children?: TreeEntry[];
  depth: number;
}

export interface FileTreeInstance {
  openFolder: (folderPath: string) => void;
}

export function initFileTree(editor: EditorInstance): FileTreeInstance {
  const treeEl = document.getElementById('file-tree')!;
  let rootPath = '';
  let rootEntries: TreeEntry[] = [];

  async function loadDir(dirPath: string, depth: number): Promise<TreeEntry[]> {
    const res = await window.xpro.readDir(dirPath);
    if (!res.ok || !res.data) return [];
    const entries: TreeEntry[] = res.data
      .filter((e: any) => !e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== 'target')
      .map((e: any) => ({
        name: e.name,
        path: e.path,
        isDir: e.isDir,
        expanded: false,
        children: undefined,
        depth,
      }))
      .sort((a: TreeEntry, b: TreeEntry) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    return entries;
  }

  function renderTree() {
    treeEl.innerHTML = '';
    function renderEntries(entries: TreeEntry[]) {
      for (const entry of entries) {
        const el = document.createElement('div');
        el.className = `tree-item${entry.isDir ? ' dir' : ''}`;
        const indent = '&nbsp;'.repeat(entry.depth * 4);
        const icon = entry.isDir ? (entry.expanded ? '📂' : '📁') : fileIcon(entry.name);
        el.innerHTML = `<span class="tree-indent">${indent}</span>${icon} ${entry.name}`;

        el.addEventListener('click', async () => {
          if (entry.isDir) {
            entry.expanded = !entry.expanded;
            if (entry.expanded && !entry.children) {
              entry.children = await loadDir(entry.path, entry.depth + 1);
            }
            renderTree();
          } else {
            // 打开文件
            const res = await window.xpro.readFile(entry.path);
            if (res.ok && res.data !== undefined) {
              editor.openFile(entry.path, entry.name, res.data);
            }
          }
        });

        treeEl.appendChild(el);

        if (entry.isDir && entry.expanded && entry.children) {
          renderEntries(entry.children);
        }
      }
    }
    renderEntries(rootEntries);
  }

  function fileIcon(name: string): string {
    const ext = name.split('.').pop()?.toLowerCase() ?? '';
    const icons: Record<string, string> = {
      rs: '🦀', py: '🐍', js: '📜', ts: '📘', java: '☕',
      html: '🌐', css: '🎨', json: '📋', md: '📝', toml: '⚙️',
      yaml: '⚙️', yml: '⚙️', go: '🔷', c: '🔧', cpp: '🔧',
      vue: '💚', sql: '🗄️', sh: '💻',
    };
    return icons[ext] ?? '📄';
  }

  async function openFolder(folderPath: string) {
    rootPath = folderPath;
    rootEntries = await loadDir(folderPath, 0);
    renderTree();

    // 更新侧边栏标题
    const header = document.querySelector('#sidebar-header span');
    if (header) {
      const folderName = folderPath.split(/[/\\]/).pop() ?? folderPath;
      header.textContent = `📁 ${folderName}`;
    }
  }

  return { openFolder };
}
