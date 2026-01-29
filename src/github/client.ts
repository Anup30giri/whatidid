/**
 * GitHub REST API client
 * Handles fetching repositories, pull requests, and commits
 */

import type { Repository, PullRequest, Commit } from '../domain/models';
import type {
  GitHubRepository,
  GitHubPullRequest,
  GitHubCommit,
  GitHubSearchResponse,
  GitHubSearchIssue,
  GitHubError,
  GitHubOrganization,
  PaginationInfo,
} from './types';
import { getCache, type Cache } from '../cache';

const GITHUB_API_BASE = 'https://api.github.com';

export class GitHubClientError extends Error {
  constructor(
    message: string,
    public statusCode?: number,
    public endpoint?: string,
  ) {
    super(message);
    this.name = 'GitHubClientError';
  }
}

/**
 * Parse Link header for pagination
 */
function parseLinkHeader(header: string | null): PaginationInfo {
  if (!header) return {};

  const links: PaginationInfo = {};
  const parts = header.split(',');

  for (const part of parts) {
    const match = part.match(/<([^>]+)>;\s*rel="([^"]+)"/);
    if (match) {
      const [, url, rel] = match;
      if (url && rel) {
        links[rel as keyof PaginationInfo] = url;
      }
    }
  }

  return links;
}

/**
 * Check if base branch matches allowed patterns
 */
function isAllowedBaseBranch(branch: string): boolean {
  if (branch === 'main' || branch === 'master') {
    return true;
  }
  if (branch.startsWith('release/')) {
    return true;
  }
  return false;
}

/**
 * Check if a date is within a range
 */
function isDateInRange(dateStr: string, since: string, until: string): boolean {
  const date = new Date(dateStr);
  const sinceDate = new Date(since);
  const untilDate = new Date(until);
  untilDate.setHours(23, 59, 59, 999);
  return date >= sinceDate && date <= untilDate;
}

/**
 * Sleep for a specified number of milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Scope of repositories to search
 */
export type RepoScope = 'all' | 'personal' | 'orgs';

/**
 * Options for GitHub client
 */
export interface GitHubClientOptions {
  cache?: boolean;
  /** Scope: 'all' (default), 'personal' (only personal repos), 'orgs' (only org repos) */
  scope?: RepoScope;
  repos?: string[];
  orgs?: string[];
  excludeRepos?: string[];
  /** Skip exhaustive org repo scanning (faster, relies on search API only) */
  skipOrgScan?: boolean;
  verbose?: boolean;
}

/**
 * GitHub API client for fetching user activity
 */
export class GitHubClient {
  private token: string;
  private cache: Cache;
  private options: GitHubClientOptions;
  private requestCount = 0;
  private lastRequestTime = 0;
  private readonly minRequestInterval = 100;

  constructor(token: string, options: GitHubClientOptions = {}) {
    this.token = token;
    this.options = options;
    this.cache = getCache(options.cache ?? true);
  }

  private log(message: string): void {
    if (this.options.verbose !== false) {
      console.log(message);
    }
  }

  private logProgress(message: string): void {
    if (this.options.verbose !== false) {
      process.stdout.write(message);
    }
  }

  private async rateLimit(): Promise<void> {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;

    if (timeSinceLastRequest < this.minRequestInterval) {
      await sleep(this.minRequestInterval - timeSinceLastRequest);
    }

    this.lastRequestTime = Date.now();
    this.requestCount++;
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit = {},
    retryCount = 0,
  ): Promise<{ data: T; pagination: PaginationInfo }> {
    await this.rateLimit();

    const url = endpoint.startsWith('http') ? endpoint : `${GITHUB_API_BASE}${endpoint}`;

    const response = await fetch(url, {
      ...options,
      headers: {
        Accept: 'application/vnd.github.v3+json',
        Authorization: `Bearer ${this.token}`,
        'User-Agent': 'whatidid-cli',
        ...options.headers,
      },
    });

    if (response.status === 403 || response.status === 429) {
      const rateLimitRemaining = response.headers.get('X-RateLimit-Remaining');
      const rateLimitReset = response.headers.get('X-RateLimit-Reset');

      if (rateLimitRemaining === '0' || response.status === 429) {
        if (retryCount >= 3) {
          throw new GitHubClientError(
            'Rate limit exceeded. Please wait and try again later.',
            response.status,
            endpoint
          );
        }

        let waitTime = 60000;
        if (rateLimitReset) {
          const resetTime = parseInt(rateLimitReset, 10) * 1000;
          waitTime = Math.max(resetTime - Date.now() + 1000, 1000);
          waitTime = Math.min(waitTime, 300000);
        }

        console.log(`\n  ⏳ Rate limited. Waiting ${Math.ceil(waitTime / 1000)}s before retrying...`);
        await sleep(waitTime);
        return this.request<T>(endpoint, options, retryCount + 1);
      }
    }

    if (!response.ok) {
      let errorMessage = `GitHub API error: ${response.status} ${response.statusText}`;

      try {
        const errorBody = (await response.json()) as GitHubError;
        if (errorBody.message) {
          errorMessage = `GitHub API error: ${errorBody.message}`;
        }
      } catch {
        // Ignore
      }

      throw new GitHubClientError(errorMessage, response.status, endpoint);
    }

    const data = (await response.json()) as T;
    const pagination = parseLinkHeader(response.headers.get('Link'));

    return { data, pagination };
  }

