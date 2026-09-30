export interface FieldError {
  path: string;
  message: string;
}

// The one error shape the API returns: { error: { code, message, fields?, request_id } }.
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fields: FieldError[] | undefined;
  readonly headers: Record<string, string> | undefined;

  constructor(
    status: number,
    code: string,
    message: string,
    opts: { fields?: FieldError[]; headers?: Record<string, string> } = {},
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.fields = opts.fields;
    this.headers = opts.headers;
  }
}

export const unauthorized = (message = "a valid bearer token is required") =>
  new ApiError(401, "unauthorized", message, {
    headers: { "www-authenticate": 'Bearer realm="noosphere"' },
  });
export const forbidden = (message: string) => new ApiError(403, "forbidden", message);
export const notFound = (what: string) => new ApiError(404, "not_found", `${what} not found`);
export const invalid = (path: string, message: string) =>
  new ApiError(400, "invalid_request", "request validation failed", {
    fields: [{ path, message }],
  });
