# whatidid

A CLI tool to generate engineering impact reports from GitHub activity. Perfect for promo packets, self-reviews, and resumes.

## Features

- Fetches merged pull requests from GitHub repositories you contributed to
- Extracts shipped features using Google Gemini 2.5 Flash
- Groups similar features together
- Outputs a clean Markdown report

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

- `repo` - Access to private repositories
- `read:user` - Read user profile data

### Google API Key

Get an API key from Google AI Studio at https://aistudio.google.com/apikey

## Usage

```bash
# Generate an impact report
bun run src/index.ts generate \
  --user <github-username> \
  --since <YYYY-MM-DD> \
  --until <YYYY-MM-DD> \
  --out report.md
```

### Options

| Option | Description | Required |
|--------|-------------|----------|
| `-u, --user <username>` | GitHub username | Yes |
| `-s, --since <date>` | Start date (YYYY-MM-DD) | Yes |
| `-t, --until <date>` | End date (YYYY-MM-DD) | Yes |
| `-o, --out <file>` | Output file path | No (default: report.md) |

### Example

```bash
# Generate report for the past year
bun run src/index.ts generate \
  --user octocat \
  --since 2024-01-01 \
  --until 2024-12-31 \
  --out my-impact-2024.md
```

## Output

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

## How It Works

1. **Fetch PRs**: Uses GitHub's Search API to find all merged PRs by the user in the specified time range
2. **Filter**: Only includes PRs merged to `main`, `master`, or `release/*` branches
3. **Analyze**: Sends each PR (title, body, commit messages) to Gemini to extract the shipped feature
4. **Group**: Merges similar features within each repository based on title similarity
5. **Report**: Generates a clean Markdown report sorted chronologically

## Development

```bash
# Type check
bun run typecheck

# Run directly
bun run src/index.ts --help
```

## License

MIT
