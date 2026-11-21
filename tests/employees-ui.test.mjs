import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

import { loadTsModule } from "./helpers/load-ts-module.mjs";

const require = createRequire(import.meta.url);
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");

const nextLinkMock = {
  __esModule: true,
  default: ({ href, children, ...props }) => React.createElement("a", { href, ...props }, children),
};
const mocks = { "next/link": nextLinkMock };

/** The opening tag that contains `attribute` (attribute order independent). */
function tagWith(html, attribute) {
  const index = html.indexOf(attribute);
  assert.notEqual(index, -1, `missing ${attribute}`);
  return html.slice(html.lastIndexOf("<", index), html.indexOf(">", index) + 1);
}

const format = loadTsModule("src/features/employees/format.ts");
const validation = loadTsModule("src/features/employees/validation.ts");

const ID = "00000000-0000-4000-a000-000000000001";
const OTHER = "00000000-0000-4000-a000-000000000002";
const directory = {
  id: OTHER, fullName: "Paula <b>Manager</b>", avatarUrl: null, email: "paula@cyclo.test",
  employeeCode: "AT-003", role: "PROJECT_MANAGER", isActive: false,
};
const admin = {
  ...directory, isGitOrganizer: true, invitedBy: ID, invitedByName: "Alice Admin",
  onboardedAt: null, createdAt: "2026-11-01T09:30:00Z", updatedAt: "2026-11-02T10:00:00Z",
};

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test("display name and initials fall back safely", () => {
  assert.equal(format.displayName("  ", "a@b.test"), "a@b.test");
  assert.equal(format.displayName(null, null), "Unnamed employee");
  assert.equal(format.initials("Alice Mary Admin", null), "AA");
  assert.equal(format.initials(null, "john.doe@x.test"), "JD");
  assert.equal(format.initials(null, null), "?");
});

test("avatar URLs must be https", () => {
  assert.equal(format.safeAvatarUrl("https://cdn.test/a.png"), "https://cdn.test/a.png");
  for (const url of ["http://cdn.test/a.png", "javascript:alert(1)", "data:image/png;base64,AA", "//cdn.test/a.png", "nope", null]) {
    assert.equal(format.safeAvatarUrl(url), null, String(url));
  }
});

test("timestamps are deterministic UTC", () => {
  assert.equal(format.formatDateTime("2026-11-01T09:30:00Z"), "1 Nov 2026, 09:30 UTC");
  assert.equal(format.formatDateTime("garbage"), null);
  assert.equal(format.formatDateTime(null), null);
});

test("pagination items show neighbours, ends and gaps", () => {
  const items = (page, count) => JSON.stringify(format.paginationItems(page, count));
  assert.equal(items(1, 1), "[1]");
  assert.equal(items(1, 3), "[1,2,3]");
  assert.equal(items(5, 10), '[1,"gap",4,5,6,"gap",10]');
  assert.equal(items(3, 10), '[1,2,3,4,"gap",10]', "a single hidden page is shown instead of a gap");
  assert.equal(items(10, 10), '[1,"gap",9,10]');
});

test("directory access gate and links", () => {
  assert.equal(validation.canViewDirectory("SUPER_ADMIN"), true);
  assert.equal(validation.canViewDirectory("PROJECT_MANAGER"), true);
  assert.equal(validation.canViewDirectory("DEVELOPER"), false);
  const query = validation.parseDirectoryQuery({ q: "a&b", role: "DEVELOPER", page: "3" });
  assert.equal(validation.directoryHref(query), "/employees?q=a%26b&role=DEVELOPER&page=3");
  assert.equal(validation.directoryHref(query, { page: 1 }), "/employees?q=a%26b&role=DEVELOPER");
  assert.equal(validation.hasActiveFilters(validation.parseDirectoryQuery({ page: "2" })), false);
});

// ---------------------------------------------------------------------------
// Components (server-rendered)
// ---------------------------------------------------------------------------

test("directory table renders directory fields, escapes content and links to details", () => {
  const { EmployeeTable } = loadTsModule("src/features/employees/components/employee-table.tsx", mocks);
  const html = renderToStaticMarkup(React.createElement(EmployeeTable, { employees: [directory], currentUserId: ID }));
  assert.match(html, /Paula &lt;b&gt;Manager&lt;\/b&gt;/, "names are escaped");
  assert.match(html, /paula@cyclo\.test/);
  assert.match(html, /AT-003/);
  assert.match(html, /Project Manager/);
  assert.match(html, /Inactive/);
  assert.match(html, new RegExp(`href="/employees/${OTHER}"`));
  assert.match(html, /aria-label="View details for Paula &lt;b&gt;Manager&lt;\/b&gt;"/);
  assert.doesNotMatch(html, /Git|Invited|Onboard/i, "no administrative fields");
  assert.doesNotMatch(html, />You</, "only the current user is tagged");
});

test("current user is tagged in the table", () => {
  const { EmployeeTable } = loadTsModule("src/features/employees/components/employee-table.tsx", mocks);
  const html = renderToStaticMarkup(React.createElement(EmployeeTable, { employees: [{ ...directory, id: ID }], currentUserId: ID }));
  assert.match(html, />You</);
});

