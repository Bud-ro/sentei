# vendor/sarif

`sarif-schema-2.1.0.json` is the SARIF 2.1.0 JSON schema, vendored verbatim from
<https://json.schemastore.org/sarif-2.1.0.json> (which redirects to
<https://www.schemastore.org/sarif-2.1.0.json>). It is the URL sentei writes into
every log's `$schema`.

- Fetched: 2026-09-24
- sha256: `c96eb2d311c37b0a38cbd18c52d79a68f778bbd2d831abed7412d9850740f785`
- Dialect: JSON Schema draft-07 (`$id`
  `https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json`).
  The OASIS errata01 copy
  (<https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/schemas/sarif-schema-2.1.0.json>)
  is draft-04, which Ajv 8 does not support without an extra package
  (`ajv-draft-04`); the schemastore copy was chosen for that reason. Differences
  (checked 2026-09-24): the schemastore copy is draft-07 and omits `region`'s
  `anyOf` (startLine | charOffset | byteOffset) and adds `properties` to a few
  `anyOf` branches. sentei always writes `region.startLine` when it writes a
  region (asserted in `packages/core/test/sarif.test.ts`), so the looser rule
  loses nothing for our output.

Used only by tests (`packages/core/test/helpers/sarif.ts`, default `ajv` build =
draft-07, plus `ajv-formats`). The runtime never validates.

## License

The file is distributed by [SchemaStore](https://github.com/SchemaStore/schemastore),
whose repository is licensed under the Apache License 2.0
(<https://github.com/SchemaStore/schemastore/blob/master/LICENSE>). The schema
itself originates from the OASIS SARIF Technical Committee
([oasis-tcs/sarif-spec](https://github.com/oasis-tcs/sarif-spec)), whose content is
governed by the OASIS IPR Policy (RF on RAND mode). It is unmodified here.
