/**
 * CLI command definitions and orchestration
 * Uses commander for argument parsing
 */

import { Command } from 'commander';
import { loadConfig, validateConfig, ConfigError } from './config';
import { GitHubClient, GitHubClientError } from './github/client';
import { createLLMClient, LLMClientError } from './llm/client';
import { LLMFeatureSummarizer, summarizePRs } from './llm/summarizer';
import { groupFeatures, calculateStats } from './domain/grouping';
import { writeReport } from './report/markdown';
import type { ImpactReport } from './domain/models';

/**
 * Validate date format (YYYY-MM-DD)
 */
function isValidDate(dateStr: string): boolean {
  const regex = /^\d{4}-\d{2}-\d{2}$/;
  if (!regex.test(dateStr)) {
    return false;
  }

  const date = new Date(dateStr);
  return !isNaN(date.getTime());
}

/**
 * Parse and validate a date option
 */
function parseDate(value: string, name: string): string {
  if (!isValidDate(value)) {
    throw new Error(`Invalid date format for ${name}: "${value}". Expected YYYY-MM-DD.`);
  }
  return value;
}

/**
 * Create the CLI program
 */
export function createProgram(): Command {
  const program = new Command();

  program
    .name('whatidid')
    .description('Generate engineering impact reports from GitHub activity')
    .version('1.0.0');

  program
    .command('generate')
    .description('Generate an impact report for a GitHub user')
    .requiredOption('-u, --user <username>', 'GitHub username')
    .requiredOption(
      '-s, --since <date>',
      'Start date (YYYY-MM-DD)',
      (value) => parseDate(value, '--since')
    )
    .requiredOption(
      '-t, --until <date>',
      'End date (YYYY-MM-DD)',
      (value) => parseDate(value, '--until')
    )
    .option('-o, --out <file>', 'Output file path', 'report.md')
    .action(async (options: GenerateOptions) => {
      await runGenerate(options);
    });

  return program;
}

interface GenerateOptions {
  user: string;
  since: string;
  until: string;
  out: string;
}

/**
 * Run the generate command
 */
async function runGenerate(options: GenerateOptions): Promise<void> {
  const { user, since, until, out } = options;

  console.log('');
  console.log('╔════════════════════════════════════════╗');
  console.log('║       whatidid - Impact Report         ║');
  console.log('╚════════════════════════════════════════╝');
  console.log('');

  // Validate date range
  if (new Date(since) > new Date(until)) {
    console.error('Error: --since date must be before --until date');
    process.exit(1);
  }

  // Validate configuration
  try {
    validateConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`Configuration Error:\n${error.message}`);
      process.exit(1);
    }
    throw error;
  }

  const config = loadConfig();

  console.log(`User: ${user}`);
  console.log(`Period: ${since} to ${until}`);
  console.log(`Output: ${out}`);
  console.log('');

  try {
    // Step 1: Fetch PRs from GitHub
    console.log('📥 Fetching data from GitHub...');
    const githubClient = new GitHubClient(config.githubToken);
    const prs = await githubClient.fetchAllMergedPRs(user, since, until);

    if (prs.length === 0) {
      console.log('');
      console.log('No merged PRs found for the specified period.');
      console.log('Make sure the GitHub token has access to the repositories.');
      process.exit(0);
    }

    console.log(`Found ${prs.length} merged PRs total`);
    console.log('');

    // Step 2: Summarize PRs with LLM
    console.log('🤖 Analyzing PRs with Gemini...');
    const llmClient = createLLMClient(config.llmApiKey, config.llmModel);
    const summarizer = new LLMFeatureSummarizer(llmClient);

    const features = await summarizePRs(prs, summarizer, (current, total) => {
      process.stdout.write(`\r  Processing PR ${current}/${total}...`);
    });
    console.log(''); // New line after progress
    console.log(`Extracted ${features.length} features`);
    console.log('');

    // Step 3: Group features
    console.log('📊 Grouping features...');
    const projectSummaries = groupFeatures(features);
    const stats = calculateStats(projectSummaries);
    console.log(`Grouped into ${projectSummaries.length} projects`);
    console.log(`After merging: ${stats.totalFeatures} unique features`);
    console.log('');

    // Step 4: Generate report
    console.log('📝 Generating report...');
    const report: ImpactReport = {
      username: user,
      since,
      until,
      generatedAt: new Date().toISOString(),
      projects: projectSummaries,
      totalPRs: stats.totalPRs,
      totalFeatures: stats.totalFeatures,
    };

    await writeReport(report, out);
    console.log(`Report written to: ${out}`);
    console.log('');

    // Print summary
    console.log('╔════════════════════════════════════════╗');
    console.log('║              Summary                   ║');
    console.log('╠════════════════════════════════════════╣');
    console.log(`║  Projects:    ${String(projectSummaries.length).padEnd(24)}║`);
    console.log(`║  PRs Merged:  ${String(stats.totalPRs).padEnd(24)}║`);
    console.log(`║  Features:    ${String(stats.totalFeatures).padEnd(24)}║`);
    console.log('╚════════════════════════════════════════╝');
    console.log('');
    console.log('✅ Done!');
  } catch (error) {
    console.log('');

    if (error instanceof GitHubClientError) {
      console.error(`GitHub API Error: ${error.message}`);
      if (error.statusCode === 401) {
        console.error('  Check that your GITHUB_TOKEN is valid.');
      } else if (error.statusCode === 403) {
        console.error('  You may have hit a rate limit. Try again later.');
      }
      process.exit(1);
    }

    if (error instanceof LLMClientError) {
      console.error(`LLM API Error: ${error.message}`);
      if (error.statusCode === 401) {
        console.error('  Check that your LLM_API_KEY is valid.');
      }
      process.exit(1);
    }

    if (error instanceof Error) {
      console.error(`Error: ${error.message}`);
    } else {
      console.error('An unexpected error occurred');
    }

    process.exit(1);
  }
}
