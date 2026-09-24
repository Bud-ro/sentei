Two repos (`one`, `two`) both define the non-private npm package `@acme/dup`:
`discover` must fail with a duplicate package name error (PLAN.md §5.1
`UNIQUE (manager, name)`, §8), listing both locations and copy-pasteable
`ignoreManifests` entries.

Duplicates where all but one manifest are private (`"private": true` /
`publish_to: none`) are not an error: the private ones are auto-ignored and
still scanned by the text witness. That case is covered by a unit test in
`packages/core/test/discover.test.ts`.
