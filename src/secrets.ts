const SECRET_PATTERNS: Array<{ replacement: string; source: RegExp }> = [
  {
    source: /(api[_-]?key|authorization|token)\s*[:=]\s*("[^"\n]{1,512}"|'[^'\n]{1,512}'|[^\s&;,]{8,})/gi,
    replacement: "$1=<redacted>",
  },
  {
    source: /\b(sk-|sk-ant-)[A-Za-z0-9_-]{12,}\b/g,
    replacement: "sk-...[redacted]",
  },
  {
    source: /(Bearer\s+)[A-Za-z0-9._~+/\-=]{8,}/g,
    replacement: "$1[redacted]",
  },
  {
    source: /("(?:apiKey|api_key|authorization|access_token|accessToken)"\s*:\s*")[^"\n]{1,512}(")/gi,
    replacement: "$1[redacted]$2",
  },
  {
    source: /\b(OPENAI_API_KEY|CCAGENT_API_KEY|ANTHROPIC_API_KEY|GEMINI_API_KEY)\s*=\s*("[^"\n]*"|[^\s;,]+)/gi,
    replacement: "$1=<redacted>",
  },
];

export function redactSecrets(text: string): string {
  let redacted = text;

  for (const { replacement, source } of SECRET_PATTERNS) {
    redacted = redacted.replace(source, replacement);
  }

  return redacted;
}
