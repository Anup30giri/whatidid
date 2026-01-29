/**
 * Configuration management for whatidid CLI
 * Loads and validates required environment variables
 */

export interface Config {
  githubToken: string;
  llmApiKey: string;
  llmModel: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Validates that a required environment variable is set
 */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new ConfigError(
      `Missing required environment variable: ${name}\n` +
      `Please set ${name} before running the command.`
    );
  }
  return value.trim();
}

/**
 * Gets an optional environment variable with a default value
 */
function optionalEnv(name: string, defaultValue: string): string {
  const value = process.env[name];
  return value?.trim() || defaultValue;
}

/**
 * Loads and validates configuration from environment variables
 */
export function loadConfig(): Config {
  return {
    githubToken: requireEnv('GITHUB_TOKEN'),
    llmApiKey: requireEnv('LLM_API_KEY'),
    llmModel: optionalEnv('LLM_MODEL', 'gemini-2.5-flash-preview-05-20'),
  };
}

/**
 * Validates that both required tokens are present
 * Call this early to fail fast with clear error messages
 */
export function validateConfig(): void {
  const missingVars: string[] = [];
  
  if (!process.env['GITHUB_TOKEN']) {
    missingVars.push('GITHUB_TOKEN');
  }
  
  if (!process.env['LLM_API_KEY']) {
    missingVars.push('LLM_API_KEY');
  }
  
  if (missingVars.length > 0) {
    throw new ConfigError(
      `Missing required environment variables:\n` +
      missingVars.map(v => `  - ${v}`).join('\n') +
      `\n\nPlease set these variables before running the command:\n` +
      `  export GITHUB_TOKEN=your_github_token\n` +
      `  export LLM_API_KEY=your_google_api_key`
    );
  }
}
