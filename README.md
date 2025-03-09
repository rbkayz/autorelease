# AutoRelease: AI-Powered Release Management Bot

A GitHub App that automates your release management process using AI to generate summaries, manage version numbers, and create draft PRs and releases.

![AutoRelease Github App](https://github.com/apps/autorelease-ai-release-manager)

![GitHub](https://img.shields.io/github/license/rbkayz/autorelease)
![Node](https://img.shields.io/badge/node->=18-brightgreen)

## Features

- **Automated Release Flow**: Seamlessly manages the flow from feature branches to staging to release
- **AI-Generated Summaries**: Uses OpenAI to create concise, contextual summaries of changes
- **Smart Version Management**: Automatically determines semantic version increments (MAJOR/MINOR/PATCH) based on AI analysis of changes
- **Structured Release Notes**: Organizes changes into "New Features" and "Bugs / Improvements" sections
- **GitHub Releases**: Automatically creates properly tagged GitHub releases when staging is merged to release
- **PR Attribution**: Tracks the original PR author and number in release notes

## Table of Contents

- [Installation](#installation)
  - [As a GitHub App](#as-a-github-app)
  - [Self-Hosting](#self-hosting)
  - [Docker Deployment](#docker-deployment)
- [Configuration](#configuration)
  - [Configuration File Location](#configuration-file-location)
  - [Configuration Options](#configuration-options)
  - [Environment Variables](#environment-variables)
- [Repository Structure](#repository-structure)
- [Usage Workflow](#usage-workflow)
- [Development](#development)
- [Contributing](#contributing)
- [License](#license)

## Installation

### As a GitHub App

1. **Create a GitHub App**:
   - Go to GitHub profile → Settings → Developer settings → GitHub Apps → New GitHub App
   - Fill in required details:
     - **Name**: AutoRelease (or your preferred name)
     - **Homepage URL**: Your repository URL
     - **Webhook URL**: Where your app will receive events (update later)
     - **Webhook Secret**: Generate a secure random string
   - Set Permissions:
     - Repository permissions:
       - **Contents**: Read & write
       - **Pull requests**: Read & write
       - **Issues**: Read & write
       - **Metadata**: Read-only
     - Subscribe to events:
       - **Pull request**
       - **Push**
   - Save the App

2. **Generate Private Key**:
   - In your GitHub App settings
   - Under "Private keys", click "Generate a private key"
   - Save the downloaded .pem file securely

3. **Install the App**:
   - Go to your GitHub App settings
   - Click "Install App" in the sidebar
   - Choose the repositories where you want to use AutoRelease

### Self-Hosting

#### Prerequisites
- Node.js 18 or higher
- Yarn or npm
- OpenAI API key

#### Setup

1. **Clone the repository**:
   ```bash
   git clone https://github.com/rbkayz/autorelease.git
   cd autorelease
   ```

2. **Install dependencies**:
   ```bash
   yarn install
   ```

3. **Create environment file**:
   Create a `.env` file with the following variables:
   ```
   # GitHub App Configuration
   APP_ID=your_github_app_id
   GITHUB_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\nYour private key content with \n for line breaks\n-----END RSA PRIVATE KEY-----\n"
   WEBHOOK_SECRET=your_webhook_secret
   
   # Server Configuration
   PORT=8888
   WEBHOOK_PROXY_URL=https://smee.io/your-channel-id (optional, for local development)
   
   # OpenAI Configuration
   OPENAI_API_KEY=your_openai_api_key
   ```

4. **Build the application**:
   ```bash
   yarn build
   ```

5. **Start the server**:
   ```bash
   yarn start
   ```

### Docker Deployment

For easier deployment, you can use Docker:

1. **Build the Docker image**:
   ```bash
   yarn docker:build
   ```

2. **Run with Docker**:
   ```bash
   yarn docker:run
   ```

   This will start the container with the environment variables from your `.env` file.

3. **Push to a Docker registry** (optional):
   ```bash
   yarn docker:push
   ```

#### Additional Docker Commands

- **Stop the container**:
  ```bash
  yarn docker:stop
  ```

- **Combined build, push and run**:
  ```bash
  yarn docker:deploy
  ```

## Configuration

### Configuration File Location

Create a configuration file in your repository at:

## Repository Structure

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

## Usage Workflow

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