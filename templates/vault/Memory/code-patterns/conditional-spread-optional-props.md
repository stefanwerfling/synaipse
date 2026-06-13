---
title: Conditional Spread for Optional Props
tags: [typescript, pattern]
aliases: [exactOptionalPropertyTypes]
---

# Conditional Spread for Optional Props

Mit `exactOptionalPropertyTypes: true` ist ein optionales Feld `apiKey?: string` strikt vom Typ `string` (nicht `string | undefined`). Direktes Zuweisen von `undefined` führt zu TS2379.

## Pattern

```ts
new QdrantClient({
    url: options.url,
    ...(options.apiKey !== undefined ? {apiKey: options.apiKey} : {})
});
```

Das Spread-Objekt wird nur erzeugt, wenn der Wert tatsächlich vorhanden ist. So bleibt das Property vollständig weg, statt mit `undefined` belegt zu sein.

## Wann nutzen

- Wenn ein Konsumenten-Interface das Property optional deklariert
- Wenn der eigene Wert vom Typ `T | undefined` ist
- Wenn der TS-Compiler-Flag aktiv ist

## Verwandt

- [[TypeScript Strict Config]]