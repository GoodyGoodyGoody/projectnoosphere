export interface FieldError {
  path: string;
  message: string;
  location?: string; // body | querystring | params | headers
}

// The one error shape the API returns: { error: { code, message, fields?, request_id } }.
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fields: FieldError[] | undefined;
  readonly headers: Record<string, string> | undefined;
  // Machine-readable specifics a client can act on, e.g. the current revision id
  // on a stale-base conflict. Never internal state.
  readonly details: Record<string, unknown> | undefined;

  constructor(
    status: number,
    code: string,
    message: string,
    opts: {
      fields?: FieldError[];
      headers?: Record<string, string>;
      details?: Record<string, unknown>;
    } = {},
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.fields = opts.fields;
    this.headers = opts.headers;
    this.details = opts.details;
  }
}

export const unauthorized = (message = "a valid bearer token is required") =>
  new ApiError(401, "unauthorized", message, {
    headers: { "www-authenticate": 'Bearer realm="noosphere"' },
  });
export const forbidden = (message: string) => new ApiError(403, "forbidden", message);
export const notFound = (what: string) => new ApiError(404, "not_found", `${what} not found`);
export const conflict = (code: string, message: string, details?: Record<string, unknown>) =>
  new ApiError(409, code, message, details ? { details } : {});
export const invalid = (path: string, message: string) =>
  new ApiError(400, "invalid_request", "request validation failed", {
    fields: [{ path, message }],
  });
