// Per-URL on-disk cache for fetched pages. Keyed by SHA-256(url). Stores
// the full FetchedPage JSON at <dir>/<hash>.json with mtime-based TTL.
//
// Why file-based: zero runtime deps, survives process restarts, inspectable,
// and good enough for a single-user local tool. The cache directory defaults
// to ~/.deepdive/cache/ but tests inject a tmpdir.

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { FetchedPage } from "./browser.js";

export interface CacheOptions {
  dir: string;
  ttlMs: number;
}

export interface PageCache {
  readonly dir: string;
  readonly ttlMs: number;
  get(url: string): Promise<FetchedPage | null>;
  put(url: string, page: FetchedPage): Promise<void>;
  readonly hits: number;
  readonly misses: number;
}

export function createCache(opts: CacheOptions): PageCache {
  const state = { hits: 0, misses: 0, mkdired: false };

  async function ensureDir(): Promise<void> {
    if (state.mkdired) return;
    await fs.mkdir(opts.dir, { recursive: true });
    state.mkdired = true;
  }

  return {
    get dir() {
      return opts.dir;
    },
    get ttlMs() {
      return opts.ttlMs;
    },
    get hits() {
      return state.hits;
    },
    get misses() {
      return state.misses;
    },
    async get(url: string): Promise<FetchedPage | null> {
      const path = join(opts.dir, cacheKey(url) + ".json");
      try {
        const stat = await fs.stat(path);
        if (Date.now() - stat.mtimeMs > opts.ttlMs) {
          state.misses++;
          return null;
        }
        const raw = await fs.readFile(path, "utf-8");
        const page = JSON.parse(raw) as FetchedPage;
        state.hits++;
        return page;
      } catch {
        state.misses++;
        return null;
      }
    },
    async put(url: string, page: FetchedPage): Promise<void> {
      await ensureDir();
      const path = join(opts.dir, cacheKey(url) + ".json");
      const tmp = path + ".tmp." + process.pid;
      await fs.writeFile(tmp, JSON.stringify(page), "utf-8");
      await fs.rename(tmp, path);
    },
  };
}

// Exported for unit tests.
export function cacheKey(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 32);
}
