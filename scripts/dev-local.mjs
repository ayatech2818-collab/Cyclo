// Runs the app against the LOCAL Supabase stack without editing .env.local.
// Process environment variables take precedence over .env.local in Next.js.
//
//   npx supabase status -o env > .env.supabase-local
//   node --env-file=.env.supabase-local scripts/dev-local.mjs [port] [--prod]
//
// --prod builds and runs `next start` instead of `next dev` (useful when another
// `next dev` server is already running for this project, which Next.js forbids).
// Note: the production build inlines the LOCAL public Supabase URL/key; run
// `pnpm build` again before deploying.
import { spawn } from "node:child_process";

const url = process.env.API_URL;
const publishableKey = process.env.PUBLISHABLE_KEY ?? process.env.ANON_KEY;
if (!url || !publishableKey) throw new Error("Load `supabase status -o env` output first.");
if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname)) {
  throw new Error("Refusing to point the app at a non-local Supabase URL.");
}

const args = process.argv.slice(2);
const prod = args.includes("--prod");
const port = args.find((arg) => /^\d{2,5}$/.test(arg)) ?? "3000";

const env = {
  ...process.env,
  NEXT_PUBLIC_SUPABASE_URL: url,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: publishableKey,
  // Never forward local admin secrets to the app process.
  SECRET_KEY: "",
  SERVICE_ROLE_KEY: "",
  JWT_SECRET: "",
  S3_PROTOCOL_ACCESS_KEY_SECRET: "",
};

function next(nextArgs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", ...nextArgs], { stdio: "inherit", env });
    child.on("exit", (code) => resolve(code ?? 0));
  });
}

if (prod) {
  const code = await next(["build", "--webpack"]);
  if (code !== 0) process.exit(code);
  process.exit(await next(["start", "--port", port]));
} else {
  process.exit(await next(["dev", "--webpack", "--port", port]));
}
