# Optional ARCHi host integration

Runway does not patch an installed ARCHi or register itself automatically. This package's `extension.json` describes the adapter; it is not a manifest consumed by an existing ARCHi extension loader. Hosts can mount the adapter as a separate tool window while preserving their own project and companion code.

1. Add this package as a local dependency or vendor its source into your own optional integration layer. Example: `npm install /path/to/Runway`. No npm registry publication is required.
2. Call `registerRunwayScheme(protocol)` before Electron becomes ready. If the host already registers custom schemes, include the Runway scheme in that early initialization.
3. After readiness, call `createRunwayExtension({ electron, dataDirectory, onOpenProjects })`. Supply an absolute private directory such as `path.join(app.getPath('userData'), 'extensions', 'runway')`. Do not point it at an existing personal profile as part of installation.
4. Add an optional menu or tool action which calls `runway.open()`. `onOpenProjects` is optional and enables the Back to projects action; it does not grant Runway access to the project registry.
5. Await `runway.flush()` before host shutdown. Use `runway.dispose()` if removing the extension while the host keeps running. Install only one adapter per Electron process.

[examples/archi-host.mjs](../examples/archi-host.mjs) is a complete minimal host entry point, using a separate `~/.runway-host-example` profile. It demonstrates the adapter without altering upstream ARCHi. Run it with `npx electron examples/archi-host.mjs` after installing dependencies. The standalone `npm start` launcher uses this same adapter.

## Renderer contract

The context-isolated preload exposes `window.runway`:

| Method | Result |
| --- | --- |
| `getState()` | `{ state, loadError, capabilities: { openProjects } }` |
| `save(state)` | Validated saved state |
| `importMonarch()` | Native CSV picker, then import report and state; cancellation changes nothing |
| `importMonarchSnapshot()` | Native JSON picker, then report and state; cancellation changes nothing |
| `showYah()` | Calls the optional host navigation callback |

The host validates that requests originate in its current Runway main frame. File import paths come from the native picker, never renderer input. It serves only three allowlisted interface assets through an isolated local scheme. Networking and browser permissions are disabled for this tool window.

The backend's direct `save()` replaces the plan. Use it from one local owner and reload after conflicts. A future phone or voice adapter needs structured commands, authentication, revisions, and conflict handling; do not expose this whole-state API as an unauthenticated network endpoint.
