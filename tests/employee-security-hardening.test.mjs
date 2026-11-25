import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsModule } from "./helpers/load-ts-module.mjs";

const cases = JSON.parse(readFileSync(new URL("./fixtures/avatar-url-cases.json", import.meta.url), "utf8"));
const validation = loadTsModule("src/features/employees/mutation-validation.ts");

for (const { label, value, valid } of cases) {
  test(`avatar URL policy: ${label}`, () => {
    if (valid) {
      const result = validation.validateEmployeeDetails("Name", value);
      assert.equal(result.avatarUrl, value || null);
    } else {
      assert.throws(() => validation.validateEmployeeDetails("Name", value), { code: "invalid_input" });
    }
  });
}
