import { PullRequest, PullRequestClosedEvent } from '@octokit/webhooks-types';
import { ChatCompletionCreateParams } from 'openai/resources';
import { Context } from 'probot';
import {
  calculateNewVersion,
  parseSummary,
  updateSection,
} from '../utils/helpers';
import { ConfigService } from './configService';

export class PRService extends ConfigService {
  constructor(context: Context) {
    super(context);
  }

  /* -------------------------------------------------------------------------- */
  /*                                 PR HELPERS                                 */
  /* -------------------------------------------------------------------------- */

  /**
   * Retrieves detailed information about a pull request including diff stats and commit messages.
   * @param pr - The pull request object to get details for
   * @returns A detailed object containing PR title, body, diff statistics, and commit messages
   */
  async getPRDetails(pr: PullRequest) {
    // Get PR diff stats
    const diffStats = await this.getDiffStats(pr.number);

    // Get PR commits
    const commits = await this.context.octokit.pulls.listCommits({
      owner: this.context.repo().owner,
      repo: this.context.repo().repo,
      pull_number: pr.number,
    });

    // Extract commit messages
    const commitMessages = commits.data
      .map((commit) => commit.commit.message)
      .join('\n');

    return {
      title: pr.title,
      body: pr.body || '',
      diffFiles: diffStats.files.join('\n'),
      diffSummary: diffStats.summary,
      diffContent: diffStats.content,
      commitMessages,
    };
  }

  /**
   * Gets detailed diff statistics for a pull request by analyzing the diff content.
   * @param prNumber - The PR number to get diff stats for
   * @returns Object containing changed files list, summary of changes, and truncated diff content
   */
  async getDiffStats(prNumber: number) {
    // Get diff content
    const diff = await this.context.octokit.pulls.get({
      owner: this.context.repo().owner,
      repo: this.context.repo().repo,
      pull_number: prNumber,
      mediaType: {
        format: 'diff',
      },
    });

    // Get diff content as text
    const diffText = diff.data as unknown as string;

    // Extract files changed
    const files: string[] = [];
    const fileRegex = /^diff --git a\/(.*?) b\/(.*?)$/gm;
    let match;
    while ((match = fileRegex.exec(diffText)) !== null) {
      files.push(match[1]);
    }

    // Generate a summary of changes (simplified)
    const additions = (diffText.match(/^\+[^+]/gm) || []).length;
    const deletions = (diffText.match(/^-[^-]/gm) || []).length;
    const summary = `${files.length} files changed, ${additions} insertions(+), ${deletions} deletions(-)`;

    // For version determination, get a shorter sample of the diff
    // Limit to first 2000 characters to avoid token limits
    const content = diffText.substring(0, 2000);

    return {
      files,
      summary,
      content,
    };
  }

  /* -------------------------------------------------------------------------- */
  /*                  HANDLE WHEN FEATURE IS MERGED TO STAGING                  */
  /* -------------------------------------------------------------------------- */

  /**
   * Handles the logic when a feature PR is merged to the staging branch.
   * Generates an AI summary of the changes and updates the staging-to-release PR.
   */
  public async handleFeatureMergedToStaging() {
    const payload = this.context.payload as PullRequestClosedEvent & {
      action: 'closed';
    };

    const pr = payload.pull_request;

    this.logger.info(`Handling feature merged to staging: PR #${pr.number}`);

    // Get PR details
    const prDetails = await this.getPRDetails(pr);

    const messages: ChatCompletionCreateParams['messages'] = [
      {
        role: 'system',
        content: this.config.ai?.featureSummaryPrompt ?? '',
        name: 'system',
      },
      {
        role: 'user',
        content: `Analyze this pull request and generate a concise, well-written summary of the changes. 
          Categorize them as either 'Features' or 'Fixes / Improvements'.
          
          PR Title: ${prDetails.title}
          PR Description: ${prDetails.body}
          
          Files changed: 
          ${prDetails.diffFiles}
          
          Diff summary:
          ${prDetails.diffSummary}
          
          Commit messages:
          ${prDetails.commitMessages}
          
          Return your response in exactly this format:
          
          Features
          - [bullet points of new features, if any]
          
          Fixes / Improvements
          - [bullet points of fixes or improvements, if any]
          
          If there are no entries for a category, include the heading but leave the bullet points empty.
          Each bullet point should be concise and start with a dash (-).`,
      },
    ];

    const aiSummary = await this.callOpenAI({ messages });

    if (!aiSummary) {
      this.logger.warn('Failed to generate AI summary, skipping PR update');
      return;
    }

    this.logger.info(`AI summary: ${aiSummary}`);

    // Update draft PR from staging to main with the new summary
    await this.updateStagingToReleasePR(aiSummary);

    this.logger.info('Successfully updated draft PR with AI summary');
  }

