import { Probot } from 'probot';
import { PRService } from './handlers/prService';

export const probotHandler = (app: Probot) => {
  // Handle when PRs are merged into staging or release
  app.on('pull_request.closed', async (context) => {
    const payload = context.payload;
    const pr = payload.pull_request;

    // Only proceed if the PR was merged
    if (!pr.merged) {
      return;
    }

    const baseRef = pr.base.ref;
    const headRef = pr.head.ref;

    const prService = new PRService(context);

    prService.logger.info(
      `PR #${pr.number} (${headRef} → ${baseRef}) was merged`
    );

    await prService.loadConfig();

    // Case 1: Feature branch merged into staging - generate AI summary
    if (
      baseRef === prService.config.branches?.staging &&
      headRef !== prService.config.branches?.release
    ) {
      await prService.handleFeatureMergedToStaging();
    }

    // Case 2: Staging merged to release/main - create GitHub release
    if (
      baseRef === prService.config.branches?.release &&
      headRef === prService.config.branches?.staging
    ) {
      await prService.handleStagingMergedToRelease();
    }
  });
};
