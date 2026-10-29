# Meeting Master

Meeting Master is a Windows-first local meeting assistant using Tauri 2, Rust, React, TypeScript and MUI.

## Current implementation status

The Windows app records system output and microphone audio into separate local files, stores meetings and finalized transcript segments, and streams audio to a configured real-time ASR adapter. The assistant runs in an app-owned Pi Core runtime, starts with a fresh conversation on launch, and keeps earlier conversations available from the history menu. Model history is scoped to the meeting context. LLM and knowledge-service keys are protected with Windows DPAPI; local OpenAI-compatible endpoints may opt out of authentication. No API key or meeting transcript is bundled.

Real-time meeting transcription currently connects only through the **Local WebSocket** adapter. Its default endpoint is ws://192.168.0.200:8092/v1/asr/stream; change it under **Models & ASR** for your machine. Provider setup and connection tests for other ASR services do not connect them to the live stream yet. Downloaded local ASR weights can be managed but are not run for live meetings. A meeting summary is user-triggered from the summary page and is not generated automatically.

Knowledge can be searched through user-configured RAGFlow, Open WebUI, and AnythingLLM services. RAGFlow also supports file upload and index-status tracking. Streamable HTTP MCP connections expose their declared tools and resources; tools can be invoked manually after confirmation. A local-port check covers common service addresses, while custom URLs remain supported. Data stays with the chosen service. There is no built-in document index, automatic MCP-to-agent tool mapping, or universal MCP discovery.

Meeting identities are stored locally and may be edited or deleted. The assistant supports PNG, JPEG, and WebP images (up to 4 MB each) and text files (up to 256 KB each); image understanding depends on the selected model and provider. PDF and other document formats can be imported into a connected RAGFlow knowledge space. Local downloaded-model inference and speaker diarization remain unsupported. The interface reports these boundaries rather than suggesting that a configured credential or downloaded model is already producing transcript text. See [the UI and capability contract](docs/product-ui-contract.md) for the current interaction and support map.

## Windows prerequisites

- Windows 10/11 x64 and Microsoft Edge WebView2 Runtime.
- Node.js 20+ (Node 24 tested) and npm.
- Rust stable with the `x86_64-pc-windows-msvc` target.
- Visual Studio 2022 Build Tools with the C++ build tools workload (`cl.exe`, Windows SDK, and MSBuild).

## Development

```powershell
npm install
npm run typecheck
npm run lint
npm test
npm run build
```

Run the browser shell (native services remain unavailable):

```powershell
npm run dev
```

Stage or refresh the bundled Pi runtime when needed with **npm run agent:stage**. The Tauri dev/build hooks stage the runtime automatically. Run the Windows desktop app and its development-only CDP MCP bridge:

```powershell
npm run tauri:dev
```

The launcher enables WebView2 remote debugging only for this development process, binds it to loopback, chooses a local port, and uses an isolated profile under `.local/`. It prints a tokenized MCP endpoint. Keep that URL private and register it only with the agent you intend to authorize. The release configuration does not enable CDP or start the bridge.

The bridge exposes page state, accessibility/viewport snapshots, screenshots, click/fill/keyboard actions, local-route navigation, page-context JavaScript evaluation, and console errors. Navigation is restricted to Meeting Master's local origins; the bridge listens on `127.0.0.1` and rejects missing/invalid tokens and non-loopback origins. JavaScript evaluation is full page access and should be used only in a trusted local development session.

Check the Rust project on a configured Windows MSVC toolchain:

```powershell
npm run native:check
```

## Product behavior

- **Start meeting** begins local system-output and microphone recording. Real-time transcript text appears only when the Local WebSocket adapter is configured and responding.
- **Prepare a meeting** stores its title, agenda, and optional identity; it does not schedule a calendar event.
- The assistant displays the current page, and relevant page state is sent with a message without API keys. Knowledge passages, transcript excerpts, and identities can be attached explicitly. Settings keep LLM providers and speech-recognition providers separate.
- Model downloads and hardware recommendations are available, but downloaded ASR weights do not yet run in live meetings. Model storage can be changed for the next launch without moving existing files. The installer does not include model weights.
- Login is deferred. The avatar is a placeholder; the gold PRO badge is a product-tier label, not an authenticated account state.
- The UI is built on a single token layer (`src/styles/tokens.css`) plus one shared primitive stylesheet (`src/styles.css`). Radii, type sizes, colour, elevation and spacing come only from tokens; the app frame is a neutral canvas holding one content card and one assistant card. Primary action is near-black rather than brand-coloured, and brand colour is limited to state, selection and focus. The full contract — including how a page must be built and reviewed — is in [the UI design system](docs/ui-design-system.md).
- English and Simplified Chinese preferences, three palettes (Sky Blue, Mint, Graphite), light/dark/system appearance, responsive desktop layout, and reduced-motion-aware micro-interactions are part of the UI foundation.


## Updates and releases

The Windows installer checks the latest GitHub Release in the background, downloads signed updates, and lets the user install and restart when recording is idle. The application reports when GitHub cannot be reached. Release builds use the NSIS installer.

For a release, update the version in `package.json`, `package-lock.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json`; build with `TAURI_SIGNING_PRIVATE_KEY` set to the existing signing key; then run `node scripts/release-manifest.mjs v1.2.3`. Publish the resulting NSIS installer, its `.sig`, and `latest.json` together as the matching GitHub Release. The public key is embedded in the app; keep the private key backed up and secret, since existing installations cannot accept updates signed by a different key.

For maintainers, pushing a matching `vX.Y.Z` tag runs the Windows release workflow. Configure the `TAURI_SIGNING_PRIVATE_KEY` repository secret with the original private key; the workflow publishes a draft only after the build and manifest succeed, then marks it as the latest release.
