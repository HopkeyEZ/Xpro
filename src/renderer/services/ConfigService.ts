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

const DEFAULT_CONFIG: XproConfig = {
  ai: { provider: '', baseUrl: '', apiKey: '', model: '' },
  editor: { fontSize: 14, tabSize: 4, wordWrap: 'off', minimap: true },
  theme: 'dark',
};

export const ConfigService = {
  async load(): Promise<XproConfig> {
    try {
      const cfg = await window.xpro.loadConfig();
      return { ...DEFAULT_CONFIG, ...cfg };
    } catch {
      return { ...DEFAULT_CONFIG };
    }
  },

  async save(config: XproConfig): Promise<void> {
    await window.xpro.saveConfig(config);
  },
};
