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
  // As the SDK's onerror delivers them (strings captured from @modelcontextprotocol/server 2.3.0).
  assert.equal(triageMcpError("Rejected inbound request (modern-header-without-claim): Invalid params: the MCP-Protocol-Version header names protocol revision 2026-07-28, but the request is missing the required per-request envelope key(s): _meta"), "drop");
  assert.equal(triageMcpError("Unsupported protocol version: 2099-01-01"), "warn");
});

test("scanner junk is dropped; a real newer version and internal errors still reach Sentry", () => {
  // PROJECTNOOSPHERE-5: bogus version.
  assert.equal(triageMcpError("ProtocolError: Unsupported protocol version: 1999-01-01"), "drop");
  assert.equal(triageMcpError("Unsupported protocol version: banana"), "drop");
  // Real-looking newer versions are the upgrade signal.
  assert.equal(triageMcpError("Unsupported protocol version: 2027-03-01"), "warn");
  // PROJECTNOOSPHERE-6: params-less initialize, zod issues as the SDK answers them.
  const zod = JSON.stringify([{ expected: "string", code: "invalid_type", path: ["params", "protocolVersion"], message: "Invalid input: expected string, received undefined" }], null, 2);
  assert.equal(triageMcpError(zod), "drop");
  assert.equal(triageMcpError("SqliteError: database is locked"), "keep");
  assert.equal(triageMcpError("mcp: caller address missing from authInfo"), "keep");
});
