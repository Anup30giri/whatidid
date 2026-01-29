/**
 * Feature grouping logic
 * Groups features by repository and merges similar features
 */

import type { Feature, ProjectSummary } from './models';

/**
 * Calculate simple token-based similarity between two strings
 * Returns a value between 0 and 1
 */
function calculateSimilarity(str1: string, str2: string): number {
  const normalize = (s: string): string[] =>
    s
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter((word) => word.length > 2);

  const tokens1 = new Set(normalize(str1));
  const tokens2 = new Set(normalize(str2));

  if (tokens1.size === 0 || tokens2.size === 0) {
    return 0;
  }

  // Calculate Jaccard similarity
  const intersection = new Set([...tokens1].filter((x) => tokens2.has(x)));
  const union = new Set([...tokens1, ...tokens2]);

  return intersection.size / union.size;
}

/**
 * Calculate Levenshtein distance between two strings
 */
function levenshteinDistance(str1: string, str2: string): number {
  const m = str1.length;
  const n = str2.length;

  // Create a matrix
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    Array.from({ length: n + 1 }, () => 0)
  );

  // Initialize first column and row
  for (let i = 0; i <= m; i++) {
    dp[i]![0] = i;
  }
  for (let j = 0; j <= n; j++) {
    dp[0]![j] = j;
  }

  // Fill the matrix
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = str1[i - 1] === str2[j - 1] ? 0 : 1;
      dp[i]![j] = Math.min(
        dp[i - 1]![j]! + 1, // deletion
        dp[i]![j - 1]! + 1, // insertion
        dp[i - 1]![j - 1]! + cost // substitution
      );
    }
  }

  return dp[m]![n]!;
}

/**
 * Calculate normalized Levenshtein similarity (0 to 1)
 */
function levenshteinSimilarity(str1: string, str2: string): number {
  const maxLen = Math.max(str1.length, str2.length);
  if (maxLen === 0) return 1;

  const distance = levenshteinDistance(
    str1.toLowerCase(),
    str2.toLowerCase()
  );

  return 1 - distance / maxLen;
}

/**
 * Calculate combined similarity score
 */
function featureSimilarity(f1: Feature, f2: Feature): number {
  // Must be same project
  if (f1.project !== f2.project) {
    return 0;
  }

  // Must be same type
  if (f1.type !== f2.type) {
    return 0;
  }

  // Calculate title similarity using both methods
  const tokenSim = calculateSimilarity(f1.title, f2.title);
  const levenSim = levenshteinSimilarity(f1.title, f2.title);

  // Use weighted average
  return tokenSim * 0.6 + levenSim * 0.4;
}

/**
 * Merge two features into one
 */
function mergeFeatures(f1: Feature, f2: Feature): Feature {
  // Use the feature with higher confidence as the base
  const base = f1.confidence === 'high' || f2.confidence === 'low' ? f1 : f2;

  // Combine PR numbers
  const allPRs = [...new Set([...f1.prs, ...f2.prs])].sort((a, b) => a - b);

  // Expand date range
  const startDate =
    new Date(f1.startDate) < new Date(f2.startDate) ? f1.startDate : f2.startDate;
  const endDate =
    new Date(f1.endDate) > new Date(f2.endDate) ? f1.endDate : f2.endDate;

  // Determine confidence (merged features are slightly less confident)
  let confidence = base.confidence;
  if (f1.confidence !== f2.confidence) {
    confidence = 'medium';
  }

  return {
    project: base.project,
    title: base.title,
    description: base.description,
    type: base.type,
    prs: allPRs,
    startDate,
    endDate,
    confidence,
  };
}

/**
 * Group features by repository
 */
function groupByRepository(features: Feature[]): Map<string, Feature[]> {
  const groups = new Map<string, Feature[]>();

  for (const feature of features) {
    const existing = groups.get(feature.project);
    if (existing) {
      existing.push(feature);
    } else {
      groups.set(feature.project, [feature]);
    }
  }

  return groups;
}

/**
 * Merge similar features within a group
 * Uses simple clustering based on similarity threshold
 */
function mergeSimilarFeatures(
  features: Feature[],
  similarityThreshold = 0.5
): Feature[] {
  if (features.length <= 1) {
    return features;
  }

  // Create a copy we can modify
  const remaining = [...features];
  const merged: Feature[] = [];

  while (remaining.length > 0) {
    // Take the first feature
    let current = remaining.shift()!;

    // Find all similar features
    let i = 0;
    while (i < remaining.length) {
      const candidate = remaining[i]!;
      const similarity = featureSimilarity(current, candidate);

      if (similarity >= similarityThreshold) {
        // Merge and remove from remaining
        current = mergeFeatures(current, candidate);
        remaining.splice(i, 1);
      } else {
        i++;
      }
    }

    merged.push(current);
  }

  return merged;
}

/**
 * Sort features chronologically by end date
 */
function sortFeatures(features: Feature[]): Feature[] {
  return [...features].sort(
    (a, b) => new Date(a.endDate).getTime() - new Date(b.endDate).getTime()
  );
}

/**
 * Group and merge features, creating project summaries
 */
export function groupFeatures(features: Feature[]): ProjectSummary[] {
  // Group by repository
  const repoGroups = groupByRepository(features);

  const summaries: ProjectSummary[] = [];

  for (const [repoFullName, repoFeatures] of repoGroups) {
    // Merge similar features
    const mergedFeatures = mergeSimilarFeatures(repoFeatures);

    // Sort chronologically
    const sortedFeatures = sortFeatures(mergedFeatures);

    // Calculate date range and PR count
    let startDate = '';
    let endDate = '';
    const allPRs = new Set<number>();

    for (const feature of sortedFeatures) {
      if (!startDate || new Date(feature.startDate) < new Date(startDate)) {
        startDate = feature.startDate;
      }
      if (!endDate || new Date(feature.endDate) > new Date(endDate)) {
        endDate = feature.endDate;
      }
      for (const pr of feature.prs) {
        allPRs.add(pr);
      }
    }

    const repoName = repoFullName.split('/')[1] ?? repoFullName;

    summaries.push({
      repoName,
      repoFullName,
      features: sortedFeatures,
      startDate,
      endDate,
      totalPRs: allPRs.size,
    });
  }

  // Sort project summaries by start date
  summaries.sort(
    (a, b) => new Date(a.startDate).getTime() - new Date(b.startDate).getTime()
  );

  return summaries;
}

/**
 * Calculate statistics from project summaries
 */
export function calculateStats(summaries: ProjectSummary[]): {
  totalPRs: number;
  totalFeatures: number;
  featuresByType: Record<string, number>;
} {
  let totalPRs = 0;
  let totalFeatures = 0;
  const featuresByType: Record<string, number> = {};

  for (const summary of summaries) {
    totalPRs += summary.totalPRs;
    totalFeatures += summary.features.length;

    for (const feature of summary.features) {
      featuresByType[feature.type] = (featuresByType[feature.type] ?? 0) + 1;
    }
  }

  return {
    totalPRs,
    totalFeatures,
    featuresByType,
  };
}
