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

export function parseSummary(
  summary: string
): Array<{ type: string; bullets: string[] }> {
  const result: Array<{ type: string; bullets: string[] }> = [];
  const lines = summary
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line);

  let currentSection: { type: string; bullets: string[] } | null = null;

  for (const line of lines) {
    if (line === 'Features' || line === 'Fixes / Improvements') {
      // Start a new section
      if (currentSection) {
        result.push(currentSection);
      }
      currentSection = { type: line, bullets: [] };
    } else if (line.startsWith('-') && currentSection) {
      // Add bullet to current section
      currentSection.bullets.push(line);
    }
  }

  // Add the last section
  if (currentSection) {
    result.push(currentSection);
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
