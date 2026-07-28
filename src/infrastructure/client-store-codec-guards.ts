export function assertStringArray(
  value: unknown,
  label: string,
  min: number,
  max: number,
): string[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    throw new Error(`Stored client ${label} is invalid`);
  }
  if (value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new Error(`Stored client ${label} entries are invalid`);
  }
  return [...value] as string[];
}

export function assertEpoch(
  value: unknown,
  label: string,
): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`Stored client ${label} is invalid`);
  }
}

export function assertPositiveEpoch(
  value: unknown,
  label: string,
): asserts value is number {
  assertEpoch(value, label);
  if (value < 1) throw new Error(`Stored client ${label} is invalid`);
}

export function parseJsonColumn(value: unknown, label: string): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`Stored client ${label} is invalid JSON`);
  }
}

export function asRecord(
  value: unknown,
  label: string,
): Record<PropertyKey, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<PropertyKey, unknown>;
}

export function assertExactKeys(
  value: Record<PropertyKey, unknown>,
  required: string[],
  optional: string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new Error("Stored client contains unknown fields");
    }
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw new Error("Stored client is missing required fields");
    }
  }
}
