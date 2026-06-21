# Synaipse Templates

Seed-Vorlagen für einen neuen Synaipse-Vault. Wird von `npm run vault:init`
in den durch `SYNAIPSE_VAULT_PATH` konfigurierten Vault kopiert.

## Layout

```
templates/
└── Memory/
    └── Project/                Platzhalter — wird beim Seed durch SYNAIPSE_PROJECT ersetzt
        ├── decisions/          Architektur- und Toolentscheidungen (ADR-Style)
        ├── architecture/       Systemüberblicke und Komponenten
        ├── code-patterns/      Wiederverwendbare Patterns (TS, Frontend, Backend)
        ├── libraries/          Externe Bibliotheken (API, Eigenheiten, Fallstricke)
        ├── infrastructure/     Docker, CI, Deployment
        ├── typescript/         TS-spezifische Notizen (Compiler-Flags, Tricks)
        ├── bugs/               (leer, vom Seed angelegt) Bug-Analysen
        └── research/           (leer, vom Seed angelegt) Recherche und Quellen
```

Beim Kopieren ersetzt `scripts/init-vault.mjs` den Ordnernamen `Project`
durch den Wert von `SYNAIPSE_PROJECT` aus der `.env`. Ist die Variable nicht
gesetzt, bleibt der Ordner `Project/` (und kann später umbenannt werden).

Diese `README.md` wird vom Seed-Script **nicht** in den Vault kopiert.