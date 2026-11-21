# Employee avatar URL policy

Phase 4 administrative profile edits use the same deliberate URL subset in
`avatar-url-policy.ts` and `private.is_valid_employee_avatar_url(text)`.
`tests/fixtures/avatar-url-cases.json` drives both application validation and
authenticated direct-RPC integration tests. No validation performs DNS lookups
or fetches an image.

- NULL and the empty string clear the avatar.
- Nonempty values must start with `https://`, case-insensitively, and contain at
  most 2,048 Unicode code points. Values are preserved, not repaired or trimmed.
- Whitespace, C0/C1 control characters, DEL, BOM, and backslashes are rejected,
  including leading/trailing whitespace. A whitespace-only value is invalid.
- The authority is a host with an optional decimal port from 1 through 65535.
  Leading zeros in ports are allowed. Empty, signed, fractional and out-of-range
  ports are rejected. Userinfo (`username[:password]@`) is always rejected.
- Hosts may be ASCII DNS names (1–63 letters/digits/hyphens per label; no leading
  or trailing hyphen; at most 253 characters excluding an optional final dot),
  single-label names such as localhost, canonical dotted-decimal IPv4, or
  bracketed IPv6, including IPv4-mapped IPv6. IPv4 octets are 0–255 without
  leading zeros. IPv6 subnet prefixes and zone identifiers are rejected.
- International hostnames use their ASCII/punycode spelling. Unicode is allowed
  in paths, queries and fragments, subject to the whitespace/control exclusion.
- Encoded authorities, underscores in DNS labels, raw Unicode hostnames,
  abbreviated/octal/hex/integer IPv4 spellings, and numeric/hex final DNS labels
  are outside the accepted subset. This avoids relying on WHATWG browser URL
  repair or having PostgreSQL interpret the same authority differently.

This policy preserves ordinary HTTPS avatar URLs, explicit valid ports and IP
literal URLs. It checks syntax, not hostname existence or image content. The
existing HTTPS database constraint and HTTPS-only image renderer remain in place.
