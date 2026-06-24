import { test } from "node:test";
import assert from "node:assert/strict";
import { logLine } from "../../utils/log.ts";

test("logLine formats as [timestamp][from][to] - content", () => {
  const line = logLine("A", "B", "SEND x=100");
  assert.match(line, /^\[.+\]\[A\]\[B\] - SEND x=100$/);
  // the leading [...] is a parseable ISO timestamp
  const ts = line.slice(1, line.indexOf("]"));
  assert.ok(!Number.isNaN(Date.parse(ts)));
});
