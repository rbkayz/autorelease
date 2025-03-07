export function calculateNewVersion(
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

/**
 * Parses an AI-generated summary into sections
 * @param aiSummary - The AI-generated summary text
 * @returns Array of section objects with type and bullets
 */
export function parseSummary(aiSummary: string): { type: string; bullets: string[] }[] {
  // Define section constants to match those in PRService
  const FEATURES_SECTION = 'New Features';
  const BUGS_SECTION = 'Bugs / Improvements';

  // Initialize result with the correct section types
  const result: { type: string; bullets: string[] }[] = [
    { type: FEATURES_SECTION, bullets: [] },
    { type: BUGS_SECTION, bullets: [] }
  ];

  // If no summary, return empty sections
  if (!aiSummary || aiSummary.trim() === '') {
    return result;
  }

  // Split by sections more accurately - look for section headers
  const featuresSectionRegex = new RegExp(`${FEATURES_SECTION}[\\s\\S]*?(?=\\s*${BUGS_SECTION}|$)`, 'i');
  const bugsSectionRegex = new RegExp(`${BUGS_SECTION}[\\s\\S]*$`, 'i');

  const featuresMatch = aiSummary.match(featuresSectionRegex);
  const bugsMatch = aiSummary.match(bugsSectionRegex);

  // Process features section
  if (featuresMatch && featuresMatch[0]) {
    const featuresContent = featuresMatch[0].replace(FEATURES_SECTION, '').trim();
    const bulletRegex = /^[-*]\s+(.+)$/gm;
    let match: RegExpExecArray | null;
    
    while ((match = bulletRegex.exec(featuresContent)) !== null) {
      if (match[1] && match[1].trim()) {
        result[0].bullets.push(match[1].trim());
      }
    }
  }

  // Process bugs section
  if (bugsMatch && bugsMatch[0]) {
    const bugsContent = bugsMatch[0].replace(BUGS_SECTION, '').trim();
    const bulletRegex = /^[-*]\s+(.+)$/gm;
    let match: RegExpExecArray | null;
    
    while ((match = bulletRegex.exec(bugsContent)) !== null) {
      if (match[1] && match[1].trim()) {
        result[1].bullets.push(match[1].trim());
      }
    }
  }

  return result;
}

export function updateSection(
  body: string,
  sectionHeader: string,
  newEntry: string
): string {
  // If section doesn't exist in the body
  if (!body.includes(sectionHeader)) {
    return `${body}\n\n${sectionHeader}\n${newEntry}`;
  }

  // Find the section position
  const sectionPos = body.indexOf(sectionHeader);

  // Find the next section (if any)
  const nextSectionMatch = body
    .slice(sectionPos + sectionHeader.length)
    .match(/^## /m);
  const nextSectionPos = nextSectionMatch
    ? sectionPos + sectionHeader.length + (nextSectionMatch.index ?? 0)
    : body.length;

  // Extract the current section content
  const sectionContent = body.slice(
    sectionPos + sectionHeader.length,
    nextSectionPos
  );

  // Remove placeholder comments
  const cleanSectionContent = sectionContent.replace(/<!-- .*? -->\n?/g, '');

  // Determine if we need to add a newline based on existing content
  const existingContent = cleanSectionContent.trim();

  // Create updated section with new entry at the top, but without extra newlines
  let updatedSection;
  if (!existingContent) {
    // If no existing content, just add the header and new entry
    updatedSection = `${sectionHeader}\n${newEntry}`;
  } else if (existingContent.startsWith('\n')) {
    // If existing content already has a newline at the beginning
    updatedSection = `${sectionHeader}\n${newEntry}${existingContent}`;
  } else {
    // Add a single newline between header and content
    updatedSection = `${sectionHeader}\n${newEntry}\n${existingContent}`;
  }

  // Replace the old section with the updated one
  return (
    body.slice(0, sectionPos) + updatedSection + body.slice(nextSectionPos)
  );
}
