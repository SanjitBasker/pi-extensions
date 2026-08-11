import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { justify, truncate } from "./index.ts";

test("truncate respects ANSI sequences and Unicode display width", () => {
  const styled = "\x1b[31m界界界\x1b[0m";
  const output = truncate(styled, 5);
  assert.ok(visibleWidth(output) <= 5);
  assert.ok(output.includes("..."));
});

test("justify pads by terminal columns", () => {
  const output = justify("界", "\x1b[32mok\x1b[0m", 10);
  assert.equal(visibleWidth(output), 10);
  assert.match(output, /ok/);
});
