/**
 * Feature summarizer using LLM
 * Extracts feature information from pull requests
 */

import type { PullRequest, Feature, FeatureType, ConfidenceLevel } from '../domain/models';
import type { LLMClient } from './client';

/**
 * Interface for feature summarization
 */
export interface FeatureSummarizer {
  summarize(pr: PullRequest): Promise<Feature>;
  summarizeBatch(prs: PullRequest[]): Promise<Feature[]>;
}

/**
 * System prompt for single PR feature extraction
 */
const SYSTEM_PROMPT = `You are an expert at analyzing pull requests and extracting the shipped features or changes.

Your task is to analyze the provided pull request information and return a JSON object describing the feature or change that was delivered.

Respond ONLY with a valid JSON object in the following format:
{
  "title": "A concise title for the feature (max 10 words)",
  "description": "A 1-2 sentence description of what was delivered and its impact",
  "type": "feature" | "enhancement" | "bugfix" | "infra" | "refactor",
  "confidence": "high" | "medium" | "low"
}

Guidelines for the "type" field:
- "feature": A new user-facing capability or functionality
- "enhancement": An improvement to an existing feature
- "bugfix": A fix for a bug or issue
- "infra": Infrastructure, tooling, CI/CD, or developer experience improvements
- "refactor": Code restructuring without functional changes

Guidelines for the "confidence" field:
- "high": The PR clearly delivers a specific feature/change that can be articulated
- "medium": The PR delivers something but the exact impact is somewhat unclear
- "low": The PR is hard to summarize or is purely internal/refactoring

Do NOT include any text outside the JSON object. Do NOT use markdown code blocks.`;

/**
 * System prompt for batch PR feature extraction
 */
const BATCH_SYSTEM_PROMPT = `You are an expert at analyzing pull requests and extracting the shipped features or changes.

You will be given multiple pull requests. For EACH PR, return a JSON object describing the feature or change.

Return a JSON array with one object per PR, in the SAME ORDER as the input. Each object should have:
{
  "pr_number": <the PR number>,
  "title": "A concise title for the feature (max 10 words)",
  "description": "A 1-2 sentence description of what was delivered and its impact",
  "type": "feature" | "enhancement" | "bugfix" | "infra" | "refactor",
  "confidence": "high" | "medium" | "low"
}

Guidelines for the "type" field:
- "feature": A new user-facing capability or functionality
- "enhancement": An improvement to an existing feature
- "bugfix": A fix for a bug or issue
- "infra": Infrastructure, tooling, CI/CD, or developer experience improvements
- "refactor": Code restructuring without functional changes

Guidelines for the "confidence" field:
- "high": The PR clearly delivers a specific feature/change that can be articulated
- "medium": The PR delivers something but the exact impact is somewhat unclear
- "low": The PR is hard to summarize or is purely internal/refactoring

Respond ONLY with a valid JSON array. Do NOT use markdown code blocks.`;

/**
 * Build context string from PR data for LLM
 */
function buildPRContext(pr: PullRequest, includeNumber = false): string {
  const parts: string[] = [];

  if (includeNumber) {
    parts.push(`## PR #${pr.number} (${pr.repoFullName})`);
  } else {
    parts.push(`## Pull Request #${pr.number}`);
    parts.push(`Repository: ${pr.repoFullName}`);
  }
  parts.push(`Title: ${pr.title}`);
  parts.push(`Base Branch: ${pr.baseBranch}`);
  parts.push(`Merged: ${pr.mergedAt}`);

  if (pr.body && pr.body.trim()) {
    // Truncate body to save tokens
    const body = pr.body.slice(0, 1000);
    parts.push(`\nDescription: ${body}${pr.body.length > 1000 ? '...' : ''}`);
  }

  if (pr.commits.length > 0) {
    parts.push('\nCommit Messages:');
    // Include up to 10 commits to save tokens
    const commits = pr.commits.slice(0, 10);
    for (const commit of commits) {
      const firstLine = commit.message.split('\n')[0] ?? commit.message;
      parts.push(`- ${firstLine}`);
    }
    if (pr.commits.length > 10) {
      parts.push(`... and ${pr.commits.length - 10} more commits`);
    }
  }

  return parts.join('\n');
}

