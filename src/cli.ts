/**
 * CLI command definitions and orchestration
 * Uses commander for argument parsing
 */

import { Command } from 'commander';
import { loadConfig, validateConfig, ConfigError } from './config';
import { GitHubClient, GitHubClientError, type GitHubClientOptions } from './github/client';
import { createLLMClient, LLMClientError } from './llm/client';
import { LLMFeatureSummarizer, summarizePRsBatch } from './llm/summarizer';
import { groupFeatures, calculateStats } from './domain/grouping';
import { generateMarkdownReport, writeReport } from './report/markdown';
import { initCache } from './cache';
import type { ImpactReport, PullRequest } from './domain/models';

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
 * Parse comma-separated list
 */
function parseList(value: string): string[] {
  return value.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
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
    .option('-f, --format <format>', 'Output format: markdown or json', 'markdown')
    .option('--scope <scope>', 'Scope of repos to check: all, personal, or orgs (default: all)', 'all')
    .option('--repos <repos>', 'Specific repos to include (comma-separated, owner/repo format)', parseList)
    .option('--orgs <orgs>', 'Organizations to include (comma-separated)', parseList)
    .option('--exclude-repos <repos>', 'Repos to exclude (comma-separated, owner/repo format)', parseList)
    .option('--fast', 'Skip exhaustive org repo scanning (faster, uses search API only)')
    .option('--dry-run', 'Show PRs without LLM analysis')
    .option('--no-cache', 'Disable caching of GitHub API responses')
    .option('-v, --verbose', 'Verbose output')
    .option('-q, --quiet', 'Minimal output')
    .action(async (options: GenerateOptions) => {
      await runGenerate(options);
    });

  program
    .command('clear-cache')
    .description('Clear cached GitHub API responses')
    .action(async () => {
      const cache = initCache(true);
      await cache.clear();
      console.log('Cache cleared.');
    });

  return program;
}

interface GenerateOptions {
  user: string;
  since: string;
  until: string;
  out: string;
  format: 'markdown' | 'json';
  scope: 'all' | 'personal' | 'orgs';
  repos?: string[];
  orgs?: string[];
  excludeRepos?: string[];
  fast?: boolean;
  dryRun?: boolean;
  cache: boolean;
  verbose?: boolean;
  quiet?: boolean;
}

/**
 * Logger utility based on verbosity settings
 */
function createLogger(options: GenerateOptions) {
  const isQuiet = options.quiet;
  const isVerbose = options.verbose;

  return {
    log: (message: string) => {
      if (!isQuiet) console.log(message);
    },
    verbose: (message: string) => {
      if (isVerbose && !isQuiet) console.log(message);
    },
    progress: (message: string) => {
      if (!isQuiet) process.stdout.write(message);
    },
    error: (message: string) => {
      console.error(message);
    },
  };
}

/**
 * Print PR list for dry-run mode
 */
function printPRList(prs: PullRequest[], logger: ReturnType<typeof createLogger>): void {
  // Group by repo
  const byRepo = new Map<string, PullRequest[]>();
  for (const pr of prs) {
    const existing = byRepo.get(pr.repoFullName) ?? [];
    existing.push(pr);
    byRepo.set(pr.repoFullName, existing);
  }

  logger.log('\n📋 Pull Requests Found:\n');

  for (const [repo, repoPRs] of byRepo) {
    logger.log(`\n## ${repo} (${repoPRs.length} PRs)`);
    for (const pr of repoPRs) {
      const date = new Date(pr.mergedAt).toLocaleDateString();
      logger.log(`  - #${pr.number}: ${pr.title} (${date})`);
    }
  }

  logger.log(`\n\nTotal: ${prs.length} PRs across ${byRepo.size} repositories`);
  logger.log('\nRun without --dry-run to generate the full report with LLM analysis.');
}

/**
 * Run the generate command
 */
