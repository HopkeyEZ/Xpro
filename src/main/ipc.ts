import { ipcMain, dialog, BrowserWindow, app } from 'electron';
import fs from 'fs';
import path from 'path';
import { spawn, ChildProcess } from 'child_process';
import { aiChat, aiChatWithTools, abortAi, ToolEvent } from './ai-bridge';
import { setProjectRoot } from './ai-tools';
import { loadConfig, saveConfig } from './config';
import { storeMemories, recallMemories, listMemories, forgetMemory, clearMemories, getMemoryStats } from './memory-store';
import { extractMemories, summarizeFileChange } from './memory-pipeline';

let shellProcess: ChildProcess | null = null;
let fsWatcher: fs.FSWatcher | null = null;

function ensureShell(sender: Electron.WebContents, cwd?: string) {
  if (shellProcess && !shellProcess.killed) return;

  const env = { ...process.env, PROMPT: '$P$G' };
  shellProcess = spawn('cmd.exe', ['/Q', '/K', 'chcp 65001'], {
    cwd: cwd || process.env.USERPROFILE || 'C:\\',
    env,
    windowsHide: true,
  });

  shellProcess.stdout?.on('data', (data: Buffer) => {
    try { sender.send('shell:data', data.toString('utf-8')); } catch {}
  });

  shellProcess.stderr?.on('data', (data: Buffer) => {
    try { sender.send('shell:data', data.toString('utf-8')); } catch {}
  });

  shellProcess.on('exit', (code) => {
    try { sender.send('shell:exit', code); } catch {}
    shellProcess = null;
  });
}

