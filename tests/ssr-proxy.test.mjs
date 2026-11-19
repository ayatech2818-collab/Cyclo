import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { runInNewContext } from "node:vm";

import ts from "typescript";

const require = createRequire(import.meta.url);
const { NextRequest, NextResponse } = require("next/server");
const source = readFileSync(new URL("../src/lib/supabase/proxy.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function proxyFor(status) {
  const testModule = { exports: {} };
  let claimsChecked = false;
  const mocks = {
    "next/server": { NextResponse },
    "./env": { getSupabaseEnv: () => ({ url: "https://example.supabase.co", publishableKey: "test-placeholder" }) },
    "@supabase/ssr": {
      createServerClient(_url, _key, { cookies }) {
        return {
          auth: {
            async getClaims() {
              claimsChecked = true;
              cookies.setAll([
                { name: "test-session", value: "refreshed-placeholder", options: { path: "/", httpOnly: true, sameSite: "lax" } },
                { name: "test-old-chunk", value: "", options: { path: "/", maxAge: 0 } },
              ], { "Cache-Control": "private, no-store", "Pragma": "no-cache", "Expires": "0" });
            },
          },
        };
      },
    },
    "@/features/auth/access": {
      async getAccess() {
        assert.equal(claimsChecked, true, "session refresh must precede authorization");
        return { status };
      },
    },
  };
  runInNewContext(compiled, {
    module: testModule,
    exports: testModule.exports,
    URL,
    require(name) {
      assert.ok(Object.hasOwn(mocks, name), `unexpected dependency ${name}`);
      return mocks[name];
    },
  });
  return testModule.exports.updateSession;
}

test("protected redirects preserve refreshed cookies, deletions, and cache headers", async () => {
  const request = new NextRequest("http://localhost/dashboard");
  const response = await proxyFor("anonymous")(request);
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "http://localhost/login");
  assert.equal(request.cookies.get("test-session").value, "refreshed-placeholder");
  assert.equal(response.cookies.get("test-session").value, "refreshed-placeholder");
  assert.equal(response.cookies.get("test-session").httpOnly, true);
  assert.equal(response.cookies.get("test-old-chunk").maxAge, 0);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("pragma"), "no-cache");
  assert.equal(response.headers.get("expires"), "0");
});

test("future application and API paths are denied for unapproved profiles", async () => {
  for (const path of ["/dashboard", "/projects/123", "/api/future.json"]) {
    const response = await proxyFor("denied")(new NextRequest(`http://localhost${path}`));
    assert.equal(response.headers.get("location"), "http://localhost/login?error=denied");
  }
});

test("authorized login redirects and protected routes continue without caching", async () => {
  const proxy = proxyFor("authorized");
  const login = await proxy(new NextRequest("http://localhost/login"));
  assert.equal(login.headers.get("location"), "http://localhost/dashboard");
  const dashboard = await proxy(new NextRequest("http://localhost/dashboard"));
  assert.equal(dashboard.status, 200);
  assert.equal(dashboard.headers.get("location"), null);
  assert.equal(dashboard.headers.get("cache-control"), "private, no-store");
});

test("unavailable profiles fail closed and logout failures can be retried", async () => {
  const unavailable = await proxyFor("unavailable")(new NextRequest("http://localhost/dashboard"));
  assert.equal(unavailable.headers.get("location"), "http://localhost/login?error=unavailable");
  const retry = await proxyFor("authorized")(new NextRequest("http://localhost/login?error=logout_failed"));
  assert.equal(retry.headers.get("location"), null);
});
