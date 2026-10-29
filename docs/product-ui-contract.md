# Product UI and capability contract

This note records what the current UI promises and how it is wired. It is a small review aid for the desktop shell, meeting assistant, and speech settings.

## Shell and conversation

- The native window title bar owns the first full-width grid row. Sidebar, workspace, and assistant share the row beneath it, so opening or collapsing the assistant cannot move the title bar or its controls.
- The workspace route owns its scrolling. The sidebar and chat thread scroll independently. At narrower widths the assistant opens as an overlay and the title bar stays visible.
- Each meeting has one conversation thread and saved history keyed by that route's meeting ID. General pages use a separate global thread. Changing the page never changes a meeting's history key.
- The composer accepts Enter to send and Shift+Enter for a newline. Its add menu shows the current meeting and selected text only; it does not advertise disconnected knowledge or attachment features.
- The empty thread offers four starts: catch up, draft an answer, suggest a question, and identify decisions and actions. Model selection lives in the assistant panel's header row, beside the conversation title, so the composer stays a single text field plus a send button. The row under the header states which meeting the conversation is attached to. Send, stop, errors, and tool-permission decisions remain visible in the thread.
- Only finalized transcript segments are available to assistant tools. Partial text is useful for the live view but does not enter persisted meeting history.

## Provider boundaries

LLM and ASR configuration are separate. LLM settings support BYOK provider credentials, OpenAI-compatible endpoints, model discovery or manual model IDs, and a connection test. Credentials are never returned to the frontend; the native host protects saved Windows keys with DPAPI. A local endpoint can explicitly use no authentication. The selected model is considered ready only when its provider and credential requirements are configured; that status alone does not prove the endpoint is reachable.

Real-time meeting transcription currently streams through the Local WebSocket provider, whose default endpoint is ws://192.168.0.200:8092/v1/asr/stream. The live view replaces a partial turn in place with the final turn for each audio source. Its status and latency are source-specific; the displayed latency estimates ASR processing delay from forwarded audio to a result, not end-to-end microphone-to-text time. Other ASR provider configuration and connectivity tests do not feed meeting transcription yet.

## Meeting outputs

Summary generation is explicit: the completed-meeting page opens the matching conversation with a recap and action-item request. It does not imply that a recap has already been generated. Saved action items can show owner, due date, completion state, and links to their source transcript segments.

## Unsupported paths

The app does not run downloaded local ASR weights for inference, stream meeting audio to the other configured ASR providers, index imported knowledge files, persist meeting identities, or diarize individual speakers. A successful provider test is not evidence of live transcription support. These items should remain described as unavailable until a complete native path exists.

Provider marks are imported as local SVG assets: LobeHub's static icon package is MIT licensed (https://github.com/lobehub/lobe-icons); the vendored Deepgram mark comes from Simple Icons, which publishes its icons under CC0 (https://github.com/simple-icons/simple-icons). No provider logos load from a CDN.