  /**
   * Updates (or creates if it doesn't exist) a PR from staging to release branch
   * with the AI-generated summary of changes.
   * @param aiSummary - The AI-generated summary text of the changes
   */
  async updateStagingToReleasePR(aiSummary: string): Promise<void> {
    // Find the draft PR
    const draftPR = await this.findStagingToReleasePR();

    let prToUpdate = draftPR?.number;

    if (!prToUpdate) {
      this.logger.info('No draft PR found to release branch');

      // Create a new draft PR
      const { data: newPR } = await this.context.octokit.pulls.create({
        owner: this.context.repo().owner,
        repo: this.context.repo().repo,
        title: `Updating ${this.config.release?.prefix ?? 'v'}${await this.getCurrentVersion()}`,
        head: this.config.branches?.staging ?? 'staging',
        base: this.config.branches?.release ?? 'main',
      });

      prToUpdate = newPR.number;
    }

    // Update the existing PR with AI summary
    await this.updatePRWithAISummary(prToUpdate, aiSummary);

    // Add comment to the PR
    await this.addSummaryComment(prToUpdate, aiSummary);

    // Update PR title with version information
    await this.updatePRTitle(prToUpdate, aiSummary);
  }

  /**
   * Updates the PR title with semantic version information based on AI analysis.
   * Calls the AI to determine version type (MAJOR/MINOR/PATCH) and generate a concise summary.
   * @param prNumber - The PR number to update
   * @param aiSummary - The AI-generated summary to analyze for versioning purposes
   */
  async updatePRTitle(prNumber: number, aiSummary: string): Promise<void> {
    // Get current PR details
    const { data: pr } = await this.context.octokit.pulls.get({
      owner: this.context.repo().owner,
      repo: this.context.repo().repo,
      pull_number: prNumber,
    });

    const messages: ChatCompletionCreateParams['messages'] = [
      {
        role: 'system',
        content:
          this.config.ai?.versionTypePrompt ??
          'You are a versioning expert who helps determine version changes and creates concise summaries.',
        name: 'system',
      },
      {
        role: 'user',
        content: `Based on the following PR body and changes summary:
        
        PR Body:
        ${pr.body || ''}
        
        Changes Summary:
        ${aiSummary}
        
        Please provide two things:
        1. The appropriate semantic version increment type according to semver.org rules:
           - MAJOR version for incompatible API changes
           - MINOR version for added functionality in a backwards compatible manner
           - PATCH version for backwards compatible bug fixes
        2. A concise one-line summary (maximum 60 characters) that captures the most important aspects of this release
        
        Format your response exactly like this:
        VERSION_TYPE: [MAJOR/MINOR/PATCH]
        SUMMARY: [Your concise one-line summary]
        
        No other explanation is needed.`,
      },
    ];

    const response = await this.callOpenAI({ messages });

    if (!response) {
      this.logger.warn('Failed to get version info from AI, using defaults');
      // Use defaults if AI fails
      await this.updatePRTitleWithInfo(
        prNumber,
        'PATCH',
        'New features and improvements'
      );
      return;
    }

    // Parse the response
    const versionMatch = response.match(/VERSION_TYPE:\s*(MAJOR|MINOR|PATCH)/i);
    const summaryMatch = response.match(/SUMMARY:\s*(.+?)(?:\n|$)/i);

    const versionType = versionMatch ? versionMatch[1].toUpperCase() : 'PATCH';
    const summary = summaryMatch
      ? summaryMatch[1].trim()
      : 'New features and improvements';

    // Limit summary to 60 characters
    const oneLine =
      summary.length > 60 ? summary.substring(0, 57) + '...' : summary;

    await this.updatePRTitleWithInfo(prNumber, versionType, oneLine);
  }

  /**
   * Updates the PR title with the format: "<VERSION_TYPE> Release: v<version>: <summary>"
   * @param prNumber - The PR number to update
   * @param versionType - The determined version type (MAJOR/MINOR/PATCH)
   * @param summary - A concise one-line summary of the changes
   */
  async updatePRTitleWithInfo(
    prNumber: number,
    versionType: string,
    summary: string
  ): Promise<void> {
    // Get current version
    const currentVersion = await this.getCurrentVersion();

    // Calculate new version based on the determined type
    const newVersion = calculateNewVersion(
      currentVersion,
      versionType.toLowerCase() as 'major' | 'minor' | 'patch'
    );

    // Create the formatted title
    const newTitle = `${versionType} Release: ${this.config.release?.prefix ?? 'v'}${newVersion}: ${summary}`;

    // Update PR title
    await this.context.octokit.pulls.update({
      owner: this.context.repo().owner,
      repo: this.context.repo().repo,
      pull_number: prNumber,
      title: newTitle,
    });

    this.logger.info(`Updated PR #${prNumber} title to: ${newTitle}`);
  }

  /* -------------------------------------------------------------------------- */
  /*                                   HELPERS                                  */
  /* -------------------------------------------------------------------------- */

  /**
   * Finds an existing draft PR from staging to release branch.
   * @returns The found draft PR or undefined if none exists
   */
  async findStagingToReleasePR() {
    const { data: prs } = await this.context.octokit.pulls.list({
      owner: this.context.repo().owner,
      repo: this.context.repo().repo,
      state: 'open',
      head: `${this.context.repo().owner}:${this.config.branches?.staging}`,
      base: this.config.branches?.release ?? 'main',
    });

    // Find draft PR
    const draftPR = prs.find((pr) => pr.draft === true);

    return draftPR;
  }

