import { Repository } from '@octokit/webhooks-types';
import OpenAI from 'openai';
import { ChatCompletionCreateParams } from 'openai/resources';
import { Context } from 'probot';
import winston from 'winston';
import { logger } from '../utils/logger';
import { RepoConfig } from '../utils/types';

export class ConfigService {
  public context: Context;
  public config: RepoConfig = ConfigService.DEFAULT_CONFIG;
  private openai: OpenAI;
  public logger: winston.Logger;

  static readonly DEFAULT_CONFIG: RepoConfig = {
    // GitHub repository details
    branches: {
      release: 'main',
      staging: 'staging',
    },

    // PR templates
    pr: {
      draftTitle: '{major}.{minor}.{patch} Release: {version}',
      draftBody: `## Features to be released

{features}

---
*This PR was automatically created by the Release Manager.*
*Last updated: {timestamp}*`,
      featuresSection: '## Features to be released',
    },

    // Release options
    release: {
      prefix: 'v',
      createDraft: false,
      prerelease: false,
      generateReleaseNotes: true,
    },

    // Changelog options
    changelog: {
      file: 'CHANGELOG.md',
      headerFormat: '# Changelog\n\n',
      entryFormat: '## {version} ({date})\n\n{features}\n\n',
    },

    // Tags for version bumping in PRs
    releaseTags: {
      major: '[MAJOR]',
      minor: '[MINOR]',
      patch: '[PATCH]',
    },

    // AI service settings
    ai: {
      enabled: true,
      openai: {
        model: 'gpt-4o-mini', // Default model
        temperature: 0.2,
        max_tokens: 2048,
      },
      featureSummaryPrompt:
        'You are a helpful assistant that generates concise summaries of feature changes in a GitHub repository. Focus on business value and benefits over technical details.',
      versionTypePrompt:
        'You are a versioning expert who helps determine the appropriate semantic version increment type for code changes. Analyze the changes and recommend MAJOR for breaking changes, MINOR for new features, or PATCH for bug fixes',
    },
  };

  constructor(context: Context) {
    this.context = context;
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY environment variable is not set');
    }

    this.openai = new OpenAI({
      apiKey: apiKey,
    });

    const repository: Repository = (context.payload as any).repository;

    if (!repository) {
      throw new Error('No repository found');
    }

    this.logger = logger.child({
      repo_name: repository.name,
      id: repository.id,
    });
  }

  /**
   * Load configuration from repository
   */
  public async loadConfig(): Promise<RepoConfig> {
    try {
      const { data: configFile, status } =
        await this.context.octokit.repos.getContent({
          owner: this.context.repo().owner,
          repo: this.context.repo().repo,
          path: '.github/release-manager.json',
        });

      // Decode config file
      if ('content' in configFile) {
        const configContent = Buffer.from(
          configFile.content,
          'base64'
        ).toString('utf-8');

        // Parse and merge with defaults
        const repoConfig = JSON.parse(configContent);
        const mergedConfig = this.mergeConfigs(
          ConfigService.DEFAULT_CONFIG,
          repoConfig
        );

        this.logger.info('Loaded configuration from repository');
        return mergedConfig;
      }

      throw new Error('Invalid config file format');
    } catch (error: any) {
      if (error.status === 404) {
        return ConfigService.DEFAULT_CONFIG;
      }
      throw error;
    }
  }

  /**
   * Deep merge two configuration objects
   */
  private mergeConfigs(
    defaultConfig: RepoConfig,
    customConfig: RepoConfig
  ): RepoConfig {
    const merged = { ...defaultConfig };

    for (const [key, value] of Object.entries(customConfig)) {
      if (
        value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        key in defaultConfig
      ) {
        // @ts-ignore - This is a safe operation but TypeScript can't infer it correctly
        merged[key] = this.mergeConfigs(defaultConfig[key], value);
      } else {
        // @ts-ignore - This is a safe operation but TypeScript can't infer it correctly
        merged[key] = value;
      }
    }

    return merged;
  }

  /* -------------------------------------------------------------------------- */
  /*                                   OPENAI                                   */
  /* -------------------------------------------------------------------------- */

  async callOpenAI({
    messages,
  }: {
    messages: ChatCompletionCreateParams['messages'];
  }) {
    const model = this.config.ai?.openai?.model;
    const temperature = this.config.ai?.openai?.temperature;
    const max_tokens = this.config.ai?.openai?.max_tokens;

    if (!this.config.ai?.enabled) {
      return null;
    }

    if (!model || !temperature || !max_tokens) {
      throw new Error('OpenAI configuration is missing required fields');
    }

    const response = await this.openai.chat.completions.create({
      model,
      messages,
      temperature,
      max_tokens,
    });

    if (!response.choices[0].message.content) {
      throw new Error('No response from OpenAI');
    }

    return response.choices[0].message.content;
  }
}