/**
 * Build context for multiple PRs
 */
function buildBatchContext(prs: PullRequest[]): string {
  return prs.map((pr) => buildPRContext(pr, true)).join('\n\n---\n\n');
}

/**
 * Parse LLM response into Feature object
 */
function parseFeatureResponse(
  response: string,
  pr: PullRequest
): Omit<Feature, 'project' | 'prs' | 'startDate' | 'endDate'> {
  // Try to extract JSON from the response
  let jsonStr = response.trim();

  // Handle case where LLM wraps in code blocks
  const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (codeBlockMatch?.[1]) {
    jsonStr = codeBlockMatch[1];
  }

  try {
    const parsed = JSON.parse(jsonStr) as {
      title?: string;
      description?: string;
      type?: string;
      confidence?: string;
    };

    // Validate and normalize the response
    const validTypes: FeatureType[] = ['feature', 'enhancement', 'bugfix', 'infra', 'refactor'];
    const validConfidence: ConfidenceLevel[] = ['high', 'medium', 'low'];

    const type = validTypes.includes(parsed.type as FeatureType)
      ? (parsed.type as FeatureType)
      : 'feature';

    const confidence = validConfidence.includes(parsed.confidence as ConfidenceLevel)
      ? (parsed.confidence as ConfidenceLevel)
      : 'medium';

    return {
      title: parsed.title || pr.title,
      description: parsed.description || `Merged PR #${pr.number}: ${pr.title}`,
      type,
      confidence,
    };
  } catch {
    // If parsing fails, create a fallback feature
    return {
      title: pr.title,
      description: `Merged PR #${pr.number}: ${pr.title}`,
      type: 'feature',
      confidence: 'low',
    };
  }
}

/**
 * Parse batch LLM response into Feature objects
 */
function parseBatchResponse(
  response: string,
  prs: PullRequest[]
): Map<number, Omit<Feature, 'project' | 'prs' | 'startDate' | 'endDate'>> {
  const results = new Map<number, Omit<Feature, 'project' | 'prs' | 'startDate' | 'endDate'>>();

  let jsonStr = response.trim();

  // Handle case where LLM wraps in code blocks
  const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (codeBlockMatch?.[1]) {
    jsonStr = codeBlockMatch[1];
  }

  try {
    const parsed = JSON.parse(jsonStr) as Array<{
      pr_number?: number;
      title?: string;
      description?: string;
      type?: string;
      confidence?: string;
    }>;

    if (!Array.isArray(parsed)) {
      throw new Error('Response is not an array');
    }

    const validTypes: FeatureType[] = ['feature', 'enhancement', 'bugfix', 'infra', 'refactor'];
    const validConfidence: ConfidenceLevel[] = ['high', 'medium', 'low'];

    for (const item of parsed) {
      if (!item.pr_number) continue;

      const type = validTypes.includes(item.type as FeatureType)
        ? (item.type as FeatureType)
        : 'feature';

      const confidence = validConfidence.includes(item.confidence as ConfidenceLevel)
        ? (item.confidence as ConfidenceLevel)
        : 'medium';

      results.set(item.pr_number, {
        title: item.title || `PR #${item.pr_number}`,
        description: item.description || `Merged PR #${item.pr_number}`,
        type,
        confidence,
      });
    }
  } catch {
    // Parsing failed, results will be empty
  }

  return results;
}

/**
 * Create fallback feature for a PR
 */
