import { Probot, run } from 'probot';

const app = (app: Probot) => {
  app.on('issues.opened', async (context) => {
    const issueComment = context.issue({
      body: 'Thanks for opening this issue!',
    });
    await context.octokit.issues.createComment(issueComment);
  });
  // For more information on building apps:
  // https://probot.github.io/docs/

  // To get your app running against GitHub, see:
  // https://probot.github.io/docs/development/

  app.on('pull_request.opened', async (context) => {
    const pr = context.payload.pull_request;
    const { number, title, user, body } = pr;

    console.log(JSON.stringify(pr, null, 2));
  });
};

run(app);
