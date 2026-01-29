/**
 * Domain models for the whatidid CLI tool
 */

/**
 * Represents a GitHub repository
 */
export interface Repository {
  id: number;
  name: string;
  fullName: string;
  owner: string;
  url: string;
  defaultBranch: string;
}

/**
 * Represents a commit in a pull request
 */
export interface Commit {
  sha: string;
  message: string;
  author: string;
  date: string;
}

/**
 * Represents a GitHub pull request
 */
export interface PullRequest {
  number: number;
  title: string;
  body: string | null;
  url: string;
  repoName: string;
  repoFullName: string;
  baseBranch: string;
  createdAt: string;
  mergedAt: string;
  commits: Commit[];
}

/**
 * Type of feature/change delivered
 */
export type FeatureType = 'feature' | 'enhancement' | 'bugfix' | 'infra' | 'refactor';

/**
 * Confidence level of the feature extraction
 */
export type ConfidenceLevel = 'high' | 'medium' | 'low';

/**
 * Represents an extracted feature from one or more PRs
 */
export interface Feature {
  project: string;
  title: string;
  description: string;
  type: FeatureType;
  prs: number[];
  startDate: string;
  endDate: string;
  confidence: ConfidenceLevel;
}

/**
 * Summary of features for a single project/repository
 */
export interface ProjectSummary {
  repoName: string;
  repoFullName: string;
  features: Feature[];
  startDate: string;
  endDate: string;
  totalPRs: number;
}

/**
 * Complete impact report containing all project summaries
 */
export interface ImpactReport {
  username: string;
  since: string;
  until: string;
  generatedAt: string;
  projects: ProjectSummary[];
  totalPRs: number;
  totalFeatures: number;
}
