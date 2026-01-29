/**
 * Simple file-based cache for GitHub API responses
 * Stores cached data in .whatidid-cache directory
 */

import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const CACHE_DIR = join(homedir(), '.whatidid-cache');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface CacheEntry<T> {
  data: T;
  timestamp: number;
  version: number;
}

const CACHE_VERSION = 1;

/**
 * Ensure cache directory exists
 */
function ensureCacheDir(): void {
  if (!existsSync(CACHE_DIR)) {
    mkdirSync(CACHE_DIR, { recursive: true });
  }
}

/**
 * Generate a cache key from parameters
 */
function generateKey(prefix: string, params: Record<string, string>): string {
  const sortedParams = Object.entries(params)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  
  // Create a simple hash
  const str = `${prefix}:${sortedParams}`;
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return `${prefix}_${Math.abs(hash).toString(16)}`;
}

/**
 * Get cache file path for a key
 */
function getCachePath(key: string): string {
  return join(CACHE_DIR, `${key}.json`);
}

/**
 * Cache manager for storing and retrieving data
 */
export class Cache {
  private enabled: boolean;

  constructor(enabled = true) {
    this.enabled = enabled;
    if (enabled) {
      ensureCacheDir();
    }
  }

  /**
   * Get cached data if available and not expired
   */
  async get<T>(prefix: string, params: Record<string, string>): Promise<T | null> {
    if (!this.enabled) return null;

    const key = generateKey(prefix, params);
    const path = getCachePath(key);

    try {
      if (!existsSync(path)) {
        return null;
      }

      const content = await Bun.file(path).text();
      const entry = JSON.parse(content) as CacheEntry<T>;

      // Check version
      if (entry.version !== CACHE_VERSION) {
        return null;
      }

      // Check TTL
      if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
        return null;
      }

      return entry.data;
    } catch {
      return null;
    }
  }

  /**
   * Store data in cache
   */
  async set<T>(prefix: string, params: Record<string, string>, data: T): Promise<void> {
    if (!this.enabled) return;

    const key = generateKey(prefix, params);
    const path = getCachePath(key);

    const entry: CacheEntry<T> = {
      data,
      timestamp: Date.now(),
      version: CACHE_VERSION,
    };

    try {
      await Bun.write(path, JSON.stringify(entry));
    } catch {
      // Ignore cache write errors
    }
  }

  /**
   * Clear all cached data
   */
  async clear(): Promise<void> {
    if (!existsSync(CACHE_DIR)) return;

    const { readdir, unlink } = await import('fs/promises');
    
    try {
      const files = await readdir(CACHE_DIR);
      await Promise.all(
        files.map((file) => unlink(join(CACHE_DIR, file)).catch(() => {}))
      );
    } catch {
      // Ignore errors
    }
  }

  /**
   * Check if caching is enabled
   */
  isEnabled(): boolean {
    return this.enabled;
  }
}

/**
 * Global cache instance
 */
let globalCache: Cache | null = null;

export function getCache(enabled = true): Cache {
  if (!globalCache) {
    globalCache = new Cache(enabled);
  }
  return globalCache;
}

export function initCache(enabled: boolean): Cache {
  globalCache = new Cache(enabled);
  return globalCache;
}