  /**
   * Gets the current version from the latest release or tag.
   * Falls back to 0.0.0 if no releases or tags are found.
   * @returns The current semantic version string (e.g., "1.2.3")
   */
  async getCurrentVersion(): Promise<string> {
    try {
      // Try to get latest release
      try {
        const { data: latestRelease } =
          await this.context.octokit.repos.getLatestRelease({
            owner: this.context.repo().owner,
            repo: this.context.repo().repo,
          });

        // Extract version from tag name (remove 'v' prefix if present)
        const version = latestRelease.tag_name.replace(/^v/, '');
        this.logger.info(`Latest release version: ${version}`);
        return version;
      } catch (error) {
        // If no releases found, try to get latest tag
        const { data: tags } = await this.context.octokit.repos.listTags({
          owner: this.context.repo().owner,
          repo: this.context.repo().repo,
          per_page: 1,
        });

        if (tags.length > 0) {
          const version = tags[0].name.replace(
            new RegExp(`^${this.config.release?.prefix ?? 'v'}`),
            ''
          );
          this.logger.info(`Latest tag version: ${version}`);
          return version;
        }

        // If no tags found, start with 0.0.0
        this.logger.info('No releases or tags found, starting with 0.0.0');
        return '0.0.0';
      }
    } catch (error) {
      this.logger.error('Error getting current version:', error);
      return '0.0.0';
    }
  }

  /**
   * Updates the PR body with an AI-generated summary, adding attribution to each bullet point.
   * Organizes content into appropriate sections (New Features or Bugs/Improvements).
   * @param prNumber - The PR number to update
   * @param aiSummary - The AI-generated summary text to add to the PR body
   */
  async updatePRWithAISummary(
    prNumber: number,
    aiSummary: string
  ): Promise<void> {
    this.logger.info(`Updating PR #${prNumber} with AI summary`);

    // Get the source PR that was merged (from the payload)
    const payload = this.context.payload as PullRequestClosedEvent & {
      action: 'closed';
    };
    const sourcePR = payload.pull_request;
    const prAuthor = sourcePR.user?.login || 'Unknown';
    const prLink = sourcePR.html_url;

    // Get current PR body
    const { data: pr } = await this.context.octokit.pulls.get({
      owner: this.context.repo().owner,
      repo: this.context.repo().repo,
      pull_number: prNumber,
    });

    let prBody = pr.body || '';

    // Parse the AI summary to separate features from fixes
    const sections = parseSummary(aiSummary);

    // Add attribution to each bullet and update the PR body
    for (const section of sections) {
      if (section.type === 'Features' && section.bullets.length > 0) {
        for (const bullet of section.bullets) {
          const bulletWithAttribution = `${bullet} (via [#${sourcePR.number}](${prLink}) by @${prAuthor})`;
          prBody = updateSection(
            prBody,
            '## New Features',
            bulletWithAttribution
          );
        }
      } else if (
        section.type === 'Fixes / Improvements' &&
        section.bullets.length > 0
      ) {
        for (const bullet of section.bullets) {
          const bulletWithAttribution = `${bullet} (via [#${sourcePR.number}](${prLink}) by @${prAuthor})`;
          prBody = updateSection(
            prBody,
            '## Bugs / Improvements',
            bulletWithAttribution
          );
        }
      }
    }

    // Update timestamp
    prBody = prBody.replace(
      /\*Last updated:.*\*/,
      `*Last updated: ${new Date().toISOString()}*`
    );

    // Update PR
    await this.context.octokit.pulls.update({
      owner: this.context.repo().owner,
      repo: this.context.repo().repo,
      pull_number: prNumber,
      body: prBody,
    });

    this.logger.info(`Updated PR #${prNumber} with AI summary`);
  }

  /**
   * Adds a comment to the PR with a summary of the merged changes.
   * The comment includes the original PR's title, number, author, and the AI-generated summary.
   * @param prNumber - The PR number to comment on
   * @param aiSummary - The AI-generated summary to include in the comment
   */
  async addSummaryComment(prNumber: number, aiSummary: string): Promise<void> {
    // Get the source PR that was merged (from the payload)
    const payload = this.context.payload as PullRequestClosedEvent & {
      action: 'closed';
    };
    const sourcePR = payload.pull_request;
    const prAuthor = sourcePR.user?.login || 'Unknown';
    const prTitle = sourcePR.title;
    const sourcePRNumber = sourcePR.number;

    // Create comment title and body
    const commentTitle = `### Merged: "${prTitle}" (#${sourcePRNumber}) by @${prAuthor}`;

    // Format the comment body
    const commentBody = `${commentTitle}

${aiSummary}

---
*This summary was generated automatically by AI.*`;

    // Add comment to the PR
    await this.context.octokit.issues.createComment({
      owner: this.context.repo().owner,
      repo: this.context.repo().repo,
      issue_number: prNumber,
      body: commentBody,
    });

    this.logger.info(`Added summary comment to PR #${prNumber}`);
  }
}