test("avatar renders https images only, otherwise initials", () => {
  const { EmployeeAvatar } = loadTsModule("src/features/employees/components/employee-avatar.tsx", mocks);
  const image = renderToStaticMarkup(React.createElement(EmployeeAvatar, { fullName: "A B", email: null, avatarUrl: "https://cdn.test/a.png" }));
  assert.match(image, /<img[^>]+src="https:\/\/cdn\.test\/a\.png"[^>]+alt=""/);
  assert.match(image, /referrerPolicy="no-referrer"|referrerpolicy="no-referrer"/i);
  const fallback = renderToStaticMarkup(React.createElement(EmployeeAvatar, { fullName: "A B", email: null, avatarUrl: "javascript:alert(1)" }));
  assert.doesNotMatch(fallback, /<img|javascript/);
  assert.match(fallback, />AB</);
});

test("directory detail shows approved fields only; admin card shows admin fields", () => {
  const details = loadTsModule("src/features/employees/components/employee-details.tsx", mocks);
  const directoryHtml = renderToStaticMarkup(React.createElement(details.EmployeeDirectoryFields, { employee: admin }));
  assert.match(directoryHtml, /AT-003/);
  assert.doesNotMatch(directoryHtml, /Git Organizer|Alice Admin|Onboarding|Created/, "directory card ignores extra fields");

  const adminHtml = renderToStaticMarkup(React.createElement(details.EmployeeAdminFields, { employee: admin }));
  assert.match(adminHtml, /Git Organizer/);
  assert.match(adminHtml, /Granted/);
  assert.match(adminHtml, /Alice Admin/);
  assert.match(adminHtml, /Not completed/);
  assert.match(adminHtml, /<time dateTime="2026-11-01T09:30:00Z">1 Nov 2026, 09:30 UTC<\/time>/);
});

test("pagination marks the current page and preserves filters", () => {
  const { Pagination } = loadTsModule("src/features/employees/components/pagination.tsx", mocks);
  const query = validation.parseDirectoryQuery({ q: "dev", status: "active", page: "2" });
  const html = renderToStaticMarkup(React.createElement(Pagination, { query, pageCount: 3, total: 45 }));
  assert.match(html, /Showing <span[^>]*>21–40<\/span> of <span[^>]*>45<\/span>/);
  const page2 = tagWith(html, 'aria-label="Page 2"');
  assert.match(page2, /href="\/employees\?q=dev&amp;status=active&amp;page=2"/);
  assert.match(page2, /aria-current="page"/);
  assert.doesNotMatch(tagWith(html, 'aria-label="Page 3"'), /aria-current/);
  assert.match(tagWith(html, 'aria-label="Previous page"'), /href="\/employees\?q=dev&amp;status=active"/);
  assert.match(tagWith(html, 'aria-label="Next page"'), /href="\/employees\?q=dev&amp;status=active&amp;page=3"/);
  const single = renderToStaticMarkup(React.createElement(Pagination, { query: validation.parseDirectoryQuery({}), pageCount: 1, total: 3 }));
  assert.doesNotMatch(single, /<nav/, "no pagination controls for one page");
});

test("filters render a GET search form with current values", () => {
  const { EmployeeFilters } = loadTsModule("src/features/employees/components/employee-filters.tsx", mocks);
  const query = validation.parseDirectoryQuery({ q: "ali", role: "DEVELOPER", status: "inactive" });
  const html = renderToStaticMarkup(React.createElement(EmployeeFilters, { query }));
  const form = tagWith(html, 'role="search"');
  assert.match(form, /method="get"/);
  assert.match(form, /action="\/employees"/);
  assert.match(html, /<label for="employee-search"/);
  assert.match(html, /name="q"[^>]*value="ali"/);
  assert.match(html, /maxLength="100"/);
  assert.match(html, /<option value="DEVELOPER" selected="">/);
  assert.match(html, /<option value="inactive" selected="">/);
  assert.match(html, />Clear</);
});

// ---------------------------------------------------------------------------
// Page error handling
// ---------------------------------------------------------------------------

test("page loader hides forbidden data as 404 and redirects expired sessions", async () => {
  // Share one errors module so instanceof checks match.
  const errors = loadTsModule("src/features/employees/errors.ts");
  const interrupt = (kind) => { throw Object.assign(new Error(kind), { interrupt: kind }); };
  const { loadForPage } = loadTsModule("src/features/employees/page-errors.server.ts", {
    "server-only": {},
    "./errors": errors,
    "next/navigation": { notFound: () => interrupt("notFound"), redirect: (to) => interrupt(`redirect:${to}`) },
  });
  const failWith = (code) => loadForPage(async () => { throw new errors.EmployeeError(code); });

  assert.equal(JSON.stringify(await loadForPage(async () => 42)), '{"data":42,"error":null}');
  await assert.rejects(failWith("forbidden"), { interrupt: "notFound" }, "forbidden is indistinguishable from missing");
  await assert.rejects(failWith("not_found"), { interrupt: "notFound" });
  await assert.rejects(failWith("unauthenticated"), { interrupt: "redirect:/login" });
  assert.equal(JSON.stringify(await failWith("unavailable")), '{"data":null,"error":"unavailable"}');
  assert.equal(JSON.stringify(await failWith("invalid_input")), '{"data":null,"error":"invalid_input"}');
  const passthrough = new Error("NEXT_REDIRECT");
  await assert.rejects(loadForPage(async () => { throw passthrough; }), (e) => e === passthrough, "framework errors are rethrown");
});
