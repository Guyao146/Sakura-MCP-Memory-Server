export const APP_VERSION = '0.3.2';

const RELEASE_API_URL = 'https://api.github.com/repos/Guyao146/Sakura-MCP-Server/releases/latest';
const RELEASE_PAGE_URL = 'https://github.com/Guyao146/Sakura-MCP-Server/releases/tag/';

interface ParsedVersion { numbers: [number, number, number]; prerelease?: string; }
type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface VersionStatus {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  releaseUrl: string;
  publishedAt: string | null;
  checkedAt: string;
}

export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < a.numbers.length; index += 1) {
    const difference = a.numbers[index] - b.numbers[index];
    if (difference !== 0) return Math.sign(difference);
  }
  if (!a.prerelease && b.prerelease) return 1;
  if (a.prerelease && !b.prerelease) return -1;
  return (a.prerelease ?? '').localeCompare(b.prerelease ?? '');
}

export class UpdateChecker {
  private cached?: { expiresAt: number; value: VersionStatus };

  constructor(
    private readonly currentVersion = APP_VERSION,
    private readonly ttlMs = 15 * 60 * 1000,
    private readonly fetcher: FetchLike = fetch,
    private readonly now: () => number = Date.now
  ) {}

  async check(force = false): Promise<VersionStatus> {
    const now = this.now();
    if (!force && this.cached && this.cached.expiresAt > now) return this.cached.value;
    const response = await this.fetcher(RELEASE_API_URL, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': `Sakura-MCP-Server/${this.currentVersion}` },
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) throw new Error(`GitHub release check failed (${response.status}).`);
    const release = await response.json() as { tag_name?: unknown; published_at?: unknown };
    if (typeof release.tag_name !== 'string') throw new Error('GitHub release response does not contain a version tag.');
    const latestVersion = normalizeVersion(release.tag_name);
    parseVersion(latestVersion);
    const value: VersionStatus = {
      currentVersion: this.currentVersion,
      latestVersion,
      updateAvailable: compareVersions(latestVersion, this.currentVersion) > 0,
      releaseUrl: `${RELEASE_PAGE_URL}${encodeURIComponent(release.tag_name)}`,
      publishedAt: typeof release.published_at === 'string' ? release.published_at : null,
      checkedAt: new Date(now).toISOString()
    };
    this.cached = { expiresAt: now + this.ttlMs, value };
    return value;
  }
}

function normalizeVersion(value: string): string { return value.trim().replace(/^v/i, ''); }

function parseVersion(value: string): ParsedVersion {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(value.trim());
  if (!match) throw new Error(`Invalid semantic version: ${value}`);
  return { numbers: [Number(match[1]), Number(match[2]), Number(match[3])], prerelease: match[4] };
}