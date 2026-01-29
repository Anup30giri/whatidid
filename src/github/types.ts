/**
 * GitHub API response types
 * These types represent the raw responses from GitHub's REST API
 */

/**
 * GitHub user object (simplified)
 */
export interface GitHubUser {
  login: string;
  id: number;
  avatar_url: string;
  html_url: string;
}

/**
 * GitHub repository owner
 */
export interface GitHubOwner {
  login: string;
  id: number;
  type: string;
}

/**
 * GitHub organization
 */
export interface GitHubOrganization {
  login: string;
  id: number;
  url: string;
  repos_url: string;
  description: string | null;
}

/**
 * GitHub repository response
 */
export interface GitHubRepository {
  id: number;
  name: string;
  full_name: string;
  owner: GitHubOwner;
  html_url: string;
  default_branch: string;
  private: boolean;
  fork: boolean;
}

/**
 * GitHub pull request head/base reference
 */
export interface GitHubRef {
  ref: string;
  sha: string;
  repo: GitHubRepository | null;
}

/**
 * GitHub pull request response
 */
export interface GitHubPullRequest {
  id: number;
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  state: 'open' | 'closed';
  user: GitHubUser;
  base: GitHubRef;
  head: GitHubRef;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  merged_at: string | null;
  merge_commit_sha: string | null;
}

/**
 * GitHub commit author/committer
 */
export interface GitHubCommitAuthor {
  name: string;
  email: string;
  date: string;
}

/**
 * GitHub commit details
 */
export interface GitHubCommitDetails {
  author: GitHubCommitAuthor;
  committer: GitHubCommitAuthor;
  message: string;
}

/**
 * GitHub commit response
 */
export interface GitHubCommit {
  sha: string;
  commit: GitHubCommitDetails;
  html_url: string;
  author: GitHubUser | null;
  committer: GitHubUser | null;
}

/**
 * GitHub search response for issues/PRs
 */
export interface GitHubSearchResponse<T> {
  total_count: number;
  incomplete_results: boolean;
  items: T[];
}

/**
 * GitHub issue/PR from search results
 */
export interface GitHubSearchIssue {
  id: number;
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  state: string;
  user: GitHubUser;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  pull_request?: {
    url: string;
    html_url: string;
    merged_at: string | null;
  };
  repository_url: string;
}

/**
 * GitHub API error response
 */
export interface GitHubError {
  message: string;
  documentation_url?: string;
  errors?: Array<{
    resource: string;
    field: string;
    code: string;
  }>;
}

/**
 * Pagination info from Link header
 */
export interface PaginationInfo {
  next?: string;
  prev?: string;
  first?: string;
  last?: string;
}
