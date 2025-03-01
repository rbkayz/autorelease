import { Probot } from 'probot';
import { PRService } from './prService';

export const probotHandler = (app: Probot) => {
  // Handle when PRs are merged into staging
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
    if (baseRef === 'staging' && headRef !== 'main') {
      await prService.handleFeatureMergedToStaging();
    }

    // Case 2: Staging merged to main - create release
    if (baseRef === 'main' && headRef === 'staging') {
      // await prService.handleStagingMergedToMain();
    }
  });
};
