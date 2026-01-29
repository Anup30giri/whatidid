# whatidid

A CLI tool to generate engineering impact reports from GitHub activity. Perfect for promo packets, self-reviews, and resumes.

## Features

- Fetches merged pull requests from GitHub repositories you contributed to
- Extracts shipped features using Google Gemini 2.5 Flash
- Groups similar features together
- Outputs clean Markdown or JSON reports
- Caches GitHub API responses to avoid rate limits on reruns
- Supports filtering by specific repos or organizations

## Requirements

- [Bun](https://bun.sh/) runtime
- GitHub Personal Access Token
- Google API key (for Gemini)

## Installation

```bash
# Clone the repository
git clone <repo-url>
cd whatidid

# Install dependencies
bun install
```

## Configuration

Set the required environment variables:

```bash
export GITHUB_TOKEN=your_github_personal_access_token
export LLM_API_KEY=your_google_api_key
```

Optional environment variables:

```bash
# Gemini model to use (default: gemini-2.5-flash-preview-05-20)
export LLM_MODEL=gemini-2.5-flash-preview-05-20
```

### GitHub Token

Create a Personal Access Token at https://github.com/settings/tokens with the following scopes:

- `repo` - Full access to private repositories
- `read:org` - Read organization membership (for org repos)
- `read:user` - Read user profile data

### Google API Key

Get an API key from Google AI Studio at https://aistudio.google.com/apikey

## Usage

### Basic Usage

```bash
# Generate an impact report
bun run src/index.ts generate \
  --user <github-username> \
  --since <YYYY-MM-DD> \
  --until <YYYY-MM-DD> \
  --out report.md
```

### Options

| Option | Description | Default |
|--------|-------------|---------|
| `-u, --user <username>` | GitHub username | Required |
| `-s, --since <date>` | Start date (YYYY-MM-DD) | Required |
| `-t, --until <date>` | End date (YYYY-MM-DD) | Required |
| `-o, --out <file>` | Output file path | `report.md` |
| `-f, --format <format>` | Output format: `markdown` or `json` | `markdown` |
| `--scope <scope>` | Scope: `all`, `personal`, or `orgs` | `all` |
| `--repos <repos>` | Specific repos to include (comma-separated, owner/repo format) | All |
| `--orgs <orgs>` | Organizations to include (comma-separated) | All |
| `--exclude-repos <repos>` | Repos to exclude (comma-separated, owner/repo format) | None |
| `--dry-run` | Show PRs without LLM analysis | Off |
| `--no-cache` | Disable caching of GitHub API responses | Cache enabled |
| `-v, --verbose` | Verbose output | Off |
| `-q, --quiet` | Minimal output | Off |

**Scope Options:**
- `all` - Check all repos (personal + organization) - default
- `personal` - Only check personal repos (repos owned by the user)
- `orgs` - Only check organization repos (repos not owned by the user)

### Examples

```bash
# Generate report for the past year
bun run src/index.ts generate \
  --user octocat \
  --since 2024-01-01 \
  --until 2024-12-31 \
  --out my-impact-2024.md

# Generate report for personal repos only
bun run src/index.ts generate \
  --user octocat \
  --since 2024-01-01 \
  --until 2024-12-31 \
  --scope personal

# Generate report for organization repos only
bun run src/index.ts generate \
  --user octocat \
  --since 2024-01-01 \
  --until 2024-12-31 \
  --scope orgs

# Generate JSON report for specific repos
bun run src/index.ts generate \
  --user octocat \
  --since 2024-01-01 \
  --until 2024-12-31 \
  --repos "owner/repo1,owner/repo2" \
  --format json \
  --out report.json

# Generate report for a specific organization
bun run src/index.ts generate \
  --user octocat \
  --since 2024-01-01 \
  --until 2024-12-31 \
  --orgs "my-company"

# Dry run to see PRs without LLM analysis
bun run src/index.ts generate \
  --user octocat \
  --since 2024-01-01 \
  --until 2024-12-31 \
  --dry-run

# Force fresh data (ignore cache)
bun run src/index.ts generate \
  --user octocat \
  --since 2024-01-01 \
  --until 2024-12-31 \
  --no-cache

# Clear cached data
bun run src/index.ts clear-cache
```

## Output

### Markdown Format

The tool generates a Markdown report with the following structure:

```markdown
# Engineering Impact Report

**Author:** username
**Period:** Jan 1, 2024 – Dec 31, 2024

## Summary

- **Total Projects:** 5
- **Total PRs Merged:** 42
- **Total Features Shipped:** 28

## Project: owner/repo-name

**Duration:** Feb 15, 2024 – Nov 20, 2024
**Total PRs:** 15

### Shipped Features

- **Feature title**
  - Description of what was shipped
  - PRs: #123, #124
  - Type: Feature
  - Confidence: High
```

### JSON Format

With `--format json`, the output includes the full structured data:

```json
{
  "username": "octocat",
  "since": "2024-01-01",
  "until": "2024-12-31",
  "generatedAt": "2024-12-15T10:30:00.000Z",
  "totalPRs": 42,
  "totalFeatures": 28,
  "projects": [...]
}
```

## How It Works

1. **Fetch PRs**: Uses GitHub's Search API to find all merged PRs by the user in the specified time range
2. **Filter**: Only includes PRs merged to `main`, `master`, or `release/*` branches
3. **Cache**: Stores GitHub API responses locally to avoid rate limits on reruns
4. **Analyze**: Sends PRs in batches to Gemini to extract shipped features (reduces API costs)
5. **Group**: Merges similar features within each repository based on title similarity
6. **Report**: Generates a clean Markdown or JSON report sorted chronologically

## Caching

GitHub API responses are cached in `~/.whatidid-cache` for 24 hours. This helps avoid rate limits when running the tool multiple times with the same parameters.

- Cache is enabled by default
- Use `--no-cache` to force fresh data
- Run `bun run src/index.ts clear-cache` to clear all cached data

## Development

```bash
# Type check
bun run typecheck

# Run directly
bun run src/index.ts --help
```

## Building

### Build Commands

```bash
# Build JavaScript bundle
bun run build

# Build standalone binary (no Bun runtime required to run)
bun run build:binary

# Build both
bun run build:all

# Clean build artifacts
bun run clean
```

### Build Outputs

| File | Description | Size |
|------|-------------|------|
| `dist/index.js` | Minified JavaScript bundle | ~83 KB |
| `dist/whatidid` | Standalone binary (includes Bun runtime) | ~104 MB |

### Using the Standalone Binary

The standalone binary includes the Bun runtime, so it can run on any machine without installing Bun:

```bash
# Build the binary
bun run build:binary

# Run it directly
./dist/whatidid generate --user octocat --since 2024-01-01 --until 2024-12-31

# Or copy to a location in your PATH
sudo cp dist/whatidid /usr/local/bin/
whatidid --help
```

### Cross-Platform Builds

To build for different platforms:

```bash
# Linux x64 (default)
bun build src/index.ts --compile --outfile dist/whatidid-linux-x64

# macOS x64
bun build src/index.ts --compile --outfile dist/whatidid-darwin-x64 --target=bun-darwin-x64

# macOS ARM64 (Apple Silicon)
bun build src/index.ts --compile --outfile dist/whatidid-darwin-arm64 --target=bun-darwin-arm64

# Windows x64
bun build src/index.ts --compile --outfile dist/whatidid-windows-x64.exe --target=bun-windows-x64
```

## Installing Globally

```bash
# Install globally with bun
bun link

# Now you can use it from anywhere
whatidid --help
```

Or install from the repository:

```bash
bun install -g github:Anup30giri/whatidid
```

## License

MIT
