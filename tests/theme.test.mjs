import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { loadTsModule } from "./helpers/load-ts-module.mjs";

const theme = loadTsModule("src/lib/theme/theme.ts");
const css = readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8");

test("untrusted cookie values fall back to system", () => {
  assert.equal(theme.parseThemePreference("dark"), "dark");
  assert.equal(theme.parseThemePreference("light"), "light");
  for (const value of ["system", "DARK", "", undefined, null, "dark; Path=/", 1]) {
    assert.equal(theme.parseThemePreference(value), "system", String(value));
  }
});

test("system leaves the html attribute unset so CSS follows the OS", () => {
  assert.equal(theme.themeAttribute("system"), undefined);
  assert.equal(theme.themeAttribute("dark"), "dark");
});

test("compact toggle cycles through every preference", () => {
  assert.equal(theme.nextThemePreference("system"), "light");
  assert.equal(theme.nextThemePreference("light"), "dark");
  assert.equal(theme.nextThemePreference("dark"), "system");
});

test("theme cookie is a scoped, long-lived, same-site UI preference", () => {
  assert.equal(theme.themeCookie("dark"), "cyclo-theme=dark; Path=/; Max-Age=31536000; SameSite=Lax");
});

function block(selector) {
  const start = css.indexOf(selector);
  assert.notEqual(start, -1, `missing ${selector}`);
  const open = css.indexOf("{", start);
  const body = css.slice(open + 1, css.indexOf("}", open));
  return body.split("\n").map((line) => line.trim()).filter((line) => line.startsWith("--") || line.startsWith("color-scheme")).join("\n");
}

test("explicit dark and system dark palettes are identical", () => {
  const explicit = block(':root[data-theme="dark"]');
  const system = block(':root:not([data-theme="light"])');
  assert.ok(explicit.includes("--primary:"));
  assert.equal(system, explicit);
});

test("both palettes define every token", () => {
  const light = block(":root {");
  const dark = block(':root[data-theme="dark"]');
  const names = (body) => body.split("\n").map((line) => line.split(":")[0]).sort();
  assert.deepEqual(names(dark), names(light));
});
