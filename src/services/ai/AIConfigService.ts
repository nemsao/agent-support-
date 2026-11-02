/**
 * Application-wide AI configuration.
 *
 * This service is main-process only. The API key is encrypted with Electron's
 * safeStorage before it is written to the local SQLite settings table.
 */
import { safeStorage } from 'electron';
import DatabaseService from '../database/DatabaseService';

export interface GlobalAIConfig {
  provider: 'openai-compatible';
  endpoint: string;
  apiKey: string;
  model: string;
}

const SETTING_KEY = 'ai_global_config';
const DEFAULT_MODEL = 'qwen/qwen3.8-omni-flash:free';
const DEFAULT_CONFIG: GlobalAIConfig = {
  provider: 'openai-compatible',
  endpoint: 'https://api.xkiro.com/v1',
  apiKey: '',
  model: DEFAULT_MODEL,
};

function encrypt(value: string): string {
  if (!value) return '';
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return `enc:${safeStorage.encryptString(value).toString('base64')}`;
    }
  } catch {}
  return value;
}

function decrypt(value: string): string {
  if (!value) return '';
  if (!value.startsWith('enc:')) return value;
  try {
    return safeStorage.decryptString(Buffer.from(value.slice(4), 'base64'));
  } catch {
    return '';
  }
}

function normalizeEndpoint(endpoint: string): string {
  return endpoint.trim().replace(/\/+$/, '');
}

class AIConfigService {
  private static instance: AIConfigService;

  public static getInstance(): AIConfigService {
    if (!AIConfigService.instance) AIConfigService.instance = new AIConfigService();
    return AIConfigService.instance;
  }

  private constructor() {}

  public getConfig(): GlobalAIConfig {
    const raw = DatabaseService.getInstance().getSetting(SETTING_KEY);
    if (!raw) return { ...DEFAULT_CONFIG };
    try {
      const parsed = JSON.parse(raw);
      return {
        ...DEFAULT_CONFIG,
        ...parsed,
        // Migrate the temporary model name from the previous Xkiro setup.
        model: parsed.model === 'sasha-movchedev' ? DEFAULT_MODEL : (parsed.model || DEFAULT_CONFIG.model),
        endpoint: normalizeEndpoint(parsed.endpoint || DEFAULT_CONFIG.endpoint),
        apiKey: decrypt(parsed.apiKey || ''),
      };
    } catch {
      return { ...DEFAULT_CONFIG };
    }
  }

  public getMaskedConfig(): Omit<GlobalAIConfig, 'apiKey'> & { apiKey: string } {
    const config = this.getConfig();
    return {
      ...config,
      apiKey: config.apiKey ? '***' : '',
    };
  }

  public saveConfig(input: Partial<GlobalAIConfig>): void {
    const current = this.getConfig();
    const apiKey = input.apiKey === '***' ? current.apiKey : (input.apiKey ?? current.apiKey);
    const config: GlobalAIConfig = {
      provider: 'openai-compatible',
      endpoint: normalizeEndpoint(input.endpoint ?? current.endpoint),
      apiKey,
      model: (input.model ?? current.model).trim(),
    };
    DatabaseService.getInstance().setSetting(SETTING_KEY, JSON.stringify({
      ...config,
      apiKey: encrypt(config.apiKey),
    }));
  }

  public hasConfig(): boolean {
    const config = this.getConfig();
    return !!(config.endpoint && config.apiKey && config.model);
  }

  /** Fill only missing assistant fields; explicit assistant overrides win. */
  public resolveAssistant<T extends { apiKey?: string; baseUrl?: string | null; model?: string }>(assistant: T): T {
    const global = this.getConfig();
    return {
      ...assistant,
      apiKey: assistant.apiKey || global.apiKey,
      baseUrl: assistant.baseUrl || global.endpoint,
      model: assistant.model || global.model,
    };
  }
}

export default AIConfigService;
