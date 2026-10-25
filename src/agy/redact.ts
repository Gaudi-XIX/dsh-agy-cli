// Key part allows the surrounding quotes JSON produces: `"token": "v"` must
// match even though the separator sits one character after the sensitive word.
const SENSITIVE_ASSIGNMENT = /["']?(authorization|bearer|access[_-]?token|refresh[_-]?token|token|api[_-]?key|password|secret)["']?\s*[:=]\s*(?:bearer\s+)?(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi
const SENSITIVE_QUERY = /([?&](?:access[_-]?token|refresh[_-]?token|api[_-]?key|token|password|secret)=)[^&#\s]+/gi
// Bare token shapes that carry no key at all: the sk- keys this workspace's
// own commit discipline greps for, and credentials in a URL userinfo section.
const BARE_SK_TOKEN = /\bsk-[A-Za-z0-9]{20,}\b/g
const URL_USERINFO = /[a-z][a-z0-9+.-]*:\/\/[^/?#\s]+:[^/?#\s]+@/gi
const WINDOWS_USER_PATH = /[A-Za-z]:\\Users\\[^\s"'`,;)]*/g
const UNIX_USER_PATH = /\/(?:Users|home)\/[^\s"'`,;)]*/g
const ENV_ASSIGNMENT = /\b[A-Z][A-Z0-9_]{2,}=(?:"[^"]*"|'[^']*'|[^\s,;]+)/g

/** Redact common credentials, environment assignments, and user-home prefixes. */
export function redactText(value: string, maxLength = 1_000): string {
  return value
    .replace(SENSITIVE_ASSIGNMENT, '$1=[REDACTED]')
    .replace(SENSITIVE_QUERY, '$1[REDACTED]')
    .replace(BARE_SK_TOKEN, '[REDACTED]')
    .replace(URL_USERINFO, '[REDACTED]@')
    .replace(ENV_ASSIGNMENT, '[ENV]=[REDACTED]')
    .replace(WINDOWS_USER_PATH, '<user-path>')
    .replace(UNIX_USER_PATH, '<user-path>')
    .slice(0, maxLength)
}
