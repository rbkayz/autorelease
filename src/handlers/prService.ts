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

    try {
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

      // // Update draft PR from staging to main with the new summary
      // await prService.updateStagingToMainPR(context, aiSummary);

      this.logger.info('Successfully updated draft PR with AI summary');
    } catch (error) {
      this.logger.error('Error handling feature merged to staging:', error);
    }
  }
}
