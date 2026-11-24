// Loads a TypeScript/TSX source module (and its local imports) in a vm
// context, compiled to CommonJS. Bare package imports use real packages unless
// overridden by `mocks`. Used to test Server Components and server modules
// without a bundler.
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const nodeRequire = createRequire(resolve(root, "package.json"));

function resolveSource(specifier, fromDir) {
  const base = specifier.startsWith("@/") ? resolve(root, "src", specifier.slice(2)) : resolve(fromDir, specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, resolve(base, "index.ts")]) {
    if (existsSync(candidate) && /\.tsx?$/.test(candidate)) return candidate;
  }
  return null;
}

export function loadTsModule(entry, mocks = {}) {
  const cache = new Map();

  function load(file) {
    if (cache.has(file)) return cache.get(file).exports;
    const mod = { exports: {} };
    cache.set(file, mod);
    const output = ts.transpileModule(readFileSync(file, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
      fileName: file,
    }).outputText;
    runInNewContext(output, {
      module: mod, exports: mod.exports, console, URL, URLSearchParams, Intl, Date, Math, Number, Promise, Error, TextEncoder, File, Blob, crypto,
      require(specifier) {
        if (Object.hasOwn(mocks, specifier)) return mocks[specifier];
        if (specifier.startsWith(".") || specifier.startsWith("@/")) {
          const source = resolveSource(specifier, dirname(file));
          if (!source) throw new Error(`Cannot resolve ${specifier} from ${file}`);
          return load(source);
        }
        return nodeRequire(specifier);
      },
    });
    return mod.exports;
  }

  return load(resolve(root, entry));
}
