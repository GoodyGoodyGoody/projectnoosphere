import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  cellVerdict,
  DESCRIPTIVE_CONDITION_KEYS,
  environmentKeys,
  groupByConditions,
  normalizeConditionValue,
  type CellReport,
} from "../src/modules/conditions.ts";

let n = 0;
const rep = (outcome: string, conditions: Record<string, unknown>, extra: Partial<CellReport> = {}): CellReport => ({
  report_id: `ann_${String(++n).padStart(3, "0")}`,
  author_id: "con_a",
  outcome,
  checked: true,
  conditions,
  created_at: `2026-11-${String(10 + (n % 10)).padStart(2, "0")}T00:00:00.000Z`,
  ...extra,
});

describe("normalizeConditionValue", () => {
  test("OS wordings that are the same condition", () => {
    assert.equal(normalizeConditionValue("Ubuntu 24.04.1"), "ubuntu 24.04");
    assert.equal(normalizeConditionValue("ubuntu-24.04"), "ubuntu 24.04");
    assert.equal(normalizeConditionValue("  Ubuntu   24.04 "), "ubuntu 24.04");
    assert.equal(normalizeConditionValue("ubuntu_24.04"), "ubuntu 24.04");
  });
  test("versions: a leading v dropped, cut to two parts", () => {
    assert.equal(normalizeConditionValue("v24.19.0"), "24.19");
    assert.equal(normalizeConditionValue("24.19.3"), "24.19");
    assert.equal(normalizeConditionValue("node v24.19.0"), "node 24.19");
    assert.equal(normalizeConditionValue("OpenSSL 3.0.13"), "openssl 3.0");
    assert.equal(normalizeConditionValue("24.19"), "24.19");
    assert.equal(normalizeConditionValue("dev2"), "dev2", "a v inside a word is kept");
    assert.notEqual(normalizeConditionValue("24.19"), normalizeConditionValue("24.20"));
  });
  test("non-string values go through JSON", () => {
    assert.equal(normalizeConditionValue(24), "24");
    assert.equal(normalizeConditionValue(true), "true");
    assert.equal(normalizeConditionValue({ A: "B" }), '{"a":"b"}');
  });
});

describe("grouping by the revision's own conditions", () => {
  test("descriptive keys are not environment", () => {
    for (const k of ["date", "observed", "observed_via", "limitations", "notes", "window", "items"]) {
      assert.ok(DESCRIPTIVE_CONDITION_KEYS.includes(k), k);
    }
    assert.deepEqual(environmentKeys({ os: "x", date: "2026", node: "24", Notes: "n" }), ["os", "node"]);
  });

  test("cells by the revision's keys; report-only keys and descriptive keys ignored; not stated", () => {
    const g = groupByConditions(
      { os: "Ubuntu 24.04", node: "24", date: "2026-10-01", notes: "x" },
      [
        rep("worked", { os: "Ubuntu 24.04.1", node: "v24.19.0", date: "2026-11-01", npm: "10" }),
        rep("worked", { os: "ubuntu-24.04", node: "24.19.3", date: "2026-11-02", npm: "11" }),
        rep("failed", { os: "Debian 12", node: "24.19.0" }),
        rep("worked", { os: "Debian 12" }),
      ],
    );
    assert.deepEqual(g.grouped_by, ["os", "node"]);
    assert.equal(g.cells.length, 3);
    const ubuntu = g.cells.find((c) => c.label.startsWith("os Ubuntu"))!;
    assert.equal(ubuntu.reports, 2, "date or npm split a cell");
    assert.equal(ubuntu.label, "os Ubuntu 24.04.1 · node v24.19.0", "label is not the first report's wording");
    assert.equal(ubuntu.verdict, "worked");
    const notStated = g.cells.find((c) => c.conditions.node === null)!;
    assert.equal(notStated.label, "os Debian 12 · node not stated");
    assert.equal(notStated.verdict, "worked");
    assert.equal(g.cells.find((c) => c.label === "os Debian 12 · node 24.19.0")!.verdict, "failed");
  });

  test("a revision with no environment keys groups by the reports' os, else one cell", () => {
    const byOs = groupByConditions({ date: "2026" }, [rep("worked", { os: "macOS 15" }), rep("failed", { os: "Linux" }), rep("worked", { node: "24" })]);
    assert.deepEqual(byOs.grouped_by, ["os"]);
    assert.equal(byOs.cells.length, 3);
    const one = groupByConditions({}, [rep("worked", { node: "24" }), rep("failed", { node: "26" })]);
    assert.deepEqual(one.grouped_by, []);
    assert.equal(one.cells.length, 1);
    assert.equal(one.cells[0]!.reports, 2);
  });

  test("no reports, no cells", () => {
    assert.deepEqual(groupByConditions({ os: "x" }, []).cells, []);
  });
});

describe("cell verdicts", () => {
  test("agreeing reports", () => {
    assert.equal(cellVerdict([{ outcome: "worked", checked: true }, { outcome: "worked", checked: false }]), "worked");
    assert.equal(cellVerdict([{ outcome: "failed", checked: true }]), "failed");
    assert.equal(cellVerdict([{ outcome: "partially_worked", checked: true }]), "partially_worked");
  });
  test("a checked failure against worked reports is disputed", () => {
    assert.equal(cellVerdict([{ outcome: "worked", checked: true }, { outcome: "failed", checked: true }]), "disputed");
    assert.equal(cellVerdict([{ outcome: "partially_worked", checked: true }, { outcome: "failed", checked: true }]), "disputed");
  });
  test("an unchecked failure against worked reports is only mixed", () => {
    assert.equal(cellVerdict([{ outcome: "worked", checked: true }, { outcome: "failed", checked: false }]), "mixed");
    assert.equal(cellVerdict([{ outcome: "worked", checked: true }, { outcome: "inconclusive", checked: false }]), "mixed");
  });

  test("per cell: counts, checks, distinct contributors, newest date; disputed first", () => {
    const g = groupByConditions({ node: "24" }, [
      rep("worked", { node: "26" }, { author_id: "con_a" }),
      rep("worked", { node: "24.1.0" }, { author_id: "con_a", created_at: "2026-11-01T00:00:00.000Z" }),
      rep("worked", { node: "24.1.5" }, { author_id: "con_b", checked: false, created_at: "2026-11-03T00:00:00.000Z" }),
      rep("worked", { node: "24.1" }, { author_id: "con_b", created_at: "2026-11-02T00:00:00.000Z" }),
      rep("failed", { node: "v24.1.2" }, { author_id: "con_c", created_at: "2026-11-02T12:00:00.000Z" }),
    ]);
    assert.equal(g.cells.length, 2);
    const c = g.cells[0]!;
    assert.equal(c.verdict, "disputed", "disputed cell is not first");
    assert.deepEqual(c.outcomes, { worked: 3, failed: 1 });
    assert.deepEqual(c.outcomes_with_check, { worked: 2, failed: 1 });
    assert.equal(c.with_check, 3);
    assert.equal(c.contributors, 3);
    assert.equal(c.latest_at, "2026-11-03T00:00:00.000Z");
    assert.equal(c.label, "node 24.1.0", "label is not the earliest report's wording");
    assert.equal(g.cells[1]!.verdict, "worked");
  });
});
