export interface RepoConfig {
  branches?: {
    main?: string;
    staging?: string;
  };
  pr?: {
    draftTitle?: string;
    draftBody?: string;
    featuresSection?: string;
  };
  release?: {
    prefix?: string;
    createDraft?: boolean;
    prerelease?: boolean;
    generateReleaseNotes?: boolean;
  };
  changelog?: {
    file?: string;
    headerFormat?: string;
    entryFormat?: string;
  };
  releaseTags?: {
    major?: string;
    minor?: string;
    patch?: string;
  };
  ai?: {
    enabled?: boolean;
    openai?: {
      model?: string;
      temperature?: number;
      max_tokens?: number;
    };
    featureSummaryPrompt?: string;
    versionTypePrompt?: string;
  };
}
