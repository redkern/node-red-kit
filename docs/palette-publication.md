# Node-RED Palette Publication Checklist

This checklist applies to palette packages such as `@redkern/node-red-redis`, not to `@redkern/node-red-kit`. The kit is a runtime library and must not register nodes, declare `node-red` package metadata, or use the `node-red` npm keyword.

The checklist follows the [official Node-RED Creating Nodes guide](https://nodered.org/docs/creating-nodes/). A palette release is ready only when every applicable item is verified in that palette's own repository.

## Package and npm

- [ ] Use a scoped package name. Prefer `@redkern/node-red-<domain>` for Redkern palettes.
- [ ] Keep the package name, runtime node type, editor node type, help name, and example references consistent.
- [ ] If migrating stored node or instance identifiers, explicitly compare old and new IDs before moving data.
- [ ] Set `node-red.nodes` to every runtime JavaScript file that registers nodes, and set `node-red.version` to the tested support range.
- [ ] Add the `node-red` keyword only after the package is stable, working, and sufficiently documented.
- [ ] Declare all required runtime modules under `dependencies`; do not rely on Node-RED's or another palette's transitive dependencies.
- [ ] Include every runtime `.js`, editor `.html`, icon, and translation resource the palette uses, plus its README and license, in the published archive. If shipping example flows, include the root `examples/` directory. Verify the archive with `npm pack --dry-run` and install it into a clean Node-RED user directory.
- [ ] README describes purpose, prerequisites, installation, configuration, and at least one usable flow or links to examples. Include an appropriate license and repository metadata.
- [ ] Publish to public npm with provenance from the protected release workflow. Confirm the published version and tarball before submitting it to the Flow Library.

## Runtime behavior

- [ ] Each constructor calls `RED.nodes.createNode(this, config)` before accessing shared Node-RED node APIs.
- [ ] Input nodes accept supported message value types and preserve message properties. Document payload types and all fields added, changed, or removed.
- [ ] Input handlers use the supplied `send` and `done` callbacks, send the documented output shape, call `done` exactly once, and route errors through `done(error)` or the documented Node-RED error handling path.
- [ ] Source nodes use `node.send`; asynchronous event emitters have `error` listeners; callbacks and promises cannot produce unhandled failures.
- [ ] Close handlers release timers, listeners, sockets, and shared resources, and finish asynchronous cleanup with the Node-RED close callback. Handle both restart and removal signatures when removal changes cleanup behavior.
- [ ] If the palette provides a deployment `preStop` hook, it awaits drain and fails on unexpected refusal or timeout; it does not treat every `ECONNREFUSED` as success.
- [ ] Status and logs use Node-RED node APIs. Never expose credentials, secret-bearing message fields, or raw sensitive errors.
- [ ] Validate configuration at runtime even when editor validation exists. Missing config-node references fail safely instead of throwing an uncaught error.

## Editor, credentials, and config nodes

- [ ] Each `.html` file has a registered node definition, an edit template, and help text, using the matching node type/name.
- [ ] Editor registration is isolated in a strict-mode IIFE. `inputs`, `outputs`, output labels, error-output placement, and actual runtime sends agree.
- [ ] Editable properties have defaults and appropriate validation. Config-node fields use `node-config-input-*`; references use the config node's declared type.
- [ ] Config nodes use `category: "config"`, have no flow ports, document their references, handle missing references, and correctly share and close resources.
- [ ] Credentials are declared through Node-RED's credential API and are never copied into ordinary flow properties. Password credentials are not assumed to be readable in the editor; runtime code reads them from `this.credentials`.
- [ ] Editor and runtime credential field names and types match exactly.
- [ ] If migrating a secret previously stored in a flow or Git history, rotate it and handle repository history and backups; do not treat moving the field as revocation.
- [ ] Icons are packaged, uniquely named, white on transparent, and use the documented 2:3 aspect ratio with at least 40x60 pixels. Labels and port labels are meaningful; editor buttons are used only when appropriate for flow development.

## Help, examples, and compatibility

- [ ] Help begins with a concise description whose first paragraph works as the palette tooltip.
- [ ] Help describes inputs, every output separately when there are multiple outputs, message-property names and types, behavior for relevant payload types, message changes, queue/order behavior, errors, and credential prerequisites.
- [ ] Help uses the Node-RED structure (`Inputs`, `Outputs`, `Details`, `References` as applicable), `message-properties` lists, and `node-ports` for multiple outputs. Avoid unsupported styling and unexplained jargon.
- [ ] If examples are supplied, keep root `examples/` flows short, include comment nodes, and avoid unrelated third-party palette dependencies unless explicitly stated.
- [ ] Test supported Node.js and Node-RED combinations with the real runtime. Cover deploy/redeploy, credentials, settings, config nodes, admin routes, message forwarding, errors, and shutdown as applicable.
- [ ] Test local installation using `npm install <path-to-palette>` and test the actual packed artifact, not only workspace source.

## Flow Library submission

- [ ] In the package's release repository, complete CI and review the release evidence before creating a stable tag.
- [ ] Push the matching `vX.Y.Z` tag. The release workflow checks out that tag and runs the stable release gate before publishing to npm; configure npm trusted publishing and the protected `npm` environment for that repository.
- [ ] Wait for the workflow and npm publication to succeed before creating the public GitHub Release from that tag. Do not use a `release: published` event as the npm publication trigger.
- [ ] Verify the published npm version, provenance, and tarball contents before submitting the palette to the Flow Library.
- [ ] After npm publication, submit the package manually through [flows.nodered.org/add/node](https://flows.nodered.org/add/node). The Flow Library no longer automatically indexes npm packages from the `node-red` keyword.
- [ ] For an existing entry, submit the update or request a refresh from the package's Flow Library page.
- [ ] Verify the listing, README rendering, supported Node-RED version, install command, examples, and npm version after indexing.

## Official references

- [Creating Nodes](https://nodered.org/docs/creating-nodes/)
- [Packaging](https://nodered.org/docs/creating-nodes/packaging)
- [JavaScript file](https://nodered.org/docs/creating-nodes/node-js)
- [HTML file](https://nodered.org/docs/creating-nodes/node-html)
- [Credentials](https://nodered.org/docs/creating-nodes/credentials)
- [Configuration nodes](https://nodered.org/docs/creating-nodes/config-nodes)
- [Appearance](https://nodered.org/docs/creating-nodes/appearance)
- [Help style guide](https://nodered.org/docs/creating-nodes/help-style-guide)
- [Examples](https://nodered.org/docs/creating-nodes/examples)