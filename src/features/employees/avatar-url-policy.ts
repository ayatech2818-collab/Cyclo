import { isIP } from "node:net";

// Keep in sync with private.is_valid_employee_avatar_url and the shared
// tests/fixtures/avatar-url-cases.json corpus. See docs/employee-management/AVATAR_URL_POLICY.md.
const DISALLOWED = /[\u0000-\u0020\u007f-\u009f\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]/u;
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

function validHost(host: string): boolean {
  if (isIP(host) === 4) return true;
  const dns = host.endsWith(".") ? host.slice(0, -1) : host;
  if (!dns || dns.length > 253) return false;
  const labels = dns.split(".");
  // WHATWG treats numeric/hex final labels as IPv4, including abbreviated
  // forms. Only canonical four-component IPv4 is accepted above.
  if (/^(?:[0-9]+|0x[0-9a-f]+)$/i.test(labels[labels.length - 1])) return false;
  return labels.every(label => DNS_LABEL.test(label));
}

/** Syntax validation only: no DNS resolution, URL repair, or network access. */
export function isValidEmployeeAvatarUrl(value: string | null): boolean {
  if (value === null || value === "") return true;
  if ([...value].length > 2048 || DISALLOWED.test(value) || value.includes("\\")) return false;
  const url = /^https:\/\/([^/?#]+)(?:[/?#].*)?$/i.exec(value);
  if (!url || url[1].includes("@")) return false;
  const authority = url[1];
  let port: string | undefined;
  if (authority.startsWith("[")) {
    const parts = /^\[([^\]]+)\](?::([0-9]+))?$/.exec(authority);
    if (!parts || !/^[0-9a-f:.]+$/i.test(parts[1]) || isIP(parts[1]) !== 6) return false;
    port = parts[2];
  } else {
    const parts = /^([^:]+)(?::([0-9]+))?$/.exec(authority);
    if (!parts || !validHost(parts[1])) return false;
    port = parts[2];
  }
  if (port !== undefined) {
    const number = Number(port);
    if (!Number.isInteger(number) || number < 1 || number > 65535) return false;
  }
  return true;
}
