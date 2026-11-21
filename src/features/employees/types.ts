import type { AppRole } from "@/features/auth/access";

export const APP_ROLES = ["SUPER_ADMIN", "PROJECT_MANAGER", "DEVELOPER"] as const satisfies readonly AppRole[];

export const ROLE_LABELS: Record<AppRole, string> = {
  SUPER_ADMIN: "Super Admin",
  PROJECT_MANAGER: "Project Manager",
  DEVELOPER: "Developer",
};

/** Roles allowed to open the employee directory. Enforced again in the database. */
export const DIRECTORY_ROLES = ["SUPER_ADMIN", "PROJECT_MANAGER"] as const satisfies readonly AppRole[];

/**
 * Directory DTO: the only employee fields Project Managers receive.
 * Never add administrative fields here; use EmployeeAdminDetail instead.
 */
export type EmployeeDirectoryItem = {
  id: string;
  fullName: string | null;
  avatarUrl: string | null;
  email: string | null;
  employeeCode: string | null;
  role: AppRole;
  isActive: boolean;
};

/** Super Admin only. */
export type EmployeeAdminDetail = EmployeeDirectoryItem & {
  isGitOrganizer: boolean;
  invitedBy: string | null;
  invitedByName: string | null;
  onboardedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/** The signed-in employee's own profile. */
export type OwnProfile = EmployeeDirectoryItem & {
  isGitOrganizer: boolean;
  onboardedAt: string | null;
};

export type EmployeeStatusFilter = "all" | "active" | "inactive";

export type EmployeeDirectoryQuery = {
  search: string;
  role: AppRole | null;
  status: EmployeeStatusFilter;
  page: number;
  pageSize: number;
};

export type EmployeeDirectoryPage = {
  items: EmployeeDirectoryItem[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
};
