import assert from "node:assert/strict";
import test from "node:test";
import { findRepairTask, listRepairTaskNames, REPAIR_TASKS } from "../src/repairTasks.js";

test("repair tasks are complete and uniquely named", () => {
  const names = listRepairTaskNames();

  assert.equal(names.length, REPAIR_TASKS.length);
  assert.equal(new Set(names).size, names.length);
  assert.ok(names.includes("order-service"));
  assert.ok(names.includes("truncate-boundary"));
  assert.ok(names.includes("date-pad"));
  assert.ok(names.includes("cross-module-contract"));
  assert.ok(names.includes("rounding-boundary"));
});

test("every repair task declares source, test, and a test entry point", () => {
  for (const task of REPAIR_TASKS) {
    assert.ok(task.files.length >= 3, `${task.name} should define several files`);
    assert.ok(task.files.some((file) => file.path === "package.json"), `${task.name} should include package.json`);
    assert.ok(task.files.some((file) => file.path.startsWith("src/")), `${task.name} should include a source file`);
    assert.ok(task.files.some((file) => file.path.startsWith("tests/")), `${task.name} should include a test`);
  }
});

test("findRepairTask resolves by name and returns undefined for unknown names", () => {
  assert.equal(findRepairTask("order-service")?.name, "order-service");
  assert.equal(findRepairTask("truncate-boundary")?.name, "truncate-boundary");
  assert.equal(findRepairTask("date-pad")?.name, "date-pad");
  assert.equal(findRepairTask("cross-module-contract")?.name, "cross-module-contract");
  assert.equal(findRepairTask("rounding-boundary")?.name, "rounding-boundary");
  assert.equal(findRepairTask("missing"), undefined);
});