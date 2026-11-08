"use client";
// DEV ONLY: forces the page theme after hydration (screenshots of /dev/publication?theme=…).
import { useEffect } from "react";

export function ForceTheme({ theme }: { theme: "light" | "dark" }) {
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  return null;
}
