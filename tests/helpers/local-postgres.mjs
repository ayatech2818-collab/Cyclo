// Trusted fixture/lock orchestration only. Never connects to a hosted database.
import { spawn, spawnSync } from "node:child_process";

function args() {
  const url = process.env.API_URL;
  if (!url || !["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname)) {
    throw new Error("Local Supabase URL required for database test orchestration.");
  }
  return ["exec", "-i", "supabase_db_Cyclone", "psql", "-X", "-U", "postgres", "-d", "postgres", "-At", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose"];
}

export function localSql(query) {
  const result = spawnSync("docker", args(), { input: query, encoding: "utf8", timeout: 10_000 });
  if (result.error) throw result.error;
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

export function startLocalSql(query, { keepOpen = false } = {}) {
  const child = spawn("docker", args(), { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const completed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", code => resolve({ code, stdout, stderr }));
  });
  if (keepOpen) child.stdin.write(query); else child.stdin.end(query);
  return { child, completed, output: () => stdout };
}

export async function lockFixtureRows(ids) {
  if (!ids.every(id => /^[0-9a-f-]{36}$/i.test(id))) throw new Error("Invalid fixture UUID.");
  const connection = startLocalSql(`begin;
    select id from public.profiles where id in (${ids.map(id => `'${id}'`).join(",")}) order by id for update;
    select 'LOCK_READY';\n`, { keepOpen: true });
  let finished = false;
  const finish = async (query = "rollback;") => {
    if (finished) return;
    finished = true;
    connection.child.stdin.end(query + "\n\\q\n");
    const result = await connection.completed;
    if (result.code !== 0) throw new Error(result.stderr || "Lock fixture failed.");
  };
  try {
    await pollUntil(() => connection.output().includes("LOCK_READY"));
  } catch (error) {
    await finish();
    throw error;
  }
  return { finish };
}

export async function pollUntil(predicate) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for local database lock state.");
}
