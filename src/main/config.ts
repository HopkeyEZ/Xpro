import fs from 'fs';
import path from 'path';
import os from 'os';

export interface XproConfig {
  ai: {
    provider: 'openai' | 'anthropic' | '';
    baseUrl: string;
    apiKey: string;
    model: string;
  };
  editor: {
    fontSize: number;
    tabSize: number;
    wordWrap: 'on' | 'off';
    minimap: boolean;
  };
  theme: 'dark' | 'light';
}

const CONFIG_DIR = path.join(os.homedir(), '.xpro');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

const DEFAULT_CONFIG: XproConfig = {
  ai: {
    provider: '',
    baseUrl: '',
    apiKey: '',
    model: '',
  },
  editor: {
    fontSize: 14,
    tabSize: 4,
    wordWrap: 'off',
    minimap: true,
  },
  theme: 'dark',
};

export function loadConfig(): XproConfig {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
      return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
    }
  } catch {
    // ignore
  }
  return { ...DEFAULT_CONFIG };
}

export function saveConfig(config: XproConfig): void {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
  } catch (err) {
    console.error('Failed to save config:', err);
  }
}
