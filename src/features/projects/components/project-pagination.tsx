import { PagePagination } from "@/components/shared/page-pagination";

import type { ProjectListQuery } from "../types";
import { projectsHref } from "../validation";

export function ProjectPagination({ query, pageCount, total }: { query: ProjectListQuery; pageCount: number; total: number }) {
  return (
    <PagePagination
      page={query.page}
      pageSize={query.pageSize}
      pageCount={pageCount}
      total={total}
      noun={{ one: "project", many: "projects" }}
      hrefFor={(page) => projectsHref(query, { page })}
    />
  );
}