export function registerIpcHandlers(): void {
  // ==================== 文件操作 ====================
  ipcMain.handle('fs:readFile', async (_e, filePath: string) => {
    try {
      const buf = fs.readFileSync(filePath);
      // 检测二进制：前 8KB 中是否有 NULL 字节
      const check = buf.subarray(0, Math.min(buf.length, 8192));
      if (check.includes(0)) {
        return { ok: false, error: 'Binary file cannot be read as text' };
      }
      return { ok: true, data: buf.toString('utf-8') };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('fs:writeFile', async (_e, filePath: string, content: string) => {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, content, 'utf-8');
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('fs:readDir', async (_e, dirPath: string) => {
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      return {
        ok: true,
        data: entries.map(e => ({
          name: e.name,
          isDir: e.isDirectory(),
          path: path.join(dirPath, e.name),
        })),
      };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  });

  // ==================== 对话框 ====================
  ipcMain.handle('dialog:openFolder', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      title: '打开文件夹',
    });
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('dialog:openFiles', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      title: '选择文件',
    });
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths;
  });

  ipcMain.handle('dialog:saveFileAs', async (_e, content: string) => {
    const result = await dialog.showSaveDialog({ title: '另存为' });
    if (result.canceled || !result.filePath) return null;
    fs.writeFileSync(result.filePath, content, 'utf-8');
    return result.filePath;
  });

  // ==================== AI ====================
  ipcMain.handle('ai:chat', async (_e, provider: string, config: any, messages: any[]) => {
    return aiChat(provider, config, messages);
  });

  ipcMain.handle('ai:chatWithTools', async (e, provider: string, config: any, messages: any[], requestId: string) => {
    try {
      await aiChatWithTools(provider, config, messages, (evt: ToolEvent) => {
        try { e.sender.send('ai:toolEvent', requestId, evt); } catch {}
      });
    } catch (err: any) {
      console.error('[AI] chatWithTools error:', err);
      try { e.sender.send('ai:toolEvent', requestId, { type: 'error', error: err.message || 'Unknown error' }); } catch {}
    }
  });

  ipcMain.handle('ai:abort', async () => {
    abortAi();
    return { ok: true };
  });

  ipcMain.handle('ai:setProjectRoot', async (_e, root: string) => {
    setProjectRoot(root || '');
    return { ok: true };
  });

  // ==================== 配置 ====================
  ipcMain.handle('config:load', async () => loadConfig());
  ipcMain.handle('config:save', async (_e, config: any) => saveConfig(config));

  // ==================== File Watcher ====================
  ipcMain.handle('fs:watch', async (e, folderPath: string) => {
    if (fsWatcher) { try { fsWatcher.close(); } catch {} fsWatcher = null; }
    try {
      let debounceTimer: ReturnType<typeof setTimeout> | null = null;
      fsWatcher = fs.watch(folderPath, { recursive: true }, (eventType, filename) => {
        if (!filename) return;
        // Debounce: batch rapid changes into one event
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          const fullPath = path.join(folderPath, filename);
          const dir = path.dirname(fullPath);
          try { e.sender.send('fs:changed', dir); } catch {}
        }, 300);
      });
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('fs:unwatch', async () => {
    if (fsWatcher) { try { fsWatcher.close(); } catch {} fsWatcher = null; }
    return { ok: true };
  });

  // ==================== Shell (CMD) ====================
  ipcMain.handle('shell:start', async (e, cwd?: string) => {
    ensureShell(e.sender, cwd);
    return { ok: true };
  });

  ipcMain.handle('shell:write', async (_e, data: string) => {
    if (shellProcess && !shellProcess.killed) {
      shellProcess.stdin?.write(data);
      return { ok: true };
    }
    return { ok: false, error: 'Shell not running' };
  });

  ipcMain.handle('shell:kill', async () => {
    if (shellProcess && !shellProcess.killed) {
      shellProcess.kill();
      shellProcess = null;
    }
    return { ok: true };
  });

  // ==================== Screen Capture ====================
  // Returns full-page screenshot; renderer crops to the desired region
  ipcMain.handle('capture:rect', async (_e, _rect: any) => {
    try {
      const wins = BrowserWindow.getAllWindows();
      if (wins.length === 0) return { ok: false, error: 'No window' };
      const win = wins[0];

      // Full-page capture reliably includes cross-origin iframe content
      const fullImage = await win.webContents.capturePage();
      const imgSize = fullImage.getSize();
      const [contentW, contentH] = win.getContentSize();
      const base64 = fullImage.toPNG().toString('base64');
      console.log(`[Capture] Full page: ${imgSize.width}x${imgSize.height}, content: ${contentW}x${contentH}, base64Len=${base64.length}`);
      return { ok: true, data: base64, imgWidth: imgSize.width, imgHeight: imgSize.height, contentWidth: contentW, contentHeight: contentH };
    } catch (err: any) {
      console.error('[Capture] Error:', err);
      return { ok: false, error: err.message };
    }
  });

  // ==================== Memory ====================
  ipcMain.handle('memory:recall', async (_e, projectPath: string, query: string) => {
    try {
      const memories = recallMemories(projectPath, query);
      return { ok: true, data: memories };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('memory:list', async (_e, projectPath: string) => {
    try {
      const memories = listMemories(projectPath);
      return { ok: true, data: memories };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('memory:forget', async (_e, projectPath: string, memoryId: string) => {
    try {
      forgetMemory(projectPath, memoryId);
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('memory:clear', async (_e, projectPath: string) => {
    try {
      clearMemories(projectPath);
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('memory:stats', async (_e, projectPath: string) => {
    try {
      const stats = getMemoryStats(projectPath);
      return { ok: true, data: stats };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('memory:ingest', async (_e, projectPath: string, config: any, messages: any[], sessionId: string) => {
    try {
      const result = await extractMemories(config, messages, projectPath, sessionId);
      return result;
    } catch (err: any) {
      return { ok: false, stored: 0, error: err.message };
    }
  });

  ipcMain.handle('memory:summarizeChange', async (_e, config: any, filePath: string, oldContent: string, newContent: string) => {
    try {
      const summary = await summarizeFileChange(config, filePath, oldContent, newContent);
      return { ok: true, summary };
    } catch (err: any) {
      return { ok: false, summary: '', error: err.message };
    }
  });

  ipcMain.handle('app:restart', () => {
    app.relaunch();
    app.exit(0);
  });
}
