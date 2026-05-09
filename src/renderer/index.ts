import './styles/main.css';
import { WorkflowCanvas } from './components/WorkflowCanvas';

declare global {
  interface Window {
    xpro: {
      readFile: (path: string) => Promise<{ ok: boolean; data?: string; error?: string }>;
      writeFile: (path: string, content: string) => Promise<{ ok: boolean; error?: string }>;
      readDir: (path: string) => Promise<{ ok: boolean; data?: any[]; error?: string }>;
      openFolder: () => Promise<string | null>;
      openFiles: () => Promise<string[] | null>;
      saveFileAs: (content: string) => Promise<string | null>;
      aiChat: (provider: string, config: any, messages: any[]) => Promise<any>;
      aiChatWithTools: (provider: string, config: any, messages: any[], requestId: string) => Promise<void>;
      onAiToolEvent: (cb: (requestId: string, evt: any) => void) => void;
      aiAbort: () => Promise<{ ok: boolean }>;
      aiSetProjectRoot: (root: string) => Promise<{ ok: boolean }>;
      watchFolder: (folderPath: string) => Promise<{ ok: boolean; error?: string }>;
      unwatchFolder: () => Promise<{ ok: boolean }>;
      onFsChange: (cb: (dir: string) => void) => void;
      loadConfig: () => Promise<any>;
      saveConfig: (config: any) => Promise<void>;
      shellStart: (cwd?: string) => Promise<{ ok: boolean }>;
      shellWrite: (data: string) => Promise<{ ok: boolean; error?: string }>;
      shellKill: () => Promise<{ ok: boolean }>;
      onShellData: (cb: (data: string) => void) => void;
      onShellExit: (cb: (code: number | null) => void) => void;
      nativeSearch: (dir: string, pattern: string) => Promise<any>;
      memoryRecall: (projectPath: string, query: string) => Promise<{ ok: boolean; data?: any[]; error?: string }>;
      memoryList: (projectPath: string) => Promise<{ ok: boolean; data?: any[]; error?: string }>;
      memoryForget: (projectPath: string, memoryId: string) => Promise<{ ok: boolean; error?: string }>;
      memoryClear: (projectPath: string) => Promise<{ ok: boolean; error?: string }>;
      memoryStats: (projectPath: string) => Promise<{ ok: boolean; data?: any; error?: string }>;
      memoryIngest: (projectPath: string, config: any, messages: any[], sessionId: string) => Promise<{ ok: boolean; stored: number; error?: string }>;
      memoryCategorize: (config: any, changes: Array<{ id: string; label: string; filePath: string }>) => Promise<{ ok: boolean; mapping?: Record<string, string>; error?: string }>;
      memorySummarizeChange: (config: any, filePath: string, oldContent: string, newContent: string) => Promise<{ ok: boolean; summary?: string; error?: string }>;
    };
  }
}

async function main() {
  const canvas = new WorkflowCanvas();

  // Open Folder
  document.getElementById('btn-open-folder')?.addEventListener('click', async () => {
    const folder = await window.xpro.openFolder();
    if (folder) canvas.loadFolder(folder);
  });

  // Open Files
  document.getElementById('btn-open-files')?.addEventListener('click', async () => {
    const files = await window.xpro.openFiles();
    if (files && files.length > 0) canvas.loadFiles(files);
  });

  // Layout direction toggle
  const btnH = document.getElementById('btn-layout-h')!;
  const btnV = document.getElementById('btn-layout-v')!;
  btnH.addEventListener('click', () => {
    btnH.classList.add('active');
    btnV.classList.remove('active');
    canvas.setLayoutDir('h');
  });
  btnV.addEventListener('click', () => {
    btnV.classList.add('active');
    btnH.classList.remove('active');
    canvas.setLayoutDir('v');
  });

  // Auto Layout
  document.getElementById('btn-auto-layout')?.addEventListener('click', () => {
    canvas.autoLayout();
    canvas.fitView();
  });

  // Fit View
  document.getElementById('btn-fit-view')?.addEventListener('click', () => {
    canvas.fitView();
  });
}

main().catch(console.error);
