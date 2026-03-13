import { ref } from "vue";

export type ThemeFamily = "default" | "summer";

const STORAGE_KEY = "kladde.theme";

const THEME_COLORS: Record<ThemeFamily, { light: string; dark: string }> = {
  default: { light: "#f0ece4", dark: "#292321" },
  summer: { light: "#faf0e4", dark: "#1e1510" },
};

export const currentTheme = ref<ThemeFamily>("default");

function applyTheme(theme: ThemeFamily) {
  if (theme === "default") {
    document.documentElement.removeAttribute("data-theme");
  } else {
    document.documentElement.setAttribute("data-theme", theme);
  }

  const colors = THEME_COLORS[theme];
  const lightMeta = document.querySelector(
    'meta[name="theme-color"][media="(prefers-color-scheme: light)"]',
  );
  const darkMeta = document.querySelector(
    'meta[name="theme-color"][media="(prefers-color-scheme: dark)"]',
  );
  if (lightMeta) lightMeta.setAttribute("content", colors.light);
  if (darkMeta) darkMeta.setAttribute("content", colors.dark);
}

export function setTheme(theme: ThemeFamily) {
  currentTheme.value = theme;
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* ignore */
  }
  applyTheme(theme);
}

export function initTheme() {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }

  const theme: ThemeFamily = stored === "summer" ? "summer" : "default";
  currentTheme.value = theme;
  applyTheme(theme);
}
