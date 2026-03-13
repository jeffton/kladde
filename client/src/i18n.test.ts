import { describe, expect, test } from "vite-plus/test";
import { resolveUiLocale } from "./i18n";

describe("resolveUiLocale", () => {
  test("detects supported languages from browser locale prefixes", () => {
    expect(resolveUiLocale("da-DK")).toBe("da");
    expect(resolveUiLocale("sv-SE")).toBe("sv");
    expect(resolveUiLocale("fr-CA")).toBe("fr");
  });

  test("falls back to en-US for unknown or missing locales", () => {
    expect(resolveUiLocale("de-DE")).toBe("en-US");
    expect(resolveUiLocale("")).toBe("en-US");
    expect(resolveUiLocale()).toBe("en-US");
  });
});