async function runGenerate(options: GenerateOptions): Promise<void> {
  const { user, since, until, out, format, dryRun, cache } = options;
  const logger = createLogger(options);

  // Initialize cache
  initCache(cache);

  logger.log('');
  logger.log('╔════════════════════════════════════════╗');
  logger.log('║       whatidid - Impact Report         ║');
  logger.log('╚════════════════════════════════════════╝');
  logger.log('');

  // Validate date range
  if (new Date(since) > new Date(until)) {
    logger.error('Error: --since date must be before --until date');
    process.exit(1);
  }

  // Validate format
  if (format !== 'markdown' && format !== 'json') {
    logger.error('Error: --format must be "markdown" or "json"');
    process.exit(1);
  }

  // For dry-run, we don't need LLM config
  if (!dryRun) {
    try {
      validateConfig();
    } catch (error) {
      if (error instanceof ConfigError) {
        logger.error(`Configuration Error:\n${error.message}`);
        process.exit(1);
      }
      throw error;
    }
  } else {
    // Still need GitHub token
    if (!process.env['GITHUB_TOKEN']) {
      logger.error('Error: GITHUB_TOKEN environment variable is required');
      process.exit(1);
    }
  }

  const config = dryRun
    ? { githubToken: process.env['GITHUB_TOKEN']!, llmApiKey: '', llmModel: '' }
    : loadConfig();

  logger.log(`User: ${user}`);
  logger.log(`Period: ${since} to ${until}`);
  if (!dryRun) {
    logger.log(`Output: ${out} (${format})`);
  }
  if (options.scope !== 'all') {
    logger.log(`Scope: ${options.scope} repos only`);
  }
  if (options.repos?.length) {
    logger.log(`Repos: ${options.repos.join(', ')}`);
  }
  if (options.orgs?.length) {
    logger.log(`Orgs: ${options.orgs.join(', ')}`);
  }
  if (options.excludeRepos?.length) {
    logger.log(`Excluding: ${options.excludeRepos.join(', ')}`);
  }
  if (options.fast) {
    logger.log('Mode: Fast (skip org repo scanning)');
  }
  if (dryRun) {
    logger.log('Mode: Dry run (no LLM analysis)');
  }
  if (!cache) {
    logger.log('Cache: Disabled');
  }
  logger.log('');

  try {
    // Step 1: Fetch PRs from GitHub
    logger.log('📥 Fetching data from GitHub...');

    const githubOptions: GitHubClientOptions = {
      cache,
      scope: options.scope,
      repos: options.repos,
      orgs: options.orgs,
      excludeRepos: options.excludeRepos,
      skipOrgScan: options.fast,
      verbose: !options.quiet,
    };

    const githubClient = new GitHubClient(config.githubToken, githubOptions);
    const prs = await githubClient.fetchAllMergedPRs(user, since, until);

    if (prs.length === 0) {
      logger.log('');
      logger.log('No merged PRs found for the specified period.');
      logger.log('Make sure the GitHub token has access to the repositories.');
      process.exit(0);
    }

    logger.log(`Found ${prs.length} merged PRs total`);

    // If dry-run, just print the PRs and exit
    if (dryRun) {
      printPRList(prs, logger);
      process.exit(0);
    }

    logger.log('');

    // Step 2: Summarize PRs with LLM (using batching)
    logger.log('🤖 Analyzing PRs with Gemini...');
    const llmClient = createLLMClient(config.llmApiKey, config.llmModel);
    const summarizer = new LLMFeatureSummarizer(llmClient);

    const features = await summarizePRsBatch(prs, summarizer, 5, (current, total) => {
      logger.progress(`\r  Processing PRs: ${current}/${total}...`);
    });
    logger.log(''); // New line after progress
    logger.log(`Extracted ${features.length} features`);
    logger.log('');

    // Step 3: Group features
    logger.log('📊 Grouping features...');
    const projectSummaries = groupFeatures(features);
    const stats = calculateStats(projectSummaries);
    logger.log(`Grouped into ${projectSummaries.length} projects`);
    logger.log(`After merging: ${stats.totalFeatures} unique features`);
    logger.log('');

    // Step 4: Generate report
    logger.log('📝 Generating report...');
    const report: ImpactReport = {
      username: user,
      since,
      until,
      generatedAt: new Date().toISOString(),
      projects: projectSummaries,
      totalPRs: stats.totalPRs,
      totalFeatures: stats.totalFeatures,
    };

    // Output based on format
    if (format === 'json') {
      const outputPath = out.endsWith('.json') ? out : out.replace(/\.md$/, '.json');
      await Bun.write(outputPath, JSON.stringify(report, null, 2));
      logger.log(`Report written to: ${outputPath}`);
    } else {
      await writeReport(report, out);
      logger.log(`Report written to: ${out}`);
    }
    logger.log('');

    // Print summary
    logger.log('╔════════════════════════════════════════╗');
    logger.log('║              Summary                   ║');
    logger.log('╠════════════════════════════════════════╣');
    logger.log(`║  Projects:    ${String(projectSummaries.length).padEnd(24)}║`);
    logger.log(`║  PRs Merged:  ${String(stats.totalPRs).padEnd(24)}║`);
    logger.log(`║  Features:    ${String(stats.totalFeatures).padEnd(24)}║`);
    logger.log('╚════════════════════════════════════════╝');
    logger.log('');
    logger.log('✅ Done!');
  } catch (error) {
    logger.log('');

    if (error instanceof GitHubClientError) {
      logger.error(`GitHub API Error: ${error.message}`);
      if (error.statusCode === 401) {
        logger.error('  Check that your GITHUB_TOKEN is valid.');
      } else if (error.statusCode === 403) {
        logger.error('  You may have hit a rate limit. Try again later.');
      }
      process.exit(1);
    }

    if (error instanceof LLMClientError) {
      logger.error(`LLM API Error: ${error.message}`);
      if (error.statusCode === 401) {
        logger.error('  Check that your LLM_API_KEY is valid.');
      }
      process.exit(1);
    }

    if (error instanceof Error) {
      logger.error(`Error: ${error.message}`);
    } else {
      logger.error('An unexpected error occurred');
    }

    process.exit(1);
  }
}
