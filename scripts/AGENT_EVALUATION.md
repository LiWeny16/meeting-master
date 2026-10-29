# Meeting assistant evaluation

Run from the repository root:

```sh
node --test scripts/agent-eval.test.mjs
node scripts/agent-eval.mjs
node scripts/agent-eval.mjs --live --output .local/agent-eval.json
```

The first command validates the evaluator's negative and positive checks. The second uses a scripted local model and checks that the production agent host, stream, tool round trip, and evaluator connect; it is **not** a model-quality evaluation. The optional third command uses `DEEPSEEK_API_KEY` or the `DS` value in the project's `.env`, calls DeepSeek, may incur API costs, and writes a synthetic-only JSON report. It never copies the key into the report. All three commands exit nonzero on failure. The output parent directory must already exist.

Each case starts a fresh host process and a synthetic meeting. The meeting tool bridge is simulated and read-only, so no real meeting data is changed. Results include the synthetic prompt, answer, requested tool names and arguments, individual checks, streamed text count and first-text latency. The fixture does not exercise the Tauri native meeting store, actual application UI, a real MCP server, persistence, a long context or human approval. Live `modelRequests` is `null` because that count is not observed; do not infer it from tool calls. First-text timing includes host startup and network latency and is not a benchmark.

The three tasks cover a cited meeting fact, admitting an unknown budget, and explaining a selected sentence without tools. The meeting has no calendar date: its Friday check flags a narrow set of unsupported relative dates such as “this coming Friday”, while allowing explicit statements that the week is unknown. This heuristic cannot reliably detect every unsupported date or every negation. Answer checks are intentionally simple proxies; they can miss errors and must be reviewed alongside the answer and call trace. A pass reflects these examples, not general accuracy. The fixture tool result always returns a small synthetic transcript, and its parameter validation checks only the subset relevant to these examples; it is not a native-store or schema-conformance test.

## What the report does and does not establish

- **Tool selection:** allowed calls divided by calls and a binary required-group check are case-specific proxies, not full precision/recall. They do not cover many equivalent paths or absent expected calls beyond the required group.
- **Parameter correctness:** validates basic shapes and ranges for the covered read-only calls, not semantic relevance of search queries or all tool schemas.
- **Task completion:** deterministic case checks plus visible text; manual review is needed for factual and presentation quality.
- **Chain efficiency:** records call counts when observable, without an optimal-chain claim.
- **Context utilization:** checks whether the response reflects selected text or a cited fixture fact; it does not measure long-context coverage, retrieval recall, or token utilization.
- **AR v1:** this smoke suite supplies partial evidence for goal reception, deterministic execution, and output checks. It does not score all six dimensions, prove validation gates or loop discipline across failures, or establish a HARNESS-READY rating. Define a representative dataset and explicit scoring anchors before publishing any aggregate score.

Before using the suite as a release gate, add real native meeting and browser end-to-end cases, multilingual transcripts and noisy ASR, long-context and compaction recovery, denied/failed actions, actual MCP servers, multi-turn persistence and scope isolation, privacy/security, latency and cost baselines, and independent human review. Record model/provider versions, dataset version, and repeated runs so regressions are distinguishable from model variability.
