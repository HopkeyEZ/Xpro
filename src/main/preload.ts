import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('xpro', {
  // 文件操作
  readFile: (filePath: string) => ipcRenderer.invoke('fs:readFile', filePath),
  writeFile: (filePath: string, content: string) => ipcRenderer.invoke('fs:writeFile', filePath, content),
  readDir: (dirPath: string) => ipcRenderer.invoke('fs:readDir', dirPath),
  openFolder: () => ipcRenderer.invoke('dialog:openFolder'),
  openFiles: () => ipcRenderer.invoke('dialog:openFiles'),
  saveFileAs: (content: string) => ipcRenderer.invoke('dialog:saveFileAs', content),

  // AI
  aiChat: (provider: string, config: any, messages: any[]) =>
    ipcRenderer.invoke('ai:chat', provider, config, messages),
  aiChatWithTools: (provider: string, config: any, messages: any[], requestId: string) =>
    ipcRenderer.invoke('ai:chatWithTools', provider, config, messages, requestId),
  onAiToolEvent: (callback: (requestId: string, evt: any) => void) =>
    ipcRenderer.on('ai:toolEvent', (_e, requestId, evt) => callback(requestId, evt)),
  aiAbort: () => ipcRenderer.invoke('ai:abort'),
  aiSetProjectRoot: (root: string) => ipcRenderer.invoke('ai:setProjectRoot', root),

  // File watcher
  watchFolder: (folderPath: string) => ipcRenderer.invoke('fs:watch', folderPath),
  unwatchFolder: () => ipcRenderer.invoke('fs:unwatch'),
  onFsChange: (cb: (dir: string) => void) =>
    ipcRenderer.on('fs:changed', (_e, dir) => cb(dir)),

  // 配置
  loadConfig: () => ipcRenderer.invoke('config:load'),
  saveConfig: (config: any) => ipcRenderer.invoke('config:save', config),

  // Shell (CMD)
  shellStart: (cwd?: string) => ipcRenderer.invoke('shell:start', cwd),
  shellWrite: (data: string) => ipcRenderer.invoke('shell:write', data),
  shellKill: () => ipcRenderer.invoke('shell:kill'),
  onShellData: (cb: (data: string) => void) =>
    ipcRenderer.on('shell:data', (_e, data) => cb(data)),
  onShellExit: (cb: (code: number | null) => void) =>
    ipcRenderer.on('shell:exit', (_e, code) => cb(code)),

  // Screen capture
  captureRect: (rect: { x: number; y: number; width: number; height: number }) =>
    ipcRenderer.invoke('capture:rect', rect),

  // Rust native
  nativeSearch: (dir: string, pattern: string) => ipcRenderer.invoke('native:search', dir, pattern),

  // AI file change events (for checkpoint + lint)
  onAiFileChanged: (cb: (data: { toolName: string; filePath: string; oldContent: string; newContent: string }) => void) =>
    ipcRenderer.on('ai:fileChanged', (_e, data) => cb(data)),

  // Memory
  memoryRecall: (projectPath: string, query: string) => ipcRenderer.invoke('memory:recall', projectPath, query),
  memoryList: (projectPath: string) => ipcRenderer.invoke('memory:list', projectPath),
  memoryForget: (projectPath: string, memoryId: string) => ipcRenderer.invoke('memory:forget', projectPath, memoryId),
  memoryClear: (projectPath: string) => ipcRenderer.invoke('memory:clear', projectPath),
  memoryStats: (projectPath: string) => ipcRenderer.invoke('memory:stats', projectPath),
  memoryIngest: (projectPath: string, config: any, messages: any[], sessionId: string) =>
    ipcRenderer.invoke('memory:ingest', projectPath, config, messages, sessionId),
  memorySummarizeChange: (config: any, filePath: string, oldContent: string, newContent: string) =>
    ipcRenderer.invoke('memory:summarizeChange', config, filePath, oldContent, newContent),
  memoryCategorize: (config: any, changes: Array<{ id: string; label: string; filePath: string }>) =>
    ipcRenderer.invoke('memory:categorizeChanges', config, changes),

  // App
  restart: () => ipcRenderer.invoke('app:restart'),
});
