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
  // Set until to end of day
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
 * GitHub API client for fetching user activity
 */
export class GitHubClient {
  private token: string;
  private requestCount = 0;
  private lastRequestTime = 0;
  private readonly minRequestInterval = 100; // Minimum ms between requests

  constructor(token: string) {
    this.token = token;
  }

  /**
   * Rate limit: ensure minimum time between requests
   */
  private async rateLimit(): Promise<void> {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    
    if (timeSinceLastRequest < this.minRequestInterval) {
      await sleep(this.minRequestInterval - timeSinceLastRequest);
    }
    
    this.lastRequestTime = Date.now();
    this.requestCount++;
  }

  /**
   * Make an authenticated request to GitHub API with rate limit handling
   */
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

    // Handle rate limiting
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

        // Calculate wait time
        let waitTime = 60000; // Default 1 minute
        if (rateLimitReset) {
          const resetTime = parseInt(rateLimitReset, 10) * 1000;
          waitTime = Math.max(resetTime - Date.now() + 1000, 1000);
          // Cap at 5 minutes for sanity
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
        // Ignore JSON parse errors
      }

      throw new GitHubClientError(errorMessage, response.status, endpoint);
    }

    const data = (await response.json()) as T;
    const pagination = parseLinkHeader(response.headers.get('Link'));

    return { data, pagination };
  }

  /**
   * Fetch all pages of a paginated endpoint
   */
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

  /**
   * Get all organizations the authenticated user belongs to
   */
  private async listUserOrganizations(): Promise<GitHubOrganization[]> {
    try {
      return await this.fetchAllPages<GitHubOrganization>('/user/orgs?per_page=100');
    } catch (error) {
      console.warn('  Could not fetch organizations (may need read:org scope)');
      return [];
    }
  }

  /**
   * Get all repositories from a specific organization
   */
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
    } catch (error) {
      console.warn(`  Could not fetch repos for org ${orgLogin}`);
    }

    return repos;
  }

  /**
   * Get all repositories the authenticated user has access to
   * This includes personal repos, org repos, and repos they're a collaborator on
   */
  private async listAccessibleRepositories(): Promise<Repository[]> {
    console.log('  Fetching accessible repositories...');

    const repoMap = new Map<string, Repository>();

    // Strategy 1: Fetch all repos the user has access to via /user/repos
    // Using affiliation=owner,collaborator,organization_member gets all repos
    try {
      const githubRepos = await this.fetchAllPages<GitHubRepository>(
        '/user/repos?per_page=100&affiliation=owner,collaborator,organization_member&sort=pushed&direction=desc'
      );

      for (const repo of githubRepos) {
        repoMap.set(repo.full_name, {
          id: repo.id,
          name: repo.name,
          fullName: repo.full_name,
          owner: repo.owner.login,
          url: repo.html_url,
          defaultBranch: repo.default_branch,
        });
      }
      console.log(`    Found ${githubRepos.length} repos via user/repos API`);
    } catch (error) {
      console.warn('  Could not fetch user repos');
    }

    // Strategy 2: Explicitly fetch repos from each organization the user belongs to
    // This catches repos that might not show up in /user/repos due to org settings
    const orgs = await this.listUserOrganizations();
    console.log(`    Found ${orgs.length} organizations`);

    for (const org of orgs) {
      console.log(`    Fetching repos from org: ${org.login}...`);
      const orgRepos = await this.listOrgRepositories(org.login);
      console.log(`      Found ${orgRepos.length} repos in ${org.login}`);

      for (const repo of orgRepos) {
        if (!repoMap.has(repo.fullName)) {
          repoMap.set(repo.fullName, repo);
        }
      }
    }

    return Array.from(repoMap.values());
  }

  /**
   * List repositories the user has contributed to using search API
   * This finds public repos and private repos that are indexed
   */
  private async listRepositoriesFromSearch(
    username: string,
    since: string,
    until: string,
  ): Promise<Repository[]> {
    console.log('  Searching for repositories with contributions...');

    // Use search API to find PRs by the user, then extract unique repos
    const query = `author:${username} is:pr is:merged merged:${since}..${until}`;
    const encodedQuery = encodeURIComponent(query);

    const allItems: GitHubSearchIssue[] = [];
    let page = 1;
    const perPage = 100;

    // Paginate through search results
    while (true) {
      const { data } = await this.request<GitHubSearchResponse<GitHubSearchIssue>>(
        `/search/issues?q=${encodedQuery}&per_page=${perPage}&page=${page}`,
      );

      allItems.push(...data.items);

      if (data.items.length < perPage || allItems.length >= data.total_count) {
        break;
      }

      page++;

      // Respect rate limits - small delay between search requests
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    // Extract unique repositories
    const repoMap = new Map<string, Repository>();

    for (const item of allItems) {
      // Extract owner/repo from repository_url
      const match = item.repository_url.match(/repos\/([^/]+)\/([^/]+)$/);

      if (match) {
        const [, owner, name] = match;
        if (owner && name) {
          const fullName = `${owner}/${name}`;

          if (!repoMap.has(fullName)) {
            // Fetch full repo details
            try {
              const { data: repo } = await this.request<GitHubRepository>(`/repos/${fullName}`);

              repoMap.set(fullName, {
                id: repo.id,
                name: repo.name,
                fullName: repo.full_name,
                owner: repo.owner.login,
                url: repo.html_url,
                defaultBranch: repo.default_branch,
              });
            } catch (error) {
              // Skip repos we can't access
              console.warn(`  Could not fetch repo ${fullName}: ${error}`);
            }
          }
        }
      }
    }

    return Array.from(repoMap.values());
  }

  /**
   * Fetch merged PRs for a user in a specific repository
   * Uses direct PR listing API instead of search for better coverage of private repos
   */
  async listMergedPRs(
    username: string,
    repoFullName: string,
    since: string,
    until: string,
    fetchCommits = false,
  ): Promise<PullRequest[]> {
    const pullRequests: PullRequest[] = [];

    try {
      // Fetch all closed PRs from the repository
      // We'll filter by author and date range ourselves
      const allPRs = await this.fetchAllPages<GitHubPullRequest>(
        `/repos/${repoFullName}/pulls?state=closed&sort=updated&direction=desc&per_page=100`,
      );

      for (const pr of allPRs) {
        // Skip if not merged
        if (!pr.merged_at) {
          continue;
        }

        // Skip if not by the target user
        if (pr.user.login.toLowerCase() !== username.toLowerCase()) {
          continue;
        }

        // Skip if merged outside our date range
        if (!isDateInRange(pr.merged_at, since, until)) {
          // If PR was merged before our range and we're sorted desc, we can stop
          if (new Date(pr.merged_at) < new Date(since)) {
            break;
          }
          continue;
        }

        // Skip if base branch not allowed
        if (!isAllowedBaseBranch(pr.base.ref)) {
          continue;
        }

        // Only fetch commits if explicitly requested (saves API calls)
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
    } catch (error) {
      // If we can't access the repo's PRs, try the search API as fallback
      return this.listMergedPRsViaSearch(username, repoFullName, since, until, fetchCommits);
    }

    return pullRequests;
  }

  /**
   * Fetch merged PRs using search API (fallback method)
   */
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

      if (data.items.length < perPage || allItems.length >= data.total_count) {
        break;
      }

      page++;
    }

    const pullRequests: PullRequest[] = [];

    for (const item of allItems) {
      try {
        const { data: pr } = await this.request<GitHubPullRequest>(
          `/repos/${repoFullName}/pulls/${item.number}`,
        );

        if (!pr.merged_at || !isAllowedBaseBranch(pr.base.ref)) {
          continue;
        }

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
      } catch (error) {
        console.warn(`  Could not fetch PR #${item.number}: ${error}`);
      }
    }

    return pullRequests;
  }

  /**
   * Fetch commits for a specific PR
   */
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
    } catch (error) {
      console.warn(`  Could not fetch commits for PR #${prNumber}: ${error}`);
      return [];
    }
  }

  /**
   * Fetch all merged PRs directly via search API (most efficient method)
   * This uses a single search query to find all merged PRs by the user
   */
  private async fetchPRsViaGlobalSearch(
    username: string,
    since: string,
    until: string,
  ): Promise<PullRequest[]> {
    console.log('  Searching for all merged PRs via global search...');

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
      console.log(`    Found ${allItems.length}/${data.total_count} PRs...`);

      if (data.items.length < perPage || allItems.length >= data.total_count) {
        break;
      }

      page++;
    }

    // Convert search results to PullRequests
    // We need to fetch full PR details for base branch info
    const pullRequests: PullRequest[] = [];
    const seenPRs = new Set<string>();

    for (let i = 0; i < allItems.length; i++) {
      const item = allItems[i]!;
      
      // Extract repo from URL
      const match = item.repository_url.match(/repos\/([^/]+\/[^/]+)$/);
      if (!match) continue;

      const repoFullName = match[1]!;
      const prKey = `${repoFullName}#${item.number}`;
      
      if (seenPRs.has(prKey)) continue;
      seenPRs.add(prKey);

      process.stdout.write(`\r  Fetching PR details: ${i + 1}/${allItems.length}...`.padEnd(60));

      try {
        const { data: pr } = await this.request<GitHubPullRequest>(
          `/repos/${repoFullName}/pulls/${item.number}`,
        );

        if (!pr.merged_at || !isAllowedBaseBranch(pr.base.ref)) {
          continue;
        }

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
          commits: [], // Skip commits to save API calls
        });
      } catch (error) {
        // Skip PRs we can't access
      }
    }

    process.stdout.write('\r'.padEnd(60) + '\r');
    return pullRequests;
  }

  /**
   * Fetch PRs from organization repos that might not be indexed in search
   */
  private async fetchPRsFromOrgRepos(
    username: string,
    since: string,
    until: string,
    excludeRepos: Set<string>,
  ): Promise<PullRequest[]> {
    const allPRs: PullRequest[] = [];

    // Get organizations
    const orgs = await this.listUserOrganizations();
    if (orgs.length === 0) {
      return allPRs;
    }

    console.log(`  Checking ${orgs.length} organization(s) for additional PRs...`);

    for (const org of orgs) {
      const orgRepos = await this.listOrgRepositories(org.login);
      
      // Filter to repos we haven't already checked
      const uncheckedRepos = orgRepos.filter((r) => !excludeRepos.has(r.fullName));
      
      if (uncheckedRepos.length === 0) continue;

      console.log(`    Checking ${uncheckedRepos.length} repos in ${org.login}...`);

      for (const repo of uncheckedRepos) {
        try {
          const prs = await this.listMergedPRs(username, repo.fullName, since, until, false);
          if (prs.length > 0) {
            console.log(`      Found ${prs.length} PRs in ${repo.fullName}`);
            allPRs.push(...prs);
          }
        } catch {
          // Skip repos we can't access
        }
      }
    }

    return allPRs;
  }

  /**
   * Fetch all merged PRs for a user across all their contributed repos
   * Uses efficient search-first strategy to minimize API calls
   */
  async fetchAllMergedPRs(username: string, since: string, until: string): Promise<PullRequest[]> {
    console.log(`Fetching contributions for ${username}...`);
    console.log(`  Period: ${since} to ${until}`);

    // Strategy 1: Use global search API (most efficient - finds most public and indexed private repos)
    const searchPRs = await this.fetchPRsViaGlobalSearch(username, since, until);
    console.log(`  Found ${searchPRs.length} PRs via search`);

    // Track which repos we've already found PRs in
    const foundRepos = new Set(searchPRs.map((pr) => pr.repoFullName));

    // Strategy 2: Check org repos that might not be indexed in search
    const orgPRs = await this.fetchPRsFromOrgRepos(username, since, until, foundRepos);
    
    if (orgPRs.length > 0) {
      console.log(`  Found ${orgPRs.length} additional PRs from org repos`);
    }

    // Merge and deduplicate
    const allPRs = [...searchPRs, ...orgPRs];
    const uniquePRs = new Map<string, PullRequest>();
    for (const pr of allPRs) {
      const key = `${pr.repoFullName}#${pr.number}`;
      if (!uniquePRs.has(key)) {
        uniquePRs.set(key, pr);
      }
    }

    const result = Array.from(uniquePRs.values());

    // Count unique repos
    const repoSet = new Set(result.map((pr) => pr.repoFullName));
    console.log(`\nTotal: ${result.length} merged PRs across ${repoSet.size} repositories`);

    // Sort by merged date
    result.sort((a, b) => new Date(a.mergedAt).getTime() - new Date(b.mergedAt).getTime());

    return result;
  }
}
