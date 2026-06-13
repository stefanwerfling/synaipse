---
title: TypeScript Strict Config
tags: [typescript, config]
---

# TypeScript Strict Config

`tsconfig.base.json` aktiviert über `strict` hinaus:

- `noUncheckedIndexedAccess` — `arr[0]` ist `T | undefined`
- `noImplicitOverride` — `override`-Keyword erzwungen
- `exactOptionalPropertyTypes` — siehe [[Conditional Spread for Optional Props]]
- `noFallthroughCasesInSwitch`
- `isolatedModules`

Außerdem: `composite: true` + Project References ermöglichen inkrementelle Builds über alle Packages.

## Tradeoffs

- Mehr Boilerplate an Boundaries (Optional-Props, Index-Access)
- Dafür frühe Fehlererkennung und sauberere Typen

## Verwandt

- [[Monorepo Structure]]