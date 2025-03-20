import { PullRequest, PullRequestClosedEvent } from '@octokit/webhooks-types';
import { OpenAI } from 'openai';
import { ChatCompletionCreateParams } from 'openai/resources';
import { Context } from 'probot';
import { calculateNewVersion, parseSummary } from '../utils/helpers';
import { ConfigService } from './configService';

export class PRService extends ConfigService {
  constructor(context: Context) {
    super(context);
  }

  /* -------------------------------------------------------------------------- */
  /*                                 PR HELPERS                                 */
  /* -------------------------------------------------------------------------- */

  /**
   * Constants for section names to ensure consistency throughout the code
   */
  private readonly FEATURES_SECTION = 'New Features';
  private readonly BUGS_SECTION = 'Bugs / Improvements';

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
          Categorize them as either '${this.FEATURES_SECTION}' or '${this.BUGS_SECTION}'.
          
          PR Title: ${prDetails.title}
          PR Description: ${prDetails.body}
          
          Files changed: 
          ${prDetails.diffFiles}
          
          Diff summary:
          ${prDetails.diffSummary}
          
          Commit messages:
          ${prDetails.commitMessages}
          
          Return your response in EXACTLY this format, with these exact section headers:
          
          ${this.FEATURES_SECTION}
          - [bullet points of new features, if any]
          
          ${this.BUGS_SECTION}
          - [bullet points of fixes or improvements, if any]
          
          If there are no entries for a category, include the heading but leave the bullet points empty.
          Each bullet point should be concise and start with a dash (-).
          
