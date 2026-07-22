import { createContext, useContext, useEffect, useMemo, useState, type PropsWithChildren } from "react";

export type ThemePreference = "system" | "light" | "dark" | "glass";
const STORAGE_KEY = "polymarket-workbench-theme";
const ThemeContext = createContext<Readonly<{ preference: ThemePreference; setPreference: (value: ThemePreference) => void }> | null>(null);

function savedPreference(): ThemePreference {
  const value = globalThis.localStorage?.getItem(STORAGE_KEY);
  return value === "light" || value === "dark" || value === "glass" ? value : "system";
}

export function ThemeProvider({ children }: PropsWithChildren) {
  const [preference, setPreference] = useState<ThemePreference>(savedPreference);
  useEffect(() => {
    const media = globalThis.matchMedia?.("(prefers-color-scheme: light)") ?? { matches: false, addEventListener: () => undefined, removeEventListener: () => undefined };
    const apply = () => {
      const resolved = preference === "system" ? (media.matches ? "light" : "dark") : preference;
      document.documentElement.dataset.theme = resolved;
      document.documentElement.dataset.themePreference = preference;
      document.documentElement.style.colorScheme = resolved === "light" ? "light" : "dark";
    };
    apply();
    media.addEventListener("change", apply);
    globalThis.localStorage?.setItem(STORAGE_KEY, preference);
    return () => media.removeEventListener("change", apply);
  }, [preference]);
  const value = useMemo(() => ({ preference, setPreference }), [preference]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const value = useContext(ThemeContext);
  if (value === null) throw new Error("useTheme must be used inside ThemeProvider");
  return value;
}
