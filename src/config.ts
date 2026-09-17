import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import type { BrowserOptions } from "@ink-waffle/study-browser";

export const HOME_DIR = process.env.MOODLE_MCP_HOME || join(homedir(), ".moodle-mcp");
export const CACHE_DIR = join(HOME_DIR, "cache");
export const DOWNLOAD_DIR = process.env.MOODLE_MCP_DOWNLOADS || join(HOME_DIR, "files");

function positiveInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`Invalid MOODLE_MCP_BROWSER_PORT ${value}.`);
  }
  return parsed;
}

export function getBrowserOptions(): BrowserOptions {
  const cdpUrl = process.env.MOODLE_MCP_CDP;
  if (cdpUrl) return { kind: "external", cdpUrl };
  return {
    kind: "managed",
    profileDir: process.env.MOODLE_MCP_BROWSER_PROFILE,
    firstPort: positiveInteger(process.env.MOODLE_MCP_BROWSER_PORT),
  };
}
const CONFIG_PATH = join(HOME_DIR, "config.json");

export type Strategy = "mobile-launch" | "password" | "manual";

export interface Site {
  key: string;
  url: string;
  token: string;
  userid: number;
  username?: string;
  sitename?: string;
  release?: string;
  strategy: Strategy;
  connectedAt: string;
}

interface ConfigFile {
  defaultSite?: string;
  sites: Record<string, Site>;
}

let cache: ConfigFile | undefined;

export function siteKey(url: string): string {
  return new URL(normalizeUrl(url)).host;
}

export function normalizeUrl(url: string): string {
  let u = url.trim();
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  return u.replace(/\/+$/, "");
}

async function load(): Promise<ConfigFile> {
  if (cache) return cache;
  try {
    cache = JSON.parse(await readFile(CONFIG_PATH, "utf8")) as ConfigFile;
  } catch {
    cache = { sites: {} };
  }
  if (!cache.sites) cache.sites = {};
  return cache;
}

async function save(cfg: ConfigFile): Promise<void> {
  await mkdir(HOME_DIR, { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  await chmod(CONFIG_PATH, 0o600).catch(() => {});
  cache = cfg;
}

/** Env-configured site, for users who already hold a token. Takes precedence over the config file. */
function envSite(): Site | undefined {
  const url = process.env.MOODLE_URL;
  const token = process.env.MOODLE_TOKEN;
  if (!url || !token) return undefined;
  return {
    key: siteKey(url),
    url: normalizeUrl(url),
    token,
    userid: Number(process.env.MOODLE_USERID ?? 0),
    strategy: "manual",
    connectedAt: "env",
  };
}

export async function listSites(): Promise<Site[]> {
  const cfg = await load();
  const sites = Object.values(cfg.sites);
  const env = envSite();
  if (env && !sites.some((s) => s.key === env.key)) sites.unshift(env);
  return sites;
}

export async function getSite(hint?: string): Promise<Site> {
  const env = envSite();
  const cfg = await load();
  const sites = Object.values(cfg.sites);
  if (env) sites.unshift(env);

  if (hint) {
    const key = /^https?:\/\//i.test(hint) || hint.includes(".") ? siteKey(hint) : hint;
    const found = sites.find((s) => s.key === key || s.key.startsWith(key));
    if (!found) {
      throw new Error(
        `No connected Moodle site matches "${hint}". Connected: ${sites.map((s) => s.key).join(", ") || "none"}. Run moodle_connect first.`,
      );
    }
    return found;
  }

  if (sites.length === 0) {
    throw new Error(
      "No Moodle site is connected yet. Run moodle_connect with your Moodle URL (e.g. moodle.yourschool.edu) first.",
    );
  }
  if (cfg.defaultSite) {
    const def = sites.find((s) => s.key === cfg.defaultSite);
    if (def) return def;
  }
  if (sites.length > 1) {
    throw new Error(
      `Several sites are connected (${sites.map((s) => s.key).join(", ")}). Pass the "site" argument to choose one.`,
    );
  }
  return sites[0]!;
}

export async function putSite(site: Site): Promise<void> {
  const cfg = await load();
  cfg.sites[site.key] = site;
  if (!cfg.defaultSite || Object.keys(cfg.sites).length === 1) cfg.defaultSite = site.key;
  await save(cfg);
}

export async function removeSite(key: string): Promise<boolean> {
  const cfg = await load();
  if (!cfg.sites[key]) return false;
  delete cfg.sites[key];
  if (cfg.defaultSite === key) cfg.defaultSite = Object.keys(cfg.sites)[0];
  await save(cfg);
  return true;
}

export async function setDefaultSite(key: string): Promise<void> {
  const cfg = await load();
  if (!cfg.sites[key]) throw new Error(`Site ${key} is not connected.`);
  cfg.defaultSite = key;
  await save(cfg);
}
