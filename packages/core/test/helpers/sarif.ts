// SARIF 2.1.0 schema validation for tests (PLAN.md M5). The schema is vendored at
// vendor/sarif/sarif-schema-2.1.0.json (JSON Schema draft-07, the schemastore copy),
// so the default `ajv` build (draft-07) is the right one; `ajv-formats` supplies the
// `uri`/`date-time`/... formats the schema uses. Test-only: the runtime never validates.
import { readFileSync } from 'node:fs';
import { Ajv } from 'ajv';
import addFormatsImport from 'ajv-formats';

const SCHEMA_PATH = new URL('../../../../vendor/sarif/sarif-schema-2.1.0.json', import.meta.url);

// ajv-formats is CJS; under Node ESM its default export may arrive wrapped.
const addFormats = ((addFormatsImport as unknown as { default?: unknown }).default ?? addFormatsImport) as (ajv: Ajv) => Ajv;

let validateFn: ((data: unknown) => boolean) & { errors?: unknown } | undefined;

function validator(): ((data: unknown) => boolean) & { errors?: unknown } {
  if (validateFn === undefined) {
    const ajv = new Ajv({ allErrors: true, strict: true });
    addFormats(ajv);
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')) as Record<string, unknown>;
    validateFn = ajv.compile(schema);
  }
  return validateFn;
}

/** Schema errors of a SARIF log (empty array = valid). */
export function sarifSchemaErrors(log: unknown): unknown[] {
  const v = validator();
  return v(log) ? [] : ((v.errors as unknown[] | null | undefined) ?? ['invalid (no error detail)']);
}
