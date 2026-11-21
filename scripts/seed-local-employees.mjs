// Seeds demo employees into the LOCAL Supabase stack for manual UI testing.
// Refuses any non-loopback URL. Idempotent: existing emails are skipped.
//
//   npx supabase status -o env > .env.supabase-local
//   node --env-file=.env.supabase-local scripts/seed-local-employees.mjs
//
// Login passwords for the three role accounts are generated randomly and
// written to .env.seed-local (gitignored by `.env.*`). They are never printed.
//
// Note: the seeded Super Admin cannot be deleted while it is the only active
// Super Admin (last-admin protection). That is intended for local data.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { createClient } from "@supabase/supabase-js";

const url = process.env.API_URL;
const serviceKey = process.env.SECRET_KEY ?? process.env.SERVICE_ROLE_KEY;
if (!url || !serviceKey) throw new Error("Load `supabase status -o env` output first.");
if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname)) {
  throw new Error("Refusing to seed a non-local Supabase URL.");
}

const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const credentialsFile = new URL("../.env.seed-local", import.meta.url);
const saved = existsSync(credentialsFile)
  ? Object.fromEntries(readFileSync(credentialsFile, "utf8").split("\n").filter(Boolean).map((line) => line.split(/=(.*)/s).slice(0, 2)))
  : {};

const accounts = [
  { key: "SUPER_ADMIN", email: "admin@cyclo.test", full_name: "Ayesha Admin", role: "SUPER_ADMIN", employee_code: "AT-001", login: true, git: true },
  { key: "PROJECT_MANAGER", email: "pm@cyclo.test", full_name: "Priya Manager", role: "PROJECT_MANAGER", employee_code: "AT-002", login: true },
  { key: "DEVELOPER", email: "dev@cyclo.test", full_name: "Dev Kumar", role: "DEVELOPER", employee_code: "AT-003", login: true },
  { email: "former.pm@cyclo.test", full_name: "Former Manager", role: "PROJECT_MANAGER", employee_code: "AT-004", active: false },
  { email: "no.name@cyclo.test", full_name: null, role: "DEVELOPER", employee_code: null },
  { email: "percent@cyclo.test", full_name: "Zed 100% Literal", role: "DEVELOPER", employee_code: "AT_100" },
  ...Array.from({ length: 22 }, (_, i) => ({
    email: `developer${String(i + 1).padStart(2, "0")}@cyclo.test`,
    full_name: `Developer ${String(i + 1).padStart(2, "0")}`,
    role: "DEVELOPER",
    employee_code: `AT-${String(200 + i)}`,
    active: i % 7 !== 6,
  })),
];

const { data: existing, error: listError } = await admin.auth.admin.listUsers({ perPage: 1000 });
if (listError) throw listError;
const byEmail = new Map(existing.users.map((user) => [user.email, user]));

let created = 0;
let superAdminId = null;
for (const account of accounts) {
  let user = byEmail.get(account.email);
  if (!user) {
    const password = account.login ? randomBytes(18).toString("base64url") : randomBytes(32).toString("base64url");
    const { data, error } = await admin.auth.admin.createUser({ email: account.email, password, email_confirm: true });
    if (error) throw error;
    user = data.user;
    created += 1;
    if (account.login) saved[`SEED_${account.key}_PASSWORD`] = password;
  }
  if (account.login) saved[`SEED_${account.key}_EMAIL`] = account.email;
  if (account.role === "SUPER_ADMIN") superAdminId = user.id;

  const { error } = await admin.from("profiles").update({
    full_name: account.full_name,
    role: account.role,
    employee_code: account.employee_code,
    is_active: account.active ?? true,
    is_git_organizer: account.git ?? false,
    invited_by: account.role === "SUPER_ADMIN" ? null : superAdminId,
    onboarded_at: new Date().toISOString(),
  }).eq("id", user.id);
  if (error) throw error;
}

writeFileSync(credentialsFile, `${Object.entries(saved).map(([k, v]) => `${k}=${v}`).join("\n")}\n`);
console.log(`Seeded ${accounts.length} employees (${created} new). Role logins stored in .env.seed-local.`);
