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
}

/**
 * System prompt for feature extraction
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
 * Build context string from PR data for LLM
 */
function buildPRContext(pr: PullRequest): string {
  const parts: string[] = [];

  parts.push(`## Pull Request #${pr.number}`);
  parts.push(`Repository: ${pr.repoFullName}`);
  parts.push(`Title: ${pr.title}`);
  parts.push(`Base Branch: ${pr.baseBranch}`);
  parts.push(`Merged: ${pr.mergedAt}`);

  if (pr.body && pr.body.trim()) {
    parts.push(`\n### Description\n${pr.body.slice(0, 2000)}`);
  }

  if (pr.commits.length > 0) {
    parts.push('\n### Commit Messages');
    // Include up to 20 commits to avoid token limits
    const commits = pr.commits.slice(0, 20);
    for (const commit of commits) {
      // Take first line of commit message
      const firstLine = commit.message.split('\n')[0] ?? commit.message;
      parts.push(`- ${firstLine}`);
    }
    if (pr.commits.length > 20) {
      parts.push(`... and ${pr.commits.length - 20} more commits`);
    }
  }

  return parts.join('\n');
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
    console.warn(`Failed to parse LLM response for PR #${pr.number}, using fallback`);
    return {
      title: pr.title,
      description: `Merged PR #${pr.number}: ${pr.title}`,
      type: 'feature',
      confidence: 'low',
    };
  }
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
   * Summarize a PR into a feature
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

      // Return a fallback feature
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
  }
}

/**
 * Batch summarize multiple PRs with progress callback
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
