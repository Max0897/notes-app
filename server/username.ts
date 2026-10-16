// Pure validation shared with the registration form; no server dependencies.
export const USERNAME_PATTERN = '[A-Za-z][A-Za-z0-9_]{2,31}';
export const USERNAME_RULE = '用户名须为 3–32 位，以英文字母开头，仅支持英文字母、数字和下划线';
const usernamePattern = new RegExp(`^(?:${USERNAME_PATTERN})$`);

export function isValidNewUsername(value: unknown): value is string {
  // JS "$" also matches before a final newline. Compare the entire match so
  // whitespace cannot be silently trimmed into a different account name.
  return typeof value === 'string' && value.length >= 3 && value.length <= 32
    && usernamePattern.exec(value)?.[0] === value;
}
