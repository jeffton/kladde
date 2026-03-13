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

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

export async function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const method = (
    init?.method ||
    (input instanceof Request ? input.method : "GET") ||
    "GET"
  ).toUpperCase();
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), API_FETCH_TIMEOUT_MS);

  let requestInit: RequestInit = {
    ...init,
    signal: init?.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal,
  };

  if (method !== "GET" && method !== "HEAD") {
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    if (init?.headers) {
      const extra = new Headers(init.headers);
      extra.forEach((value, key) => headers.set(key, value));
    }
    headers.set("X-Kladde-Origin", clientOrigin);
    requestInit = { ...requestInit, headers };
  }

  let res: Response;
  try {
    res = await fetch(input, requestInit);
  } catch (err: unknown) {
    if (isAbortError(err)) {
      throw new Error("REQUEST_TIMEOUT", { cause: err });
    }
    throw err;
  } finally {
    window.clearTimeout(timeout);
  }

  if (res.status === 401) {
    throw new Error("UNAUTHORIZED");
  }

  if (!res.ok) {
    let message = t("requestFailed");
    try {
      const payload = (await res.json()) as { error: string };
      message = payload.error;
    } catch {
      // no-op
    }
    throw new ApiError(res.status, message);
  }

  return res;
}
