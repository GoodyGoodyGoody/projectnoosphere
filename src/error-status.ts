// Which errors are worth reporting, decided ONCE for both the app's error
// handler and Sentry (src/instrument.ts). No Fastify or Sentry imports: this
// module loads before either.
//
// Why it exists: Sentry's default Fastify rule reports an error when the reply
// status is ">= 500 OR <= 299", read at the moment the error is thrown. For a
// validation error or a rejected token our error handler has not set the
// 400/401 yet, so the status still reads 200 and the client's mistake was
// reported as a server error (PROJECTNOOSPHERE-2, -3, -4).

// The status an error will be answered with (mirrors app.ts's setErrorHandler).
export function statusFor(err: unknown): number {
  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>;
    if (typeof e["status"] === "number" && typeof e["code"] === "string") return e["status"] as number; // ApiError
    if (e["validation"]) return 400;
    if (e["code"] === "FST_ERR_CTP_BODY_TOO_LARGE") return 413;
    if (e["code"] === "FST_ERR_CTP_INVALID_MEDIA_TYPE") return 415;
    if (typeof e["statusCode"] === "number") return e["statusCode"] as number;
  }
  return 500;
}

// Only server faults are reported; a client's bad request is the client's.
export function shouldReport(err: unknown): boolean {
  return statusFor(err) >= 500;
}

// MCP transport errors arrive through Sentry's MCP integration, not Fastify.
// Malformed or invalid requests are the client's mistake: drop them. An
// unsupported protocol version is different: it means the endpoint is behind
// the protocol (how PROJECTNOOSPHERE-5 was found), so keep it as a warning.
export type McpTriage = "keep" | "warn" | "drop";
export function triageMcpError(message: string): McpTriage {
  if (/unsupported protocol version/i.test(message)) return "warn";
  if (/^(Error: )?(Bad Request|Invalid params|Invalid Request|Parse error|Method not found|Not Acceptable|Unsupported Media Type)\b/i.test(message)) return "drop";
  return "keep";
}
