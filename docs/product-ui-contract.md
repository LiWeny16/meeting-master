# Product UI and capability contract

This note records what the current UI promises and how it is wired. It is a small review aid for the desktop shell, meeting assistant, and speech settings.

## Shell and conversation

- The native window title bar owns the first full-width grid row. Sidebar, workspace, and assistant share the row beneath it, so opening or collapsing the assistant cannot move the title bar or its controls.
- The workspace route owns its scrolling. The sidebar and chat thread scroll independently. At narrower widths the assistant opens as an overlay and the title bar stays visible.
- The assistant uses one visible conversation scope across pages. A fresh launch starts an empty conversation; prior conversations are available from the history menu. Stored model messages are scoped to the meeting context that produced them, so navigating does not silently replay another meeting's context.
- The composer accepts Enter to send and Shift+Enter for a newline. It accepts supported image and text attachments and explicitly attached knowledge passages, transcript excerpts, and identities. Attached context remains visible and removable.
- The empty thread offers meeting-specific starts when a meeting is open and general suggestions elsewhere. Model selection is in the composer. The context row identifies the current page and meeting, and the context menu explains which page state is sent. Send, stop, errors, and tool-permission decisions remain visible in the thread.
- Only finalized transcript segments are available to assistant tools. Partial text is useful for the live view but does not enter persisted meeting history.

## Provider boundaries

LLM and ASR configuration are separate. LLM settings support BYOK provider credentials, OpenAI-compatible endpoints, model discovery or manual model IDs, and a connection test. Credentials are never returned to the frontend; the native host protects saved Windows keys with DPAPI. A local endpoint can explicitly use no authentication. The selected model is considered ready only when its provider and credential requirements are configured; that status alone does not prove the endpoint is reachable.

Real-time meeting transcription currently streams through the Local WebSocket provider, whose default endpoint is ws://192.168.0.200:8092/v1/asr/stream. The live view replaces a partial turn in place with the final turn for each audio source. Its status and latency are source-specific; the displayed latency estimates ASR processing delay from forwarded audio to a result, not end-to-end microphone-to-text time. Other ASR provider configuration and connectivity tests do not feed meeting transcription yet.

## Meeting outputs

Summary generation is explicit: the completed-meeting page opens the matching conversation with a recap and action-item request. It does not imply that a recap has already been generated. Saved action items can show owner, due date, completion state, and links to their source transcript segments.

## Unsupported paths

The app does not run downloaded local ASR weights for inference, stream meeting audio to the other configured ASR providers, or diarize individual speakers. It does not include its own document index: RAGFlow handles upload and indexing, while Open WebUI and AnythingLLM are currently search integrations. The assistant can inspect tools from configured MCP services, but every actual tool call shows its target and arguments and requires confirmation. A successful provider test is not evidence of live transcription support. These items should remain described as unavailable until a complete native path exists.

Provider marks are imported as local SVG assets: LobeHub's static icon package is MIT licensed (https://github.com/lobehub/lobe-icons); the vendored Deepgram mark comes from Simple Icons, which publishes its icons under CC0 (https://github.com/simple-icons/simple-icons). No provider logos load from a CDN.
