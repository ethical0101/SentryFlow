const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * True if any own key at any depth could be used for prototype tampering. Must be checked on the
 * raw JSON value BEFORE schema parsing: zod's record parser assigns keys with `obj[key] = v`,
 * which turns an own `__proto__` key into a prototype change instead of a validation failure.
 */
export function hasDangerousKeys(value: unknown, depth = 0): boolean {
  if (depth > 20) return true;
  if (Array.isArray(value)) return value.some((v) => hasDangerousKeys(v, depth + 1));
  if (value && typeof value === "object") {
    for (const key of Object.getOwnPropertyNames(value)) {
      if (DANGEROUS_KEYS.has(key)) return true;
      if (hasDangerousKeys((value as Record<string, unknown>)[key], depth + 1)) return true;
    }
  }
  return false;
}
