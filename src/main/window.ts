import { BrowserWindow, Menu, MenuItem } from 'electron';
import path from 'path';

let mainWindow: BrowserWindow | null = null;

export function createMainWindow(): BrowserWindow {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 500,
    title: 'Xpro – Workflow',
    backgroundColor: '#1a1a2e',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#16213e',
      symbolColor: '#e0e0e0',
      height: 42,
    },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (process.env.NODE_ENV === 'development') {
    mainWindow.loadURL('http://localhost:9080');
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  // Right-click context menu (Copy / Paste / Select All)
  mainWindow.webContents.on('context-menu', (_e, params) => {
    const menu = new Menu();
    if (params.selectionText) {
      menu.append(new MenuItem({ label: '复制', role: 'copy' }));
    }
    if (params.isEditable) {
      menu.append(new MenuItem({ label: '粘贴', role: 'paste' }));
      menu.append(new MenuItem({ label: '剪切', role: 'cut' }));
    }
    menu.append(new MenuItem({ label: '全选', role: 'selectAll' }));
    menu.popup();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  return mainWindow;
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}
