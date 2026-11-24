import { t } from "../i18n";
import type { ShareMode } from "../types";

function makeClientOrigin(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export const clientOrigin = makeClientOrigin();

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export function isNotFoundError(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404;
}

function withCollectionQuery(path: string, collection?: string | null): string {
  const normalizedCollection = collection?.trim() ?? "";
  if (!normalizedCollection) return path;

  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}collection=${encodeURIComponent(normalizedCollection)}`;
}

export function notePathApi(title: string, collection?: string | null): string {
  return withCollectionQuery(`/client-api/notes/${encodeURIComponent(title)}`, collection);
}

export function renameNotePathApi(title: string, collection?: string | null): string {
  return withCollectionQuery(`/client-api/notes/${encodeURIComponent(title)}/rename`, collection);
}

export function starNotePathApi(title: string, collection?: string | null): string {
  return withCollectionQuery(`/client-api/notes/${encodeURIComponent(title)}/star`, collection);
}

export function shareNotePathApi(
  title: string,
  collection?: string | null,
  mode?: ShareMode,
): string {
  const base = withCollectionQuery(
    `/client-api/notes/${encodeURIComponent(title)}/share`,
    collection,
  );
  if (!mode) return base;
  const separator = base.includes("?") ? "&" : "?";
  return `${base}${separator}mode=${encodeURIComponent(mode)}`;
}

export function sharedNotePathApi(token: string): string {
  return `/client-api/share/${encodeURIComponent(token)}/note`;
}

const API_FETCH_TIMEOUT_MS = 10000;

type ApiRequestInit = Omit<RequestInit, "signal">;

export async function apiFetch(path: string, init?: ApiRequestInit): Promise<Response> {
  const method = (init?.method ?? "GET").toUpperCase();
  const headers = new Headers(init?.headers);
  if (method !== "GET" && method !== "HEAD") {
    headers.set("X-Kladde-Origin", clientOrigin);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), API_FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(path, { ...init, headers, signal: controller.signal });
  } catch (err: unknown) {
    if (controller.signal.aborted) throw new Error("REQUEST_TIMEOUT", { cause: err });
    throw err;
  } finally {
    clearTimeout(timeout);
  }

  if (res.status === 401) throw new Error("UNAUTHORIZED");
  if (!res.ok) {
    const payload = (await res.json().catch(() => null)) as { error: string } | null;
    throw new ApiError(res.status, payload?.error ?? t("requestFailed"));
  }
  return res;
}
