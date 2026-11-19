/**
 * Best-effort scrubbing of secrets from prompts before they are shared via
 * git notes. The raw prompt only ever lives in the local .prompttrace DB.
 */
const PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]"],
  [/\bsk-ant-[A-Za-z0-9_-]{10,}/g, "[REDACTED_ANTHROPIC_KEY]"],
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g, "[REDACTED_OPENAI_KEY]"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "[REDACTED_GITHUB_TOKEN]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "[REDACTED_GITHUB_TOKEN]"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "[REDACTED_SLACK_TOKEN]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED_AWS_KEY]"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, "[REDACTED_GOOGLE_KEY]"],
  [/\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}/g, "[REDACTED_STRIPE_KEY]"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[REDACTED_JWT]"],
  [/\b(Bearer)\s+[A-Za-z0-9._~+/-]{16,}=*/gi, "$1 [REDACTED]"],
  [/([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, "$1[REDACTED]@"],
  // KEY=value / "password": "value" style assignments for sensitive-sounding names
  [
    /\b([A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|CREDENTIALS?)[A-Za-z0-9_]*)(["']?\s*[:=]\s*["']?)([^\s"']{6,})/gi,
    "$1$2[REDACTED]",
  ],
];

export function redact(text: string): string {
  let out = text;
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max) + `\n… [truncated ${text.length - max} chars]`;
}
