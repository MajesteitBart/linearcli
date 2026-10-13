export class CliError extends Error {
  constructor(
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}
const secrets = new Set<string>();
export function rememberSecret(value: string | undefined) {
  if (value && value.length > 3) secrets.add(value);
}
export function redact(value: unknown): unknown {
  if (typeof value === "string") {
    let result = value
      .replace(/Bearer\s+[^\s"']+/gi, "Bearer [REDACTED]")
      .replace(
        /([?&](?:code|access_token|refresh_token|client_secret)=)[^&\s]+/gi,
        "$1[REDACTED]",
      );
    for (const secret of secrets)
      result = result.split(secret).join("[REDACTED]");
    return result;
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, val]) => [
        key,
        /^(?:access_token|refresh_token|client_secret|code_verifier|authorization|api_key)$/i.test(
          key,
        )
          ? "[REDACTED]"
          : redact(val),
      ]),
    );
  return value;
}
export function errorInfo(error: unknown) {
  const e =
    error instanceof CliError
      ? error
      : new CliError(
          "REQUEST_FAILED",
          error instanceof Error ? error.message : String(error),
        );
  return redact({
    code: e.code,
    message: e.message,
    ...(e.details === undefined ? {} : { details: e.details }),
  });
}
