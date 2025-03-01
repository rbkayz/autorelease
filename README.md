# AutoRelease: AI Release Manager

A GitHub App that automates the release management process with AI-powered summaries

## Features

- **Automated Draft PRs**: Automatically creates draft PRs from staging to main when staging is ahead of main
- **AI-Generated Summaries**: Uses OpenAI to generate concise summaries of features for PR descriptions and changelogs
- **Smart Version Determination**: Analyzes changes to recommend semantic version increments (MAJOR, MINOR, PATCH)
- **Release Creation**: Automatically creates GitHub releases when PRs are merged from staging to main
- **Changelog Management**: Updates CHANGELOG.md with each release, including AI-generated feature summaries

Perfect for teams looking to reduce manual work in the release process while improving the quality of release notes and changelogs.

## Installation

### Prerequisites

- Node.js 18 or higher
- A GitHub account with permission to create GitHub Apps
- An OpenAI API key for AI-generated summaries

### Setup as a GitHub App

1. **Create a GitHub App**:
   - Go to your GitHub profile Settings > Developer settings > GitHub Apps
   - Click "New GitHub App"
   - Fill in the form with the following details:
     - **GitHub App name**: Release Manager (or your preferred name)
     - **Homepage URL**: URL of your GitHub repository or organization
     - **Webhook URL**: URL where your app will receive webhook events (can be updated later)
     - **Webhook secret**: Generate a secure random string
   - Permissions:
     - Repository permissions:
       - **Contents**: Read & write
       - **Issues**: Read & write
       - **Pull requests**: Read & write
     - Subscribe to events:
       - **Pull request**
       - **Push**
   - Save the App

2. **Generate a private key**:
   - Go to your GitHub App settings
   - Under "Private keys", click "Generate a private key"
   - Save the downloaded key file securely

3. **Install the App**:
   - Go to your GitHub App settings
   - Click "Install App" in the sidebar
   - Choose the repositories where you want to install the app

### Setup the App Server

1. **Clone this repository**:
   ```bash
   git clone https://github.com/yourusername/release-manager-app.git
   cd release-manager-app
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Create an environment file**:
   Create a `.env` file with the following variables:
   ```
   APP_ID=your_github_app_id
   PRIVATE_KEY=your_private_key_content
   WEBHOOK_SECRET=your_webhook_secret
   OPENAI_API_KEY=your_openai_api_key
   OPENAI_MODEL=gpt-4o
   ```

4. **Start the app**:
   ```bash
   npm start
   ```

### Deploy to a Server

For production use, deploy the app to a server with a public URL. Some options include:

- **Heroku**: [Deploy Node.js to Heroku](https://devcenter.heroku.com/articles/deploying-nodejs)
- **AWS EC2**: [Deploy Node.js to AWS](https://docs.aws.amazon.com/sdk-for-javascript/v2/developer-guide/setting-up-node-on-ec2-instance.html)
- **GitHub Actions**: [Self-hosted runners](https://docs.github.com/en/actions/hosting-your-own-runners/managing-self-hosted-runners/about-self-hosted-runners)

## Usage

### Repository Setup

1. **Branch Structure**:
   - Create a `staging` branch (or configure your preferred branch name in the config)
   - Use your `main` branch for production code

2. **Configuration**:
   - Create a `.github/release-manager.json` file in your repository with your preferred settings (see [Configuration](#configuration))

3. **Development Flow**:
   - Developers merge feature branches into `staging`
   - The app automatically generates AI summaries of the features
   - When ready for release, the app creates a draft PR from `staging` to `main`
   - Review the PR, update the version tag if needed, and merge
   - The app automatically creates a GitHub release and updates the changelog

### Configuration

You can customize the app's behavior by creating a `.github/release-manager.json` file in your repository. Here's an example configuration:

```json
{
  "branches": {
    "main": "main",
    "staging": "staging"
  },
  "pr": {
    "draftTitle": "Release: Staging to Main",
    "draftBody": "## Features to be released\n\n{features}\n\n---\n*This PR was automatically created by the Release Manager.*"
  },
  "release": {
    "prefix": "v",
    "createDraft": false,
    "prerelease": false,
    "generateReleaseNotes": true
  },
  "changelog": {
    "file": "CHANGELOG.md",
    "headerFormat": "# Changelog\n\n",
    "entryFormat": "## {version} ({date})\n\n{features}\n\n"
  },
  "releaseTags": {
    "major": "[MAJOR]",
    "minor": "[MINOR]",
    "patch": "[PATCH]"
  },
  "ai": {
    "openai": {
      "model": "gpt-4o",
      "temperature": 0.2,
      "max_tokens": 1000
    }
  }
}
```

## Development

### Project Structure

```
release-manager-app/
├── .github/
│   └── release-manager.json    # Example configuration
├── src/                        # TypeScript source code
│   ├── lib/                    # Service modules
│   │   ├── ai-service.ts       # AI service for generating summaries
│   │   ├── config-service.ts   # Configuration management
│   │   ├── pr-service.ts       # PR management service
│   │   └── release-service.ts  # Release and changelog service
│   ├── types/                  # TypeScript type definitions
│   │   ├── probot.d.ts         # Probot type definitions
│   │   └── octokit.d.ts        # Octokit type definitions
│   └── index.ts                # Main application entry point
├── dist/                       # Compiled JavaScript (generated)
├── .env                        # Environment variables (not committed)
├── .env.example                # Example environment variables
├── .gitignore                  # Git ignore file
├── tsconfig.json               # TypeScript configuration
├── package.json                # Node.js package config
└── README.md                   # This README
```

### Development

#### TypeScript

This project is written in TypeScript for better type safety and developer experience. The TypeScript code in the `src` directory is compiled to JavaScript in the `dist` directory.

To compile the TypeScript code:

```bash
npm run build
```

To run the app in development mode with automatic reloading:

```bash
npm run dev
```

#### Testing

To run tests:

```bash
npm test
```

### Running Locally

To test the app locally:

1. **Install [smee-client](https://github.com/probot/smee-client) for webhook forwarding**:
   ```bash
   npm install -g smee-client
   ```

2. **Create a Smee channel**:
   - Go to [smee.io](https://smee.io/)
   - Click "Start a new channel"
   - Copy the webhook proxy URL

3. **Update your GitHub App's webhook URL** to the Smee URL

4. **Start the Smee client**:
   ```bash
   smee --url https://smee.io/your-channel-id --path /webhook --port 3000
   ```

5. **Start your app**:
   ```bash
   npm run dev
   ```

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

This project is licensed under the MIT License - see the LICENSE file for details.

## Acknowledgments

- [Probot](https://github.com/probot/probot) - A framework for building GitHub Apps
- [OpenAI](https://openai.com/) - For providing the AI models used for summarization 