  private async fetchAllPages<T>(endpoint: string): Promise<T[]> {
    const results: T[] = [];
    let nextUrl: string | undefined = `${GITHUB_API_BASE}${endpoint}`;

    while (nextUrl) {
      const response: { data: T[]; pagination: PaginationInfo } = await this.request<T[]>(nextUrl);
      results.push(...response.data);
      nextUrl = response.pagination.next;
    }

    return results;
  }

  private async listUserOrganizations(): Promise<GitHubOrganization[]> {
    try {
      return await this.fetchAllPages<GitHubOrganization>('/user/orgs?per_page=100');
    } catch {
      return [];
    }
  }

  private async listOrgRepositories(orgLogin: string): Promise<Repository[]> {
    const repos: Repository[] = [];

    try {
      const githubRepos = await this.fetchAllPages<GitHubRepository>(
        `/orgs/${orgLogin}/repos?per_page=100&type=all`
      );

      for (const repo of githubRepos) {
        repos.push({
          id: repo.id,
          name: repo.name,
          fullName: repo.full_name,
          owner: repo.owner.login,
          url: repo.html_url,
          defaultBranch: repo.default_branch,
        });
      }
    } catch {
      // Skip
    }

    return repos;
  }

  async listMergedPRs(
    username: string,
    repoFullName: string,
    since: string,
    until: string,
    fetchCommits = false,
  ): Promise<PullRequest[]> {
    const pullRequests: PullRequest[] = [];

    try {
      const allPRs = await this.fetchAllPages<GitHubPullRequest>(
        `/repos/${repoFullName}/pulls?state=closed&sort=updated&direction=desc&per_page=100`,
      );

      for (const pr of allPRs) {
        if (!pr.merged_at) continue;
        if (pr.user.login.toLowerCase() !== username.toLowerCase()) continue;
        if (!isDateInRange(pr.merged_at, since, until)) {
          if (new Date(pr.merged_at) < new Date(since)) break;
          continue;
        }
        if (!isAllowedBaseBranch(pr.base.ref)) continue;

        const commits = fetchCommits ? await this.fetchPRCommits(repoFullName, pr.number) : [];
        const repoName = repoFullName.split('/')[1] ?? repoFullName;

        pullRequests.push({
          number: pr.number,
          title: pr.title,
          body: pr.body,
          url: pr.html_url,
          repoName,
          repoFullName,
          baseBranch: pr.base.ref,
          createdAt: pr.created_at,
          mergedAt: pr.merged_at,
          commits,
        });
      }
    } catch {
      return this.listMergedPRsViaSearch(username, repoFullName, since, until, fetchCommits);
    }

    return pullRequests;
  }

  private async listMergedPRsViaSearch(
    username: string,
    repoFullName: string,
    since: string,
    until: string,
    fetchCommits = false,
  ): Promise<PullRequest[]> {
    const query = `repo:${repoFullName} author:${username} is:pr is:merged merged:${since}..${until}`;
    const encodedQuery = encodeURIComponent(query);

    const allItems: GitHubSearchIssue[] = [];
    let page = 1;
    const perPage = 100;

    while (true) {
      const { data } = await this.request<GitHubSearchResponse<GitHubSearchIssue>>(
        `/search/issues?q=${encodedQuery}&per_page=${perPage}&page=${page}`,
      );

      allItems.push(...data.items);

      if (data.items.length < perPage || allItems.length >= data.total_count) break;
      page++;
    }

    const pullRequests: PullRequest[] = [];

    for (const item of allItems) {
      try {
        const { data: pr } = await this.request<GitHubPullRequest>(
          `/repos/${repoFullName}/pulls/${item.number}`,
        );

        if (!pr.merged_at || !isAllowedBaseBranch(pr.base.ref)) continue;

        const commits = fetchCommits ? await this.fetchPRCommits(repoFullName, pr.number) : [];
        const repoName = repoFullName.split('/')[1] ?? repoFullName;

        pullRequests.push({
          number: pr.number,
          title: pr.title,
          body: pr.body,
          url: pr.html_url,
          repoName,
          repoFullName,
          baseBranch: pr.base.ref,
          createdAt: pr.created_at,
          mergedAt: pr.merged_at,
          commits,
        });
      } catch {
        // Skip
      }
    }

    return pullRequests;
  }

