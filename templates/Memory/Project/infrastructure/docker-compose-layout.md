---
title: Docker Compose Layout
tags: [docker, infrastructure]
---

# Docker Compose Layout

`docker-compose.yml` startet aktuell ausschließlich Qdrant. Volumes liegen unter `./data/qdrant`.

```yaml
services:
  qdrant:
    image: qdrant/qdrant:latest
    ports:
      - "6333:6333"
      - "6334:6334"
    volumes:
      - ./data/qdrant:/qdrant/storage
```

## Gitignore

`/data/` ist im Root-`.gitignore` ausgenommen, damit die persistenten Vektordaten nicht eingecheckt werden. Wichtig: kein `data/` (matched überall), sondern `/data/` (nur Root).

## Verwandt

- [[Qdrant Setup]]