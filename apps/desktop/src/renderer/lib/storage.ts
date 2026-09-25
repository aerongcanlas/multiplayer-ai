/** localStorage conveniences; a blocked or full store is ignored. */
export function getStored(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function setStored(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* Stored values are conveniences only. */
  }
}
