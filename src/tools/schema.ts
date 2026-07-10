import type { JSONSchema } from "./types.ts";

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

type SchemaNode = {
  type?: string | string[];
  enum?: unknown[];
  properties?: Record<string, unknown>;
  required?: string[];
  items?: unknown;
};

function node(value: unknown): SchemaNode {
  return value && typeof value === "object" ? (value as SchemaNode) : {};
}

function typeNames(schema: SchemaNode): string[] {
  if (Array.isArray(schema.type)) return schema.type;
  return typeof schema.type === "string" ? [schema.type] : [];
}

function matchesType(value: unknown, type: string): boolean {
  if (type === "array") return Array.isArray(value);
  if (type === "object") return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  if (type === "number" || type === "integer") return typeof value === "number" && Number.isFinite(value) && (type !== "integer" || Number.isInteger(value));
  if (type === "string") return typeof value === "string";
  if (type === "boolean") return typeof value === "boolean";
  if (type === "null") return value === null;
  return true;
}

function valueLabel(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

function validateNode(value: unknown, schemaLike: unknown, path: string, errors: string[]): void {
  const schema = node(schemaLike);
  const types = typeNames(schema);
  if (types.length && !types.some((t) => matchesType(value, t))) {
    errors.push(`${path} must be ${types.join(" or ")}, got ${valueLabel(value)}`);
    return;
  }

  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path} must be one of ${schema.enum.map((v) => JSON.stringify(v)).join(", ")}`);
    return;
  }

  if (Array.isArray(value) && schema.items) {
    value.forEach((item, i) => validateNode(item, schema.items, `${path}[${i}]`, errors));
    return;
  }

  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const props = schema.properties ?? {};
    for (const key of schema.required ?? []) {
      if (!(key in obj)) errors.push(`${path}.${key} is required`);
    }
    for (const [key, propSchema] of Object.entries(props)) {
      if (key in obj) validateNode(obj[key], propSchema, `${path}.${key}`, errors);
    }
  }
}

export function validateToolArguments(toolName: string, schema: JSONSchema, args: Record<string, unknown>): ValidationResult {
  const errors: string[] = [];
  validateNode(args, schema, toolName, errors);
  return { ok: errors.length === 0, errors };
}