          IMPORTANT: New functionality should go under ${this.FEATURES_SECTION}, while bug fixes and improvements to existing functionality should go under ${this.BUGS_SECTION}.`,
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
   * Finds an existing PR from staging to release branch.
   * Includes enhanced debugging and more flexible matching.
   * @returns The found PR or undefined if none exists
   */
  async findStagingToReleasePR() {
    const owner = this.context.repo().owner;
    const repo = this.context.repo().repo;
    const stagingBranch = this.config.branches?.staging ?? 'staging';
    const releaseBranch = this.config.branches?.release ?? 'main';

    this.logger.info(
      `Looking for PRs from ${stagingBranch} to ${releaseBranch} in ${owner}/${repo}`
    );

    try {
      // First, try with the fully qualified head reference
      const { data: prs } = await this.context.octokit.pulls.list({
        owner: owner,
        repo: repo,
        state: 'open',
        head: `${owner}:${stagingBranch}`,
        base: releaseBranch,
      });

      this.logger.info(`Found ${prs.length} PRs matching the criteria`);

      if (prs.length === 0) {
        // If no results, try without owner prefix (sometimes GitHub omits it)
        const { data: simplePrs } = await this.context.octokit.pulls.list({
          owner: owner,
          repo: repo,
          state: 'open',
          head: stagingBranch,
          base: releaseBranch,
        });

        this.logger.info(
          `Retried with simplified branch name, found ${simplePrs.length} PRs`
        );

        if (simplePrs.length > 0) {
          // Log all found PRs for debugging
          for (const pr of simplePrs) {
            this.logger.info(
              `PR #${pr.number}: "${pr.title}" (Draft: ${pr.draft}, Head: ${pr.head.ref}, Base: ${pr.base.ref})`
            );
          }

          // Try to find any PR, not just drafts
          const targetPR =
            simplePrs.find((pr) => pr.draft === true) || simplePrs[0];
          this.logger.info(`Selected PR #${targetPR.number}`);
          return targetPR;
        }

        return undefined;
      }

      // Log all found PRs for debugging
      for (const pr of prs) {
        this.logger.info(
          `PR #${pr.number}: "${pr.title}" (Draft: ${pr.draft}, Head: ${pr.head.ref}, Base: ${pr.base.ref})`
        );
      }

      // First try to find a draft PR, but if none exists, return any matching PR
      const draftPR = prs.find((pr) => pr.draft === true);
      if (draftPR) {
        this.logger.info(`Found draft PR #${draftPR.number}`);
        return draftPR;
      } else if (prs.length > 0) {
        this.logger.info(
          `No draft PR found, using PR #${prs[0].number} instead`
        );
        return prs[0]; // Return the first matching PR even if it's not a draft
      }

      return undefined;
    } catch (error) {
      this.logger.error(`Error finding staging to release PR: ${error}`);
      return undefined;
    }
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
    this.logger.debug(`AI summary: ${aiSummary}`);

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
    const parsedSections = parseSummary(aiSummary);
    this.logger.debug(`Parsed sections: ${JSON.stringify(parsedSections)}`);

    // Add attribution only to the new bullets
    const featureBullets =
      parsedSections.find((s) => s.type === this.FEATURES_SECTION)?.bullets ||
      [];
    const bugBullets =
      parsedSections.find((s) => s.type === this.BUGS_SECTION)?.bullets || [];

    this.logger.info(
      `Found ${featureBullets.length} feature bullets and ${bugBullets.length} bug/improvement bullets`
    );

    // Process feature bullets - add attribution ONLY to these new bullets
    const featureBulletsWithAttribution = featureBullets.map(
      (bullet) =>
        `- ${bullet} (via [#${sourcePR.number}](${prLink}) by @${prAuthor})`
    );

    // Process bug/improvement bullets - add attribution ONLY to these new bullets
    const bugBulletsWithAttribution = bugBullets.map(
      (bullet) =>
        `- ${bullet} (via [#${sourcePR.number}](${prLink}) by @${prAuthor})`
    );

    // Update the PR body by adding only the new bullets with attribution
    prBody = this.addNewBulletsToBody(
      prBody,
      this.FEATURES_SECTION,
      featureBulletsWithAttribution,
      this.BUGS_SECTION,
      bugBulletsWithAttribution
    );

    // Update timestamp
    prBody = prBody.replace(
      /\*Last updated:.*\*/,
      `*Last updated: ${new Date().toISOString()}*`
    );

    this.logger.debug(`Updated PR body: ${prBody}`);

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
   * Adds new bullets to specific sections of the PR body without modifying existing content
   * @param prBody - The current PR body
   * @param featuresSection - The name of the features section
   * @param featureBullets - The new feature bullets to add
   * @param bugsSection - The name of the bugs/improvements section
   * @param bugBullets - The new bug bullets to add
   * @returns The updated PR body
   */
  private addNewBulletsToBody(
    prBody: string,
    featuresSection: string,
    featureBullets: string[],
    bugsSection: string,
    bugBullets: string[]
  ): string {
    // Create section headers if they don't exist
    if (!prBody.includes(`## ${featuresSection}`)) {
      prBody += `\n\n## ${featuresSection}\n<!-- New feature summaries will be added here -->\n`;
    }

    if (!prBody.includes(`## ${bugsSection}`)) {
      prBody += `\n\n## ${bugsSection}\n<!-- Bug fixes and improvements will be added here -->\n`;
    }

    // Add feature bullets
    if (featureBullets.length > 0) {
      // Find the features section
      const featureRegex = new RegExp(
        `(## ${featuresSection}.*?)(\\n## |$)`,
        's'
      );
      const featureMatch = prBody.match(featureRegex);

      if (featureMatch) {
        // Insert after the header and any HTML comments
        const sectionContent = featureMatch[1];
        const insertPoint = sectionContent.match(/<!--.*?-->\n/)?.[0]?.length
          ? sectionContent.indexOf(
              '\n',
              sectionContent?.match(/<!--.*?-->\n/)?.[0]?.length ?? 0
            ) + 1
          : sectionContent.indexOf('\n') + 1;

        // Construct the updated section
        const newSectionContent =
          sectionContent.substring(0, insertPoint) +
          featureBullets.join('\n') +
          (featureBullets.length > 0 ? '\n' : '') +
          sectionContent.substring(insertPoint);

        // Replace the old section with the new one
        prBody = prBody.replace(featureMatch[1], newSectionContent);
      }
    }

    // Add bug bullets
    if (bugBullets.length > 0) {
      // Find the bugs section
      const bugRegex = new RegExp(`(## ${bugsSection}.*?)(\\n## |$)`, 's');
      const bugMatch = prBody.match(bugRegex);

      if (bugMatch) {
        // Insert after the header and any HTML comments
        const sectionContent = bugMatch[1];
        const insertPoint = sectionContent.match(/<!--.*?-->\n/)?.[0]?.length
          ? sectionContent.indexOf(
              '\n',
              sectionContent.match(/<!--.*?-->\n/)?.[0]?.length ?? 0
            ) + 1
          : sectionContent.indexOf('\n') + 1;

        // Construct the updated section
        const newSectionContent =
          sectionContent.substring(0, insertPoint) +
          bugBullets.join('\n') +
          (bugBullets.length > 0 ? '\n' : '') +
          sectionContent.substring(insertPoint);

        // Replace the old section with the new one
        prBody = prBody.replace(bugMatch[1], newSectionContent);
      }
    }

    return prBody;
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
_This summary was generated automatically by AI_`;

    // Add comment to the PR
    await this.context.octokit.issues.createComment({
      owner: this.context.repo().owner,
      repo: this.context.repo().repo,
      issue_number: prNumber,
      body: commentBody,
    });

    this.logger.info(`Added summary comment to PR #${prNumber}`);
  }

  /**
   * Handles the logic when the staging branch is merged to the release branch.
   * Creates a GitHub release with the appropriate version and release notes.
   */
  public async handleStagingMergedToRelease(): Promise<void> {
    const payload = this.context.payload as PullRequestClosedEvent & {
      action: 'closed';
    };

    const pr = payload.pull_request;

    // Verify this is a merge from staging to release
    if (!pr.merged) {
      this.logger.info(
        'PR was closed but not merged, skipping release creation'
      );
      return;
    }

    const headBranch = pr.head.ref;
    const baseBranch = pr.base.ref;
    const stagingBranch = this.config.branches?.staging ?? 'staging';
    const releaseBranch = this.config.branches?.release ?? 'main';

    if (headBranch !== stagingBranch || baseBranch !== releaseBranch) {
      this.logger.info(
        `PR #${pr.number} is not from ${stagingBranch} to ${releaseBranch}, skipping release creation`
      );
      return;
    }

    this.logger.info(`Handling staging merged to release: PR #${pr.number}`);

    // Extract version type and version number from PR title
    // Example PR title: "MINOR Release: v1.2.0: Add user authentication"
    const titleMatch = pr.title.match(
      /^(MAJOR|MINOR|PATCH) Release: (v?\d+\.\d+\.\d+):/i
    );
    if (!titleMatch) {
      this.logger.warn(
        `Cannot parse version from PR title: ${pr.title}, skipping release creation`
      );
      return;
    }

    const [, versionType, versionFromTitle] = titleMatch;

    // Ensure version has the correct prefix from config
    const versionPrefix = this.config.release?.prefix ?? 'v';
    const versionWithoutPrefix = versionFromTitle.replace(/^v?/, '');
    const version = `${versionPrefix}${versionWithoutPrefix}`;

    try {
      // Create a GitHub release
      const { data: release } = await this.context.octokit.repos.createRelease({
        owner: this.context.repo().owner,
        repo: this.context.repo().repo,
        tag_name: version,
        name: version,
        body: await this.formatReleaseNotes(pr.body || '', versionType),
        target_commitish: releaseBranch,
        draft: false,
        prerelease: false,
      });

      this.logger.info(`Created release ${version}: ${release.html_url}`);

      // Add a release comment to the PR
      await this.context.octokit.issues.createComment({
        owner: this.context.repo().owner,
        repo: this.context.repo().repo,
        issue_number: pr.number,
        body: `🎉 Release [${version}](${release.html_url}) has been published!`,
      });
    } catch (error) {
      this.logger.error(`Failed to create release ${version}:`, error);
      throw error;
    }
  }

  /**
   * Formats the PR body into proper release notes by removing placeholders,
   * cleaning up internal comments, and adding release metadata.
   *
   * @param prBody - The pull request body text to format
   * @param versionType - The version type (MAJOR/MINOR/PATCH)
   * @returns Formatted release notes
   */
  private async formatReleaseNotes(
    prBody: string,
    versionType: string
  ): Promise<string> {
    // Extract existing content from PR body
    // This will be sent to the AI for summarization
    const existingContent = prBody.replace(/<!-- .* -->/g, '');

    // Generate AI summary
    const aiSummary = await this.generateAISummary(existingContent);

    // Add release metadata
    const metadata = [
      `**Release Type:** ${versionType}`,
      `**Release Date:** ${new Date().toISOString().split('T')[0]}`,
    ].join('\n');

    // Construct final release notes with metadata and AI summary
    let notes = '';
    const releaseHeaderRegex = /# Release .+\n/;

    if (releaseHeaderRegex.test(existingContent)) {
      const releaseTitle = existingContent.match(releaseHeaderRegex)?.[0];
      notes = `${releaseTitle}\n${metadata}\n\n${aiSummary}`;
    } else {
      notes = `# Release\n\n${metadata}\n\n${aiSummary}`;
    }

    // Add footer
    notes += `\n\n---\n*This release was automatically published by the GitHub Release Bot with AI-generated summary.*`;

    return notes;
  }

  private async generateAISummary(prContent: string): Promise<string> {
    try {
      // Assuming you have an OpenAI integration set up
      const openai = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY,
      });

      const prompt = `
Please summarize the following release notes into a concise, bullet-point format.
Organize the summary into two sections:
1. "## New Features" - new functionality and enhancements
2. "## Bugs / Improvements" - bug fixes and performance improvements

For each section, provide brief bullet points (starting with "-") that clearly describe each change.
If there are no items for a section, include the section heading with no bullets.
Be concise and focus on the most important changes.

RELEASE NOTES:
${prContent}
`;

      const response = await openai.chat.completions.create({
        model: 'gpt-4-turbo', // or whatever model you prefer
        messages: [
          {
            role: 'system',
            content:
              'You are a technical release notes assistant that creates concise summaries.',
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
        temperature: 0.5,
        max_tokens: 1000,
      });

      // Extract the content from the AI response
      const summary = response.choices[0].message.content?.trim();
      if (!summary) {
        throw new Error('No summary generated by AI');
      }
      return summary;
    } catch (error) {
      console.error('Error generating AI summary:', error);
      // Fallback to original content with basic formatting if AI fails
      return ['## New Features', '', '## Bugs / Improvements', ''].join('\n');
    }
  }

  /**
   * Creates an empty commit on the specified branch.
   * Useful for triggering CI/CD pipelines or marking release events.
   *
   * @param branch - The branch to commit to (defaults to the staging branch)
   * @param message - The commit message (defaults to an automated message)
   * @returns Information about the created commit
   */
  async createEmptyCommit(
    branch?: string,
    message?: string
  ): Promise<{ sha: string; url: string }> {
    const targetBranch = branch || this.config.branches?.staging || 'staging';
    const commitMessage =
      message || `Empty commit [${new Date().toISOString()}]`;

    this.logger.info(
      `Creating empty commit on ${targetBranch}: "${commitMessage}"`
    );

    try {
      // Get the latest commit on the branch
      const reference = await this.context.octokit.git.getRef({
        owner: this.context.repo().owner,
        repo: this.context.repo().repo,
        ref: `heads/${targetBranch}`,
      });

      // Get the commit that the branch points to
      const latestCommit = await this.context.octokit.git.getCommit({
        owner: this.context.repo().owner,
        repo: this.context.repo().repo,
        commit_sha: reference.data.object.sha,
      });

      // Create a new commit using the same tree (no changes)
      const newCommit = await this.context.octokit.git.createCommit({
        owner: this.context.repo().owner,
        repo: this.context.repo().repo,
        message: commitMessage,
        tree: latestCommit.data.tree.sha,
        parents: [latestCommit.data.sha],
      });

      // Update the reference to point to the new commit
      await this.context.octokit.git.updateRef({
        owner: this.context.repo().owner,
        repo: this.context.repo().repo,
        ref: `heads/${targetBranch}`,
        sha: newCommit.data.sha,
      });

      this.logger.info(
        `Successfully created empty commit: ${newCommit.data.sha}`
      );

      return {
        sha: newCommit.data.sha,
        url: `https://github.com/${this.context.repo().owner}/${this.context.repo().repo}/commit/${newCommit.data.sha}`,
      };
    } catch (error) {
      this.logger.error(
        `Failed to create empty commit on ${targetBranch}:`,
        error
      );
      throw error;
    }
  }
}
