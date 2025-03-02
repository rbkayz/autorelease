import { PullRequest, PullRequestClosedEvent } from '@octokit/webhooks-types';
import { ChatCompletionCreateParams } from 'openai/resources';
import { Context } from 'probot';
import { ConfigService } from './configService';

export class PRService extends ConfigService {
  constructor(context: Context) {
    super(context);
  }

  /* -------------------------------------------------------------------------- */
  /*                                 PR HELPERS                                 */
  /* -------------------------------------------------------------------------- */

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
        content: `Generate a concise, well-written summary of this feature that was just merged into the staging branch. The summary should explain what the feature does and its business value.
          
          PR Title: ${prDetails.title}
          PR Description: ${prDetails.body}
          
          Files changed: 
          ${prDetails.diffFiles}
          
          Diff summary:
          ${prDetails.diffSummary}
          
          Commit messages:
          ${prDetails.commitMessages}
          
          Write the summary as a markdown list starting with "## Feature Summary" followed by bullets of the main points.`,
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

  async updateStagingToReleasePR(aiSummary: string): Promise<void> {
    // Find the draft PR
    const draftPR = await this.findStagingToReleasePR();

    if (!draftPR) {
      this.logger.info('No draft PR found to release branch');

      // Create a new draft PR
      const newPR = await this.createDraftPR();

      // Update the new PR with AI summary
      await this.updatePRWithAISummary(newPR.number, aiSummary);
      return;
    }

    // Update the existing PR with AI summary
    await this.updatePRWithAISummary(draftPR.number, aiSummary);
  }

  /* -------------------------------------------------------------------------- */
  /*                                   HELPERS                                  */
  /* -------------------------------------------------------------------------- */

  async findStagingToReleasePR() {
    const { data: prs } = await this.context.octokit.pulls.list({
      owner: this.context.repo().owner,
      repo: this.context.repo().repo,
      state: 'open',
      head: `${this.context.repo().owner}:staging`,
      base: this.config.branches?.release ?? 'main',
    });

    // Find draft PR
    const draftPR = prs.find((pr) => pr.draft === true);

    return draftPR;
  }

  async createDraftPR() {
    this.logger.info('Creating draft PR from staging to release');

    // Get the current version from the latest release
    const currentVersion = await this.getCurrentVersion();

    // Calculate the next version (default to patch)
    const newVersion = this.calculateNewVersion(currentVersion, 'patch');

    // Generate a release summary with placeholder text that will be updated later
    const releaseSummary = 'New features and improvements';

    // Create standardized release title
    const releaseTitle = this.generateReleasePRTitle(
      newVersion,
      releaseSummary
    );

    // Create the PR
    const { data: pr } = await this.context.octokit.pulls.create({
      owner: this.context.repo().owner,
      repo: this.context.repo().repo,
      title: releaseTitle,
      head: this.config.branches?.staging ?? 'staging',
      base: this.config.branches?.release ?? 'main',
      body: `# Draft Release ${this.config.release?.prefix ?? 'v'}${newVersion}\n\n*This is an automated draft PR. The content will be updated when features are merged to staging.*\n\n## Changes\n\n*Pending automated summary*`,
      draft: true,
    });

    this.logger.info(`Created draft PR #${pr.number}: ${pr.html_url}`);
    return pr;
  }

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

  calculateNewVersion(
    currentVersion: string,
    releaseType: 'major' | 'minor' | 'patch'
  ): string {
    // Parse current version
    const versionParts = currentVersion.split('.');
    const major = parseInt(versionParts[0] || '0', 10);
    const minor = parseInt(versionParts[1] || '0', 10);
    const patch = parseInt(versionParts[2] || '0', 10);

    // Calculate new version
    switch (releaseType) {
      case 'major':
        return `${major + 1}.0.0`;
      case 'minor':
        return `${major}.${minor + 1}.0`;
      case 'patch':
      default:
        return `${major}.${minor}.${patch + 1}`;
    }
  }

  generateReleasePRTitle(version: string, summary: string): string {
    // Truncate summary if it's too long (keeping it to one line)
    const maxSummaryLength = 80;
    const truncatedSummary =
      summary.length > maxSummaryLength
        ? `${summary.substring(0, maxSummaryLength - 3)}...`
        : summary;

    // Format the PR title according to the standardized format
    return `Release ${version}: ${truncatedSummary}`;
  }

  async updatePRWithAISummary(
    prNumber: number,
    aiSummary: string
  ): Promise<void> {
    this.logger.info(`Updating PR #${prNumber} with AI summary`);

    // Get current PR body
    const { data: pr } = await this.context.octokit.pulls.get({
      owner: this.context.repo().owner,
      repo: this.context.repo().repo,
      pull_number: prNumber,
    });

    let prBody = pr.body || '';

    // Insert AI summary at the beginning of the Features section
    const featuresHeader = '## Features to be released';
    if (prBody.includes(featuresHeader)) {
      const featuresIndex =
        prBody.indexOf(featuresHeader) + featuresHeader.length;
      prBody =
        prBody.substring(0, featuresIndex) +
        '\n\n' +
        aiSummary +
        '\n' +
        prBody.substring(featuresIndex);
    } else {
      prBody = `${featuresHeader}\n\n${aiSummary}\n\n${prBody}`;
    }

    // Update PR
    await this.context.octokit.pulls.update({
      owner: this.context.repo().owner,
      repo: this.context.repo().repo,
      pull_number: prNumber,
      body: prBody,
    });

    this.logger.info(`Updated PR #${prNumber} with AI summary`);
  }
}