function createFallbackFeature(pr: PullRequest): Feature {
  return {
    project: pr.repoFullName,
    title: pr.title,
    description: `Merged PR #${pr.number}: ${pr.title}`,
    type: 'feature',
    prs: [pr.number],
    startDate: pr.createdAt,
    endDate: pr.mergedAt,
    confidence: 'low',
  };
}

/**
 * LLM-based feature summarizer
 */
export class LLMFeatureSummarizer implements FeatureSummarizer {
  private client: LLMClient;

  constructor(client: LLMClient) {
    this.client = client;
  }

  /**
   * Summarize a single PR into a feature
   */
  async summarize(pr: PullRequest): Promise<Feature> {
    const context = buildPRContext(pr);

    try {
      const response = await this.client.complete(context, {
        systemPrompt: SYSTEM_PROMPT,
        temperature: 0.3,
        maxTokens: 512,
      });

      const parsed = parseFeatureResponse(response, pr);

      return {
        ...parsed,
        project: pr.repoFullName,
        prs: [pr.number],
        startDate: pr.createdAt,
        endDate: pr.mergedAt,
      };
    } catch (error) {
      console.warn(`LLM error for PR #${pr.number}: ${error}`);
      return createFallbackFeature(pr);
    }
  }

  /**
   * Summarize multiple PRs in a single LLM call
   */
  async summarizeBatch(prs: PullRequest[]): Promise<Feature[]> {
    if (prs.length === 0) return [];
    if (prs.length === 1) return [await this.summarize(prs[0]!)];

    const context = buildBatchContext(prs);

    try {
      const response = await this.client.complete(context, {
        systemPrompt: BATCH_SYSTEM_PROMPT,
        temperature: 0.3,
        maxTokens: 1024 + prs.length * 200, // Scale tokens with batch size
      });

      const parsedMap = parseBatchResponse(response, prs);

      // Build features, using fallbacks for any PRs not in the response
      return prs.map((pr) => {
        const parsed = parsedMap.get(pr.number);
        if (parsed) {
          return {
            ...parsed,
            project: pr.repoFullName,
            prs: [pr.number],
            startDate: pr.createdAt,
            endDate: pr.mergedAt,
          };
        }
        return createFallbackFeature(pr);
      });
    } catch (error) {
      console.warn(`Batch LLM error, falling back to individual calls: ${error}`);
      // Fall back to individual calls
      const features: Feature[] = [];
      for (const pr of prs) {
        features.push(await this.summarize(pr));
      }
      return features;
    }
  }
}

/**
 * Summarize PRs one at a time with progress callback
 */
export async function summarizePRs(
  prs: PullRequest[],
  summarizer: FeatureSummarizer,
  onProgress?: (current: number, total: number) => void
): Promise<Feature[]> {
  const features: Feature[] = [];

  for (let i = 0; i < prs.length; i++) {
    const pr = prs[i];
    if (!pr) continue;

    if (onProgress) {
      onProgress(i + 1, prs.length);
    }

    const feature = await summarizer.summarize(pr);
    features.push(feature);

    // Small delay to avoid rate limiting
    if (i < prs.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  return features;
}

/**
 * Summarize PRs in batches with progress callback
 * More efficient - reduces LLM API calls
 */
export async function summarizePRsBatch(
  prs: PullRequest[],
  summarizer: FeatureSummarizer,
  batchSize = 5,
  onProgress?: (current: number, total: number) => void
): Promise<Feature[]> {
  const features: Feature[] = [];
  const batches: PullRequest[][] = [];

  // Split into batches
  for (let i = 0; i < prs.length; i += batchSize) {
    batches.push(prs.slice(i, i + batchSize));
  }

  let processed = 0;

  for (const batch of batches) {
    const batchFeatures = await summarizer.summarizeBatch(batch);
    features.push(...batchFeatures);

    processed += batch.length;
    if (onProgress) {
      onProgress(processed, prs.length);
    }

    // Small delay between batches to avoid rate limiting
    if (processed < prs.length) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  return features;
}
