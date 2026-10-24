import { useState } from "react";

// localStorage can throw (private mode, blocked storage); fall back to memory.
export function useStoredString(key: string, initial = ""): [string, (v: string) => void] {
  const [value, setValue] = useState<string>(() => {
    try {
      return localStorage.getItem(key) ?? initial;
    } catch {
      return initial;
    }
  });
  const set = (v: string) => {
    setValue(v);
    try {
      localStorage.setItem(key, v);
    } catch {
      // ignore
    }
  };
  return [value, set];
}
