export function normalizeSearchText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export interface FuzzySearchField {
  text: string | null | undefined;
  weight?: number;
}

function searchWords(value: string): string[] {
  return normalizeSearchText(value).match(/[\p{L}\p{N}]+/gu) ?? [];
}

function fuzzyWordSubsequenceScore(word: string, token: string): number | null {
  if (token.length < 3) return null;

  // Try every occurrence of the token's first character as a possible start,
  // not just the leftmost one. A single leftmost-match greedy scan can commit
  // to an early occurrence of token[0], fail to find the rest of the token
  // within the spread cutoff below, and give up -- even when a later
  // occurrence of token[0] leads to a tight, valid subsequence match. Scanning
  // from every candidate start and keeping the best passing score avoids that
  // false negative.
  let bestScore: number | null = null;

  for (let startIndex = 0; startIndex < word.length; startIndex += 1) {
    if (word[startIndex] !== token[0]) continue;

    let tokenIndex = 1;
    let lastIndex = startIndex;
    let gaps = 0;

    for (
      let wordIndex = startIndex + 1;
      wordIndex < word.length && tokenIndex < token.length;
      wordIndex += 1
    ) {
      if (word[wordIndex] !== token[tokenIndex]) continue;
      gaps += wordIndex - lastIndex - 1;
      lastIndex = wordIndex;
      tokenIndex += 1;
    }

    if (tokenIndex !== token.length) continue;

    const spread = lastIndex - startIndex + 1;
    if (spread > token.length * 2) continue;

    const score = 32 + gaps * 2 + startIndex + Math.max(0, word.length - token.length) * 0.5;
    if (bestScore === null || score < bestScore) {
      bestScore = score;
    }
  }

  return bestScore;
}

function scoreTokenAgainstText(text: string, token: string): number | null {
  if (!token) return 0;

  const words = searchWords(text);
  if (words.length === 0) return null;

  let bestScore = Number.POSITIVE_INFINITY;

  words.forEach((word, wordIndex) => {
    let score: number | null = null;
    if (word === token) {
      score = 0;
    } else if (word.startsWith(token)) {
      score = 8 + (word.length - token.length) * 0.25;
    } else {
      const substringIndex = word.indexOf(token);
      if (substringIndex >= 0) {
        score = 16 + substringIndex + (word.length - token.length) * 0.1;
      } else {
        score = fuzzyWordSubsequenceScore(word, token);
      }
    }

    if (score !== null) {
      bestScore = Math.min(bestScore, score + wordIndex * 0.05);
    }
  });

  const compactText = words.join("");
  const compactIndex = compactText.indexOf(token);
  if (compactIndex >= 0) {
    bestScore = Math.min(bestScore, 24 + compactIndex * 0.05);
  }

  const initials = words.map((word) => word[0]).join("");
  if (token.length <= 4) {
    if (initials.startsWith(token)) {
      bestScore = Math.min(bestScore, 28 + (initials.length - token.length) * 0.25);
    } else {
      const initialsIndex = initials.indexOf(token);
      if (initialsIndex >= 0) {
        bestScore = Math.min(bestScore, 36 + initialsIndex);
      }
    }
  }

  return Number.isFinite(bestScore) ? bestScore : null;
}

export function scoreFuzzyTextFields(fields: readonly FuzzySearchField[], query: string): number | null {
  const queryTokens = searchWords(query);
  if (queryTokens.length === 0) return 0;

  let totalScore = 0;

  for (const token of queryTokens) {
    let bestTokenScore = Number.POSITIVE_INFINITY;

    fields.forEach((field, fieldIndex) => {
      const text = field.text ?? "";
      const score = scoreTokenAgainstText(text, token);
      if (score === null) return;
      bestTokenScore = Math.min(bestTokenScore, score + (field.weight ?? fieldIndex * 20));
    });

    if (!Number.isFinite(bestTokenScore)) return null;
    totalScore += bestTokenScore;
  }

  return totalScore;
}

export function scoreFuzzyTextMatch(text: string, query: string): number | null {
  return scoreFuzzyTextFields([{ text }], query);
}

export function fuzzyTextMatchesQuery(text: string, query: string): boolean {
  return scoreFuzzyTextMatch(text, query) !== null;
}
