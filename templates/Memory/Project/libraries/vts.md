---
title: VTS
tags: [library, schema, typescript]
---

# VTS

Runtime-Schema-Validierung von [OpenSourcePKG/vts](https://github.com/OpenSourcePKG/vts).

## Eigenheiten

- **Literalwerte**: `Vts.equal('value' as const)` — *nicht* `Vts.literal(...)`.
- **Union**: `Vts.or([s1, s2, s3])` mit Array, nicht varargs.
- **Optional**: `Vts.optional(schema)` als Wrapper.

## Minimalbeispiel

```ts
import {Vts, ExtractSchemaResultType} from 'vts';

const ModeSchema = Vts.or([
    Vts.equal('fulltext' as const),
    Vts.equal('semantic' as const),
    Vts.equal('hybrid' as const)
]);

type Mode = ExtractSchemaResultType<typeof ModeSchema>;
```

## Verwandt

- [[Monorepo Structure]]