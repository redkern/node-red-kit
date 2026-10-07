# Redkern Package Standard

## Package identity

Each redkern package has its own repository under the `redkern` GitHub organization. Palette node types use the `redkern-<domain>-` prefix. The kit is a library and must not declare Node-RED palette metadata or register nodes.

## Domain and port registry

| Domain | Package | Requirement prefix | Default internal port |
| --- | --- | --- | ---: |
| redis | `@redkern/node-red-redis` | RDS | 9551 |
| kafka | `@redkern/node-red-kafka` | KFK | - |
| gateway | `@redkern/node-red-gateway` | GW | 9552 |
| prom | `@redkern/node-red-prometheus` | PRM | 9550 |
| splitter | `@redkern/node-red-flow-splitter` | FS | - |
| migrate | `@redkern/node-red-migrate` | MIG | - |
| (kit) | `@redkern/node-red-kit` | KIT | - |

New domains and requirement prefixes are added by pull request. Internal ports may be overridden with `REDKERN_<DOMAIN>_INTERNAL_PORT`.

## Runtime and metadata

Node.js support starts at 22. Node-RED belongs in development dependencies, never runtime or peer dependencies. Palette message metadata belongs under `msg.redkern.<domain>`; legacy fields require an explicit migration option.

Published packages use an explicit `files` allowlist and `exports`, declare `publishConfig.access: "public"`, and point `repository.url` at `git+https://github.com/redkern/<repo>.git`. Releases use npm provenance and trusted publishing.

Palette repositories must also pass the [Node-RED palette publication checklist](palette-publication.md). The kit itself is not a palette and must not declare `node-red` metadata or the `node-red` keyword.