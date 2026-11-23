import assert from "node:assert/strict";
import { test } from "node:test";
import { NEWEST_SUPPORTED_MCP_REVISION, shouldReport, statusFor, triageMcpError } from "../src/error-status.ts";
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

test("an older or supported version is a client mixing eras: dropped; only a newer one warns", () => {
  const prefix = "Rejected inbound request (modern-unsupported-version): ";
  assert.equal(triageMcpError("ProtocolError: Unsupported protocol version: 2025-06-18"), "drop");
  assert.equal(triageMcpError(`${prefix}Unsupported protocol version: 2025-06-18`), "drop");
  assert.equal(triageMcpError("Unsupported protocol version: 2024-11-05"), "drop");
  assert.equal(triageMcpError("Unsupported protocol version: 2026-07-28"), "drop");
  assert.equal(triageMcpError("Unsupported protocol version: 2099-01-01"), "warn");
  assert.equal(triageMcpError("Unsupported protocol version: 1999-01-01"), "drop");
  assert.equal(triageMcpError("Unsupported protocol version: unknown"), "drop");
  assert.equal(triageMcpError("SqliteError: database is locked"), "keep");
});

test("the newest-supported constant tracks the installed SDK (fails when the SDK moves on)", async () => {
  const sdk = await import("@modelcontextprotocol/server");
  const legacy = [...sdk.SUPPORTED_PROTOCOL_VERSIONS] as string[];
  assert.ok(legacy.every((v) => v <= NEWEST_SUPPORTED_MCP_REVISION), `the SDK's legacy list ${legacy} passes ${NEWEST_SUPPORTED_MCP_REVISION}: update src/error-status.ts`);
  assert.ok(sdk.LATEST_PROTOCOL_VERSION <= NEWEST_SUPPORTED_MCP_REVISION);
  // The modern list is not exported; the endpoint's own 400 names it (test/mcp-http.test.ts
  // asserts that list is exactly [NEWEST_SUPPORTED_MCP_REVISION]).
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
