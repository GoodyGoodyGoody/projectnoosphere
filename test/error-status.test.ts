import assert from "node:assert/strict";
import { test } from "node:test";
import { shouldReport, statusFor, triageMcpError } from "../src/error-status.ts";
import { ApiError } from "../src/errors.ts";

test("client mistakes are not reported; server faults are", () => {
  assert.equal(statusFor(Object.assign(new Error("bad"), { validation: [{}] })), 400);
  assert.equal(shouldReport(Object.assign(new Error("bad"), { validation: [{}] })), false);
  assert.equal(shouldReport(new ApiError(401, "unauthorized", "unknown or revoked token")), false);
  assert.equal(shouldReport(Object.assign(new Error("big"), { code: "FST_ERR_CTP_BODY_TOO_LARGE", statusCode: 413 })), false);
  assert.equal(shouldReport(new Error("boom")), true);
  assert.equal(shouldReport(new ApiError(503, "unavailable", "down")), true);
});

test("MCP transport errors: client mistakes dropped, protocol gaps kept as warnings", () => {
  assert.equal(triageMcpError("Bad Request: Unsupported protocol version: 2099-01-01"), "warn");
  assert.equal(triageMcpError("Invalid params: missing the required per-request envelope key(s): _meta"), "drop");
  assert.equal(triageMcpError("Error: Parse error: Invalid JSON"), "drop");
  assert.equal(triageMcpError("TypeError: cannot read properties of undefined"), "keep");
});