  private async fetchPRCommits(repoFullName: string, prNumber: number): Promise<Commit[]> {
    try {
      const commits = await this.fetchAllPages<GitHubCommit>(
        `/repos/${repoFullName}/pulls/${prNumber}/commits?per_page=100`,
      );

      return commits.map((commit) => ({
        sha: commit.sha,
        message: commit.commit.message,
        author: commit.commit.author.name,
        date: commit.commit.author.date,
      }));
    } catch {
      return [];
    }
  }

  /**
   * Check if a repo belongs to an organization (vs personal)
   */
  private isOrgRepo(repoFullName: string, username: string): boolean {
    const owner = repoFullName.split('/')[0]?.toLowerCase();
    return owner !== username.toLowerCase();
  }

  /**
   * Check if a repo should be included based on filter options
   */
  private shouldIncludeRepo(repoFullName: string, username: string): boolean {
    const { repos, orgs, excludeRepos, scope } = this.options;

    if (excludeRepos?.includes(repoFullName)) return false;

    // Check scope filter
    if (scope === 'personal') {
      // Only include personal repos (owner matches username)
      if (this.isOrgRepo(repoFullName, username)) return false;
    } else if (scope === 'orgs') {
      // Only include organization repos
      if (!this.isOrgRepo(repoFullName, username)) return false;
    }

    // Check specific repos filter
    if (repos && repos.length > 0) {
      return repos.includes(repoFullName);
    }

    // Check specific orgs filter
    if (orgs && orgs.length > 0) {
      const repoOrg = repoFullName.split('/')[0];
      return repoOrg ? orgs.includes(repoOrg) : false;
    }

    return true;
  }

  private async fetchPRsViaGlobalSearch(
    username: string,
    since: string,
    until: string,
  ): Promise<PullRequest[]> {
    const cacheKey = { username, since, until, type: 'search' };
    const cached = await this.cache.get<PullRequest[]>('prs', cacheKey);
    if (cached) {
      this.log('  Using cached PR data from previous run');
      return cached.filter((pr) => this.shouldIncludeRepo(pr.repoFullName, username));
    }

    this.log('  Searching for all merged PRs via global search...');

    const query = `author:${username} is:pr is:merged merged:${since}..${until}`;
    const encodedQuery = encodeURIComponent(query);

    const allItems: GitHubSearchIssue[] = [];
    let page = 1;
    const perPage = 100;

    while (true) {
      const { data } = await this.request<GitHubSearchResponse<GitHubSearchIssue>>(
        `/search/issues?q=${encodedQuery}&per_page=${perPage}&page=${page}`,
      );

      allItems.push(...data.items);
      this.log(`    Found ${allItems.length}/${data.total_count} PRs...`);

      if (data.items.length < perPage || allItems.length >= data.total_count) break;
      page++;
    }

    const pullRequests: PullRequest[] = [];
    const seenPRs = new Set<string>();

    for (let i = 0; i < allItems.length; i++) {
      const item = allItems[i]!;

      const match = item.repository_url.match(/repos\/([^/]+\/[^/]+)$/);
      if (!match) continue;

      const repoFullName = match[1]!;
      const prKey = `${repoFullName}#${item.number}`;

      if (seenPRs.has(prKey)) continue;
      seenPRs.add(prKey);

      this.logProgress(`\r  Fetching PR details: ${i + 1}/${allItems.length}...`.padEnd(60));

      try {
        const { data: pr } = await this.request<GitHubPullRequest>(
          `/repos/${repoFullName}/pulls/${item.number}`,
        );

        if (!pr.merged_at || !isAllowedBaseBranch(pr.base.ref)) continue;

        const repoName = repoFullName.split('/')[1] ?? repoFullName;

        pullRequests.push({
          number: pr.number,
          title: pr.title,
          body: pr.body,
          url: pr.html_url,
          repoName,
          repoFullName,
          baseBranch: pr.base.ref,
          createdAt: pr.created_at,
          mergedAt: pr.merged_at,
          commits: [],
        });
      } catch {
        // Skip
      }
    }

    this.logProgress('\r'.padEnd(60) + '\r');

    await this.cache.set('prs', cacheKey, pullRequests);

    return pullRequests.filter((pr) => this.shouldIncludeRepo(pr.repoFullName, username));
  }

