import { computed, ref, watch } from "vue";
import { intlLocale, t } from "../i18n";
import type { EditorStoreLike } from "../types";

function isSameDay(a: Date, b: Date) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

const locale = intlLocale;

function firstDayOfWeek(): number {
  try {
    const localeInfo = new Intl.Locale(locale) as Intl.Locale & {
      weekInfo?: { firstDay?: number };
    };
    const first = localeInfo.weekInfo?.firstDay;
    if (typeof first === "number") {
      // Intl.Locale uses 1..7 (Mon..Sun). Date.getDay uses 0..6 (Sun..Sat).
      return first % 7;
    }
  } catch {
    // Fallback below
  }

  return locale.toLowerCase().startsWith("en-us") ? 0 : 1;
}

function startOfWeek(date: Date) {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  const day = copy.getDay();
  const weekStartsOn = firstDayOfWeek();
  const diff = (day - weekStartsOn + 7) % 7;
  copy.setDate(copy.getDate() - diff);
  return copy;
}

function fmtTime(date: Date) {
  return new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(date);
}

function formatUpdatedAt(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";

  const now = new Date();
  const time = fmtTime(date);
  if (isSameDay(date, now)) return time;

  if (date >= startOfWeek(now)) {
    const weekday = new Intl.DateTimeFormat(locale, { weekday: "long" }).format(date);
    return `${weekday}, ${time}`;
  }

  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function useEditorStatus(store: () => EditorStoreLike, isReadonly: () => boolean) {
  const lastSyncTime = ref("");

  watch(
    () => store().syncState,
    (syncState, previousState) => {
      const enteredSynced = syncState === "synced" && previousState !== "synced";
      if (!enteredSynced) return;

      lastSyncTime.value = new Date().toLocaleTimeString(locale, {
        hour: "2-digit",
        minute: "2-digit",
      });
    },
    { immediate: true },
  );

  const statusMeta = computed(() => {
    const syncState = store().syncState;
    const { currentUpdatedAt, notes, selectedKey } = store();
    const modifiedRaw =
      currentUpdatedAt || notes.find((note) => note.key === selectedKey)?.updatedAt || "";
    const modifiedText = modifiedRaw ? formatUpdatedAt(modifiedRaw) : "";
    const modifiedLine = modifiedText ? `${t("modified")} ${modifiedText}` : "";

    const lines: string[] = [];

    if (isReadonly()) {
      if (modifiedLine) lines.push(modifiedLine);
      lines.push(t("shareReadonly"));
      return { state: "synced" as const, lines };
    }

    if (syncState === "offline") {
      lines.push(t("offline"));
      if (modifiedLine) lines.push(modifiedLine);
      lines.push(
        lastSyncTime.value ? `${t("synced")} ${lastSyncTime.value}` : t("changesSavedLocally"),
      );
      return { state: "offline" as const, lines };
    }

    if (syncState === "syncing") {
      if (modifiedLine) lines.push(modifiedLine);
      lines.push(store().syncStatus || t("syncingChanges"));
      return { state: "syncing" as const, lines };
    }

    if (syncState === "error") {
      if (modifiedLine) lines.push(modifiedLine);
      lines.push(store().syncStatus || t("syncError"));
      lines.push(
        lastSyncTime.value ? `${t("synced")} ${lastSyncTime.value}` : t("noSuccessfulSyncYet"),
      );
      return { state: "error" as const, lines };
    }

    const syncedAt = lastSyncTime.value ? ` ${lastSyncTime.value}` : "";
    if (modifiedLine) lines.push(modifiedLine);
    lines.push(`${t("synced")}${syncedAt}`);
    return { state: "synced" as const, lines };
  });

  const statusAriaLabel = computed(() => statusMeta.value.lines.join(", "));

  return { statusMeta, statusAriaLabel };
}
