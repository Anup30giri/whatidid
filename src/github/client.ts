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
  PaginationInfo,
} from './types';

const GITHUB_API_BASE = 'https://api.github.com';

export class GitHubClientError extends Error {
  constructor(
    message: string,
    public statusCode?: number,
    public endpoint?: string
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
 * GitHub API client for fetching user activity
 */
export class GitHubClient {
  private token: string;

  constructor(token: string) {
    this.token = token;
  }

  /**
   * Make an authenticated request to GitHub API
   */
  private async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<{ data: T; pagination: PaginationInfo }> {
    const url = endpoint.startsWith('http')
      ? endpoint
      : `${GITHUB_API_BASE}${endpoint}`;

    const response = await fetch(url, {
      ...options,
      headers: {
        Accept: 'application/vnd.github.v3+json',
        Authorization: `Bearer ${this.token}`,
        'User-Agent': 'whatidid-cli',
        ...options.headers,
      },
    });

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
   * List repositories the user has contributed to
   * Uses search API to find repos with user's PRs
   */
  async listUserRepositories(
    username: string,
    since: string,
    until: string
  ): Promise<Repository[]> {
    // Use search API to find PRs by the user, then extract unique repos
    const query = `author:${username} is:pr is:merged merged:${since}..${until}`;
    const encodedQuery = encodeURIComponent(query);

    const allItems: GitHubSearchIssue[] = [];
    let page = 1;
    const perPage = 100;

    // Paginate through search results
    while (true) {
      const { data } = await this.request<GitHubSearchResponse<GitHubSearchIssue>>(
        `/search/issues?q=${encodedQuery}&per_page=${perPage}&page=${page}`
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
      const match = item.repository_url.match(
        /repos\/([^/]+)\/([^/]+)$/
      );

      if (match) {
        const [, owner, name] = match;
        if (owner && name) {
          const fullName = `${owner}/${name}`;

          if (!repoMap.has(fullName)) {
            // Fetch full repo details
            try {
              const { data: repo } = await this.request<GitHubRepository>(
                `/repos/${fullName}`
              );

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
              console.warn(`Could not fetch repo ${fullName}: ${error}`);
            }
          }
        }
      }
    }

    return Array.from(repoMap.values());
  }

  /**
   * Fetch merged PRs for a user in a specific repository
   */
  async listMergedPRs(
    username: string,
    repoFullName: string,
    since: string,
    until: string
  ): Promise<PullRequest[]> {
    // Use search to find merged PRs by the user in this repo
    const query = `repo:${repoFullName} author:${username} is:pr is:merged merged:${since}..${until}`;
    const encodedQuery = encodeURIComponent(query);

    const allItems: GitHubSearchIssue[] = [];
    let page = 1;
    const perPage = 100;

    while (true) {
      const { data } = await this.request<GitHubSearchResponse<GitHubSearchIssue>>(
        `/search/issues?q=${encodedQuery}&per_page=${perPage}&page=${page}`
      );

      allItems.push(...data.items);

      if (data.items.length < perPage || allItems.length >= data.total_count) {
        break;
      }

      page++;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    // Fetch full PR details including base branch and commits
    const pullRequests: PullRequest[] = [];

    for (const item of allItems) {
      try {
        // Fetch full PR details
        const { data: pr } = await this.request<GitHubPullRequest>(
          `/repos/${repoFullName}/pulls/${item.number}`
        );

        // Skip if not merged or base branch not allowed
        if (!pr.merged_at || !isAllowedBaseBranch(pr.base.ref)) {
          continue;
        }

        // Fetch commits for this PR
        const commits = await this.fetchPRCommits(repoFullName, pr.number);

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
        console.warn(`Could not fetch PR #${item.number}: ${error}`);
      }
    }

    return pullRequests;
  }

  /**
   * Fetch commits for a specific PR
   */
  private async fetchPRCommits(
    repoFullName: string,
    prNumber: number
  ): Promise<Commit[]> {
    try {
      const commits = await this.fetchAllPages<GitHubCommit>(
        `/repos/${repoFullName}/pulls/${prNumber}/commits?per_page=100`
      );

      return commits.map((commit) => ({
        sha: commit.sha,
        message: commit.commit.message,
        author: commit.commit.author.name,
        date: commit.commit.author.date,
      }));
    } catch (error) {
      console.warn(`Could not fetch commits for PR #${prNumber}: ${error}`);
      return [];
    }
  }

  /**
   * Fetch all merged PRs for a user across all their contributed repos
   */
  async fetchAllMergedPRs(
    username: string,
    since: string,
    until: string
  ): Promise<PullRequest[]> {
    console.log(`Fetching repositories for ${username}...`);
    const repos = await this.listUserRepositories(username, since, until);
    console.log(`Found ${repos.length} repositories with contributions`);

    const allPRs: PullRequest[] = [];

    for (const repo of repos) {
      console.log(`Fetching PRs from ${repo.fullName}...`);
      const prs = await this.listMergedPRs(username, repo.fullName, since, until);
      console.log(`  Found ${prs.length} merged PRs`);
      allPRs.push(...prs);
    }

    // Sort by merged date
    allPRs.sort((a, b) => 
      new Date(a.mergedAt).getTime() - new Date(b.mergedAt).getTime()
    );

    return allPRs;
  }
}
