# Changelog

## 1.0.0 - 2026-10-07

- Add auth primitives and fail-closed admin route registry.
- Add reference-counted Prometheus text 0.0.4 metrics source registration and discovery.
- Add standalone/cluster Redis client factory APIs without a runtime ioredis dependency.
- Add Node-RED 4.1/5 runtime and credential-redaction integration tests.
- Add immutable runtime state checks, Node-RED status recovery overlays, and Redis reconnect/cluster failover handling.
- Add a six-node TLS Redis Cluster and Toxiproxy release integration gate.
- Add pinned CI/release workflows, pack/requirement checks, and consumer declaration tests.
- Tighten startup/input deadlines, close draining, and secret redaction.

## 1.0.0-alpha.1 - 2026-10-06

- Add domain naming and instance identity helpers.
- Add typed config parsing and namespaced environment/settings readers.
- Add backoff, retry, timeout, abortable sleep, and bounded concurrency helpers.
- Add palette, node, and plugin contexts with logging, status, input handling, and lifecycle management.