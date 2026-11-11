// Data shapes of the GitHub REST adapter shared by its modules.

/**
 * A file to commit at a repo-relative path. Provide `content` for UTF-8 text, or
 * `contentBase64` for binary (e.g. images) — binary files are uploaded as blobs
 * first, since the tree API only takes text inline. Exactly one must be set.
 */
export interface FileChange {
  path: string;
  content?: string;
  contentBase64?: string;
}

/** The authenticated GitHub user, as far as this app reads it. */
export interface GitHubUser {
  /** Numeric account id — stable across username (login) changes. */
  id: number;
  login: string;
  name: string | null;
  avatar_url: string;
}

/** A repo as returned by the create/read endpoints (fields this app reads). */
export interface RepoData {
  /** Numeric repo id — stable across rename/transfer. */
  id: number;
  html_url: string;
  full_name: string;
  name: string;
  owner: { login: string };
  default_branch: string;
  permissions?: { push?: boolean };
  private: boolean;
  /** The template the repository was generated from; null when none. */
  template_repository?: { full_name: string } | null;
  message?: string;
  errors?: Array<{ message?: string; code?: string }>;
}

/** A repo summary for the listing page. */
export interface RepoSummary {
  /** Numeric repo id — stable across rename/transfer. */
  id: number;
  full_name: string;
  name: string;
  owner: string | undefined;
  html_url: string;
  private: boolean;
  description: string | null;
  updated_at: string;
  created_at: string;
}

/** A repo's stable numeric id resolved to its current owner/name. */
export interface RepoRef {
  id: number;
  owner: string;
  repo: string;
}

export interface ErrorResponse {
  message?: string;
}
