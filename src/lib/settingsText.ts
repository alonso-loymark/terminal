// The settings file as text: parse it (comments and trailing commas allowed, errors with line
// and column) and change single values without touching the rest (the user's comments,
// order and formatting survive edits made from the settings screen). Pure (node --test).
import {
  applyEdits,
  findNodeAtLocation,
  modify,
  parse,
  parseTree,
  printParseErrorCode,
  type JSONPath,
  type ParseError,
} from 'jsonc-parser';
import type { Issue } from '../config/schema.ts';
import { validateSettings, type Settings } from '../config/settingsSchema.ts';

export type { JSONPath };

export const SCHEMA_REFERENCE = './settings.schema.json';
/** What a new settings file starts with: everything else takes its default value. */
export const NEW_FILE = `{\n  "$schema": "${SCHEMA_REFERENCE}"\n}\n`;

const MESSAGES: Record<string, string> = {
  InvalidSymbol: 'símbolo inválido',
  InvalidNumberFormat: 'número mal escrito',
  PropertyNameExpected: 'falta el nombre de una propiedad (entre comillas)',
  ValueExpected: 'falta un valor',
  ColonExpected: 'falta ":"',
  CommaExpected: 'falta una coma',
  CloseBraceExpected: 'falta "}"',
  CloseBracketExpected: 'falta "]"',
  EndOfFileExpected: 'hay texto después del final',
  InvalidCommentToken: 'comentario mal escrito',
  UnexpectedEndOfComment: 'comentario sin cerrar',
  UnexpectedEndOfString: 'texto sin cerrar (falta una comilla)',
  UnexpectedEndOfNumber: 'número incompleto',
  InvalidUnicode: 'secuencia \\u inválida',
  InvalidEscapeCharacter: 'secuencia de escape inválida (¿una \\ sin duplicar en una ruta?)',
  InvalidCharacter: 'carácter inválido',
};

function position(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, offset);
  const line = before.split('\n').length;
  return { line, column: offset - before.lastIndexOf('\n') };
}

/** JSON with comments → value, plus syntax errors (with line and column). */
export function parseText(text: string): { value: unknown; issues: Issue[] } {
  const errors: ParseError[] = [];
  const value = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
  const issues: Issue[] = [];
  const seen = new Set<string>();
  for (const error of errors) {
    // A truncated file reports the same spot several times ("falta }" once per open brace).
    const key = `${error.error}@${error.offset}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const code = printParseErrorCode(error.error);
    issues.push({ path: '', message: MESSAGES[code] ?? code, severity: 'error', ...position(text, error.offset) });
  }
  return { value, issues };
}

export interface Evaluation {
  /** Null if the file has errors (keep the last valid settings). */
  settings: Settings | null;
  issues: Issue[];
}

/** The file's text (null: no file yet) → validated settings. */
export function evaluate(text: string | null): Evaluation {
  if (text === null || text.trim() === '') return validateSettings({});
  const { value, issues } = parseText(text);
  if (issues.length) return { settings: null, issues };
  if (value === undefined || value === null) return validateSettings({});
  return validateSettings(value);
}

/** A change to the file: the value at `path`, or `undefined` to remove it (back to the default). */
export type Edit = [path: JSONPath, value: unknown];

/** Applies edits to the text, keeping everything else as the user wrote it. */
export function editText(text: string | null, edits: readonly Edit[]): string {
  let out = text?.trim() ? text : NEW_FILE;
  for (const [path, value] of edits) {
    // Removing what is not there is a no-op (jsonc-parser throws when the parent is missing).
    if (value === undefined && !findNodeAtLocation(parseTree(out) ?? EMPTY, path)) continue;
    const changes = modify(out, path, value, { formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' } });
    out = applyEdits(out, changes);
  }
  return out;
}

const EMPTY = parseTree('{}')!;

const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The edit that sets a setting: removing the key when the value is the default keeps the file
 * down to what the user changed ("what is not in the file takes its default").
 */
export function settingEdit(path: JSONPath, value: unknown, defaultValue: unknown): Edit {
  return [path, sameValue(value, defaultValue) ? undefined : value];
}
