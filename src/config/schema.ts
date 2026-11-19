// A small typed schema: each node validates a value from settings.json, knows its default, and
// describes itself as JSON Schema (completions and hover help when the file is open in VS
// Code). TypeScript types are inferred from the schema, so the settings type, its validation
// and its documentation never drift apart. Pure, no runtime imports (tested with node --test).

export type Severity = 'error' | 'warning';

/** A problem found in the file. Errors reject the whole file; warnings only inform. */
export interface Issue {
  /** Dotted path: `appearance.fontSize`, `profiles.list[2].args`. Empty for the whole file. */
  path: string;
  message: string;
  severity: Severity;
  /** 1-based position, for JSON syntax errors. */
  line?: number;
  column?: number;
}

export type JsonSchema = { [key: string]: unknown };

export interface Schema<T> {
  readonly default: T;
  /** Validates `value` (never undefined): on a problem it records an issue and returns the default. */
  parse(value: unknown, path: string, issues: Issue[]): T;
  json(): JsonSchema;
}

export type Infer<S> = S extends Schema<infer T> ? T : never;

const join = (path: string, key: string) => (path ? `${path}.${key}` : key);
const error = (issues: Issue[], path: string, message: string) => issues.push({ path, message, severity: 'error' });
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

interface Common<T> {
  default: T;
  description?: string;
}

export function boolean(options: Common<boolean>): Schema<boolean> {
  return {
    default: options.default,
    parse(value, path, issues) {
      if (typeof value === 'boolean') return value;
      error(issues, path, 'tiene que ser true o false');
      return options.default;
    },
    json: () => ({ type: 'boolean', default: options.default, description: options.description }),
  };
}

export function number(options: Common<number> & { min: number; max: number; integer?: boolean }): Schema<number> {
  return {
    default: options.default,
    parse(value, path, issues) {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        error(issues, path, 'tiene que ser un número');
      } else if (options.integer && !Number.isInteger(value)) {
        error(issues, path, 'tiene que ser un número entero');
      } else if (value < options.min || value > options.max) {
        error(issues, path, `tiene que estar entre ${options.min} y ${options.max}`);
      } else {
        return value;
      }
      return options.default;
    },
    json: () => ({
      type: options.integer ? 'integer' : 'number',
      minimum: options.min,
      maximum: options.max,
      default: options.default,
      description: options.description,
    }),
  };
}

export function string(options: Common<string> & { examples?: () => string[]; nonEmpty?: boolean }): Schema<string> {
  return {
    default: options.default,
    parse(value, path, issues) {
      if (typeof value !== 'string') error(issues, path, 'tiene que ser texto');
      else if (options.nonEmpty && value.trim() === '') error(issues, path, 'no puede estar vacío');
      else return value;
      return options.default;
    },
    json: () => {
      const examples = options.examples?.() ?? [];
      const base = { type: 'string', default: options.default, description: options.description };
      // anyOf with an enum: VS Code suggests the known values and still accepts any text.
      return examples.length ? { ...base, anyOf: [{ enum: examples }, { type: 'string' }] } : base;
    },
  };
}

export function oneOf<const T extends string>(
  values: readonly T[],
  options: Common<T> & { labels?: Record<T, string> },
): Schema<T> {
  return {
    default: options.default,
    parse(value, path, issues) {
      if (typeof value === 'string' && (values as readonly string[]).includes(value)) return value as T;
      error(issues, path, `tiene que ser uno de: ${values.join(', ')}`);
      return options.default;
    },
    json: () => ({
      enum: [...values],
      default: options.default,
      description: options.description,
      enumDescriptions: options.labels ? values.map((v) => options.labels?.[v] ?? '') : undefined,
    }),
  };
}

/** `T | undefined`: absent means "not set" (no default value of its own). */
export function optional<T>(inner: Schema<T>): Schema<T | undefined> {
  return {
    default: undefined,
    parse: (value, path, issues) => inner.parse(value, path, issues),
    json: () => inner.json(),
  };
}

/** `T | null`: null (or absent) means "automatic". */
export function nullable<T>(inner: Schema<T>, description?: string): Schema<T | null> {
  return {
    default: null,
    parse: (value, path, issues) => (value === null ? null : inner.parse(value, path, issues)),
    json: () => ({ anyOf: [inner.json(), { type: 'null' }], default: null, description }),
  };
}

export function array<T>(item: Schema<T>, options: { description?: string } = {}): Schema<T[]> {
  return {
    default: [],
    parse(value, path, issues) {
      if (!Array.isArray(value)) {
        error(issues, path, 'tiene que ser una lista');
        return [];
      }
      return value.map((element, i) => item.parse(element, `${path}[${i}]`, issues));
    },
    json: () => ({ type: 'array', items: item.json(), default: [], description: options.description }),
  };
}

/** An object with arbitrary keys (environment variables). */
export function record<T>(value: Schema<T>, options: { description?: string } = {}): Schema<Record<string, T>> {
  return {
    default: {},
    parse(input, path, issues) {
      if (!isObject(input)) {
        error(issues, path, 'tiene que ser un objeto');
        return {};
      }
      const out: Record<string, T> = {};
      for (const [key, element] of Object.entries(input)) out[key] = value.parse(element, join(path, key), issues);
      return out;
    },
    json: () => ({ type: 'object', additionalProperties: value.json(), description: options.description }),
  };
}

type Fields = Record<string, Schema<unknown>>;
type ObjectOf<F extends Fields> = { [K in keyof F]: Infer<F[K]> };

/**
 * An object with known keys. Missing keys take their default; unknown keys are a warning (a
 * typo should not take the whole file down). `$schema` is always allowed.
 */
export function object<F extends Fields>(fields: F, options: { description?: string } = {}): Schema<ObjectOf<F>> {
  const defaults = Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field.default])) as ObjectOf<F>;
  return {
    default: defaults,
    parse(value, path, issues) {
      if (!isObject(value)) {
        error(issues, path, 'tiene que ser un objeto');
        return defaults;
      }
      const out: Record<string, unknown> = {};
      for (const [key, field] of Object.entries(fields)) {
        const element = value[key];
        out[key] = element === undefined ? field.default : field.parse(element, join(path, key), issues);
      }
      for (const key of Object.keys(value)) {
        if (!(key in fields) && key !== '$schema') {
          issues.push({ path: join(path, key), message: 'clave desconocida: se ignora', severity: 'warning' });
        }
      }
      return out as ObjectOf<F>;
    },
    json: () => ({
      type: 'object',
      properties: Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field.json()])),
      additionalProperties: false,
      description: options.description,
    }),
  };
}

/** A node with hand-written validation (themes accept two formats). */
export function custom<T>(spec: Schema<T>): Schema<T> {
  return spec;
}

/** JSON Schema without the `undefined` fields left by optional options. */
export function cleanJson(schema: JsonSchema): JsonSchema {
  return JSON.parse(JSON.stringify(schema)) as JsonSchema;
}