  private async fetchPRsFromOrgRepos(
    username: string,
    since: string,
    until: string,
    excludeRepos: Set<string>,
  ): Promise<PullRequest[]> {
    const allPRs: PullRequest[] = [];

    // Skip if scope is personal-only
    if (this.options.scope === 'personal') return allPRs;

    if (this.options.repos && this.options.repos.length > 0) return allPRs;

    let orgsToCheck: GitHubOrganization[] = [];

    if (this.options.orgs && this.options.orgs.length > 0) {
      orgsToCheck = this.options.orgs.map((login) => ({
        login,
        id: 0,
        url: '',
        repos_url: '',
        description: null,
      }));
    } else {
      orgsToCheck = await this.listUserOrganizations();
    }

    if (orgsToCheck.length === 0) return allPRs;

    this.log(`  Checking ${orgsToCheck.length} organization(s) for additional PRs...`);

    for (const org of orgsToCheck) {
      const orgRepos = await this.listOrgRepositories(org.login);

      const uncheckedRepos = orgRepos.filter(
        (r) => !excludeRepos.has(r.fullName) && this.shouldIncludeRepo(r.fullName, username)
      );

      if (uncheckedRepos.length === 0) continue;

      this.log(`    Checking ${uncheckedRepos.length} repos in ${org.login}...`);

      for (const repo of uncheckedRepos) {
        try {
          const prs = await this.listMergedPRs(username, repo.fullName, since, until, false);
          if (prs.length > 0) {
            this.log(`      Found ${prs.length} PRs in ${repo.fullName}`);
            allPRs.push(...prs);
          }
        } catch {
          // Skip
        }
      }
    }

    return allPRs;
  }

  private async fetchPRsFromSpecificRepos(
    username: string,
    since: string,
    until: string,
  ): Promise<PullRequest[]> {
    const repos = this.options.repos;
    if (!repos || repos.length === 0) return [];

    this.log(`  Fetching PRs from ${repos.length} specified repo(s)...`);
    const allPRs: PullRequest[] = [];

    for (const repoFullName of repos) {
      if (this.options.excludeRepos?.includes(repoFullName)) continue;

      try {
        this.log(`    Checking ${repoFullName}...`);
        const prs = await this.listMergedPRs(username, repoFullName, since, until, false);
        if (prs.length > 0) {
          this.log(`      Found ${prs.length} PRs`);
          allPRs.push(...prs);
        }
      } catch {
        this.log(`      Could not access ${repoFullName}`);
      }
    }

    return allPRs;
  }

  async fetchAllMergedPRs(username: string, since: string, until: string): Promise<PullRequest[]> {
    this.log(`Fetching contributions for ${username}...`);
    this.log(`  Period: ${since} to ${until}`);

    let allPRs: PullRequest[] = [];

    if (this.options.repos && this.options.repos.length > 0) {
      allPRs = await this.fetchPRsFromSpecificRepos(username, since, until);
    } else {
      const searchPRs = await this.fetchPRsViaGlobalSearch(username, since, until);
      this.log(`  Found ${searchPRs.length} PRs via search`);

      // Only scan org repos if not skipped
      if (!this.options.skipOrgScan) {
        const foundRepos = new Set(searchPRs.map((pr) => pr.repoFullName));
        const orgPRs = await this.fetchPRsFromOrgRepos(username, since, until, foundRepos);

        if (orgPRs.length > 0) {
          this.log(`  Found ${orgPRs.length} additional PRs from org repos`);
        }

        allPRs = [...searchPRs, ...orgPRs];
      } else {
        this.log(`  Skipping org repo scan (--fast mode)`);
        allPRs = searchPRs;
      }
    }

    const uniquePRs = new Map<string, PullRequest>();
    for (const pr of allPRs) {
      const key = `${pr.repoFullName}#${pr.number}`;
      if (!uniquePRs.has(key)) {
        uniquePRs.set(key, pr);
      }
    }

    const result = Array.from(uniquePRs.values());

    const repoSet = new Set(result.map((pr) => pr.repoFullName));
    this.log(`\nTotal: ${result.length} merged PRs across ${repoSet.size} repositories`);

    result.sort((a, b) => new Date(a.mergedAt).getTime() - new Date(b.mergedAt).getTime());

    return result;
  }
}
