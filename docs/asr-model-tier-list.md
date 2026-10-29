# ASR 模型天梯榜（本地部署向）— 2026-10-10 快照

> **用途**：为 Meeting Master（Rust/Tauri、蓝牙输出回环 + 麦克风双路、RTX 3050 Laptop 4GB / Ryzen 9 5900HS）选 ASR 模型。按"实时流式"和"离线精转"两条链路分档，中英文分开评。
>
> **可信度标注**：★★★ = HF Open ASR Leaderboard 同口径实测；★★ = 官方训练侧公开对照（icefall/PaddleSpeech/FireRedASR 表）；★ = 模型卡自报/第三方转述（9 月新发布，暂无独立复现）。
>
> **口径警告**：HF Open ASR Leaderboard 在 2026 年切换过 cleaned 测试集和聚合列，**不同快照的 WER 数字不可跨表比较**（例：Parakeet TDT v2 卡片 6.05 vs 2026-09 快照 4.70）。本榜单每个表只在同一口径内排序。

---

## 天梯 A · 实时流式转写（中英，会议字幕/实时文本）

| 档 | 模型 | 参数 | 中文（流式） | 英文（流式） | 延迟 | 本机可行性（4GB） | 集成 | 许可 | 可信度 |
|---|---|---|---|---|---|---|---|---|---|
| **T0** | [Confucius4-R2T2](https://huggingface.co/netease-youdao/Confucius4-R2T2)（网易有道，2026-09-21） | 2B（Qwen3-ASR-1.7B 底座） | Wenet-meeting CER **7.27**（离线基线 5.97；裸流式基线 20.38） | 160ms chunk 内距离线 Qwen3-ASR 约 2 WER 点 | 200–600ms，chunk 80ms–2s | 紧张：fp16≈4GB，需量化/CPU 分担实测 | **Python/vLLM 侧车** + 官方 WebSocket 服务（非 Rust 原生） | 代码 Apache-2.0；**权重为 NetEase 自定义许可（商用前必查）** | ★ |
| **T0**（超硬件，升级路线） | [Audio8-ASR-Infinite](https://huggingface.co/Edge0/Audio8-ASR-Infinite)（Edge0，2026-09-21） | ~7B | AISHELL-1 CER **1.75**、AISHELL-4 **2.89** @480ms（对照 Voxtral-Realtime 16.8 / Nemotron-3.5 12.9） | LS clean 3.04 / other 6.81（略输 Voxtral-Realtime） | 固定 80/120/160ms 时钟，滚动 KV cache 无限时长 | **不行**：bf16 权重 8.17GB，需 ~16GB GPU | vLLM fork + WebSocket `/v1/realtime` | Apache-2.0 | ★ |
| **T1** | X-ASR-zh-en（0.2B Zipformer transducer，sherpa-onnx） | 0.2B | 自报 WS-net 8.84 @960ms（160/480/960/1920ms 可选） | 自报 LS clean 3.12 @960ms | chunk 级（160–1920ms） | **最好**：CPU/4GB 双路可行 | **Rust 原生（sherpa-onnx crate）** | Apache-2.0 | ★ |
| **T1** | [VibeVoice-ASR-Streaming](https://arxiv.org/html/2609.02812v2)（微软，2026-09） | 1.5B / 7B | AISHELL-4 CER 22.76、AliMeeting 33.83（会议远场） | AMI-IHM 19.83 / SDM 29.81；MLC 9 语种均值 17.09 | chunk 2.9s + 0.5s lookahead，说话人归属 2s | 1.5B 勉强可试；7B 不行 | Python 推理代码（已开源权重） | 开源（查仓库许可） | ★ |
| **T2** | Nemotron-3.5-ASR-streaming（0.6B，2026-06） | 0.64B | 模型卡：40 语言"分档就绪" | 榜上 avg 10.51 / RTFx 1348（9 集口径） | cache-aware 流式 | 可以 | NeMo 导出/ONNX | OpenMDW-1.1 | ★★ |
| **T2** | Moonshine v2 / streaming-medium（仅英文） | 0.245B | — | 榜 8 集均值 6.66（超 Whisper large-v3 的 7.44） | 端点后 50–258ms（M3） | 可以（专为边端） | C++/ONNX，Rust 可绑 | MIT（英文模型） | ★★ |
| **T2**（老一代） | icefall streaming Zipformer-large / PaddleSpeech chunk conformer | 0.12–0.16B | WS-net 8.54–12% CER（流式比离线损 0.5–1.5） | — | chunk 级 | 可以 | sherpa-onnx / Paddle | Apache-2.0 | ★★ |
| **降级** | Whisper 滑窗 / SenseVoice / Fun-ASR-Nano 分块 | — | 伪流式：靠 VAD+滑窗模拟，文本会回改 | 同左 | 秒级 | 可以 | whisper-rs 等 | — | ★★ |

**A 榜要点**：9 月两个开源发布改变了格局——R2T2 用"**稳定前缀、永不回改**"的 append-only 输出解决实时字幕闪烁（对 MiMo 后处理也是质变，文本不再翻烧饼）；Audio8 用滚动 KV cache 实现无限时长、中文 CER 断档领先，但 7B/16GB 超出本机。**4GB 双路 + Rust 的现实选项仍是 X-ASR-zh-en；R2T2 作为 Python 侧车对照组，量化后若跑得动就换。**

## 天梯 B · 离线精转 · 中文（会后定稿/复核）

口径：AISHELL-1/2 + WenetSpeech net/meeting 四项 CER%（FireRedASR 官方表 / SOTA2，★★）。

| 档 | 模型 | 参数 | aishell1 | 四项平均 | 本机可行性 | 备注 |
|---|---|---|---|---|---|---|
| **T0** | Qwen-Audio-3.0-ASR（MoE，2026-09） | MoE（大） | 宣称 SOTA（对齐 GPT-4o Transcribe 级） | — | 超硬件 | 30 语言 + 16 中文方言；热词/润色/长音频；另有 Streaming 变体。★ |
| **T0** | FireRedASR-LLM | 8.3B | 0.76 | **3.05** | 超 4GB（CPU/量化） | 输入限 30s，需切段 |
| **T1** | **FireRedASR-AED** | 1.1B | **0.55** | 3.18 | **可以** | 小型模型准确率标杆；输入限 60s |
| **T1** | SenseVoice-L | 1.6B | 2.09 | 4.47 | 可以 | 注：SenseVoiceSmall（234M）无公开榜数 |
| **T1** | Paraformer-Large | 0.2B | 1.68 | 4.56 | 轻松 | 最轻量的合格选项 |
| **T2** | Fun-ASR-Nano-2512 | 0.8B | （官方卡自报强） | — | 可以 | 31 语言；★ |
| **T2** | Whisper-large-v3 | 1.55B | 5.14 | 9.86 | 勉强 | 中文明显弱，别用它扛中文 |

## 天梯 C · 离线精转 · 英文

口径：HF Open ASR Leaderboard 2026-09-19 快照，8 个英文测试集 cleaned avg WER（★★★）。

| 档 | 模型 | 参数 | avg WER | RTFx | 许可 | 备注 |
|---|---|---|---|---|---|---|
| **T0** | Qwen3-ASR 1.7B | 1.7B | **4.31** | 820 | Apache-2.0 | 开源第一；52 语言 |
| **T0** | Canary-Qwen 2.5B | 2.5B | 4.43 | 882 | CC-BY-4.0 | Conformer + Qwen2 |
| **T1** | Parakeet TDT 0.6B v2 / v3 | 0.6B | 4.70 / 4.86 | ~6000 | CC-BY-4.0 | **速度/体积性价比之王**，4GB 随便跑 |
| **T1** | Granite Speech 5.0 TurboCTC | 0.47B | 5.04 | **12946** | Apache-2.0 | streaming-style Conformer+CTC，笔记本/手机定位 |
| **T1** | Qwen3-ASR 0.6B | 0.6B | 5.05 | 750 | Apache-2.0 | 多语言小钢炮 |
| **T2** | Kyutai STT 2.6B | 2.6B | 5.57 | — | CC-BY-4.0 | 流式背景 |
| **T2** | Whisper large-v3 / turbo | 1.55/0.8B | 5.78 / 6.36 | 145 / 200 | MIT | 生态最全、~99 语言，已被十几个开源模型超过 |

（榜单整体：商业 API 前五 3.6–4.0%，开源最好已只差 ~0.7 点。）

## 天梯 D · 会议专用（流式 + 说话人归属）

| 档 | 模型 | 亮点 | 可信度 |
|---|---|---|---|
| **T0** | VibeVoice-ASR-Streaming 7B/1.5B | 流式 "who said what"，13 个说话人归属设置 12 个最优；5 集均值 24.66 打平 Gemini 3.5 Transcribe Live（25.23） | ★ |
| **T1** | Nemotron 3.5 ASR + Nemotron 3 Diarization | 流式转写 + 独立说话人模型组合 | ★ |
| **T1** | Meta Muse Voice Transcribe | 流式 + 20+ 说话人分离 + 端点检测一体 | ★ |

---

## 对 Meeting Master 的结论（2026-10-10）

1. **实时层（本机双路）**：X-ASR-zh-en + sherpa-onnx 仍是唯一"Rust 原生 + 4GB 双路 + 真流式 + 中英"的现实选项，先做 POC（480ms 对比 960ms）。
2. **对照实验**：并行拉起 Confucius4-R2T2（Python/vLLM 侧车、本地 WebSocket，16kHz mono PCM 帧直喂）。它的 append-only 稳定前缀对字幕体验和 MiMo 文本后处理是质变；若量化后能在 4GB 上维持实时，就替换主链路。权重许可（NetEase 自定义）商用前必须确认。
3. **精转层（会后）**：中文 FireRedASR-AED 1.1B（切段 ≤60s）；英文 Parakeet TDT 0.6B v3 或 Qwen3-ASR 1.7B（8.23s 延迟不敏感场景）。
4. **升级路线**：显存到 12–16GB+ 时直接换 Audio8-ASR-Infinite（中文流式 CER 1.75 档）或 VibeVoice-ASR-Streaming 7B（要说话人归属时）。
5. **不要用**：Whisper 滑窗伪流式当主链路（中文弱 + 文本回改）；SenseVoiceSmall 当高精度选项（无公开榜数）；任何"榜单数字"直接当本机承诺（双路、蓝牙 loopback、中英混说无榜可依）。

## 来源

- 英文离线：HF [Open ASR Leaderboard](https://huggingface.co/spaces/hf-audio/open_asr_leaderboard) 2026-09-19 快照转述（ThinkScribe）+ 2026-08-18 CSV（localaimaster）+ 2026-10-09 经 hf-mirror 拉取的 `english_short_latest.csv`（9 集口径，见研究文档第 7 节）
- 中文离线：[FireRedASR](https://github.com/learningpro/FireRedASR) 官方表、[SOTA2 AISHELL-1](https://www.sota2.com/research/sota/automatic-speech-recognition-on-aishell-1-cer) / [WenetSpeech-net](https://www.sota2.com/research/sota/automatic-speech-recognition-on-wenetspeech-net-cer)（2026-01/04）
- 流式：[Confucius4-R2T2](https://huggingface.co/netease-youdao/Confucius4-R2T2)（模型卡自报）、[Audio8-ASR-Infinite](https://huggingface.co/Edge0/Audio8-ASR-Infinite)（模型卡自报）、[VibeVoice-ASR-Streaming 技术报告](https://arxiv.org/html/2609.02812v2)、[X2Streaming-ASR](https://arxiv.science/abs/2609.08672)（commit 延迟 32–109ms，参考）、[Moonshine v2](https://arxiv.org/html/2602.12241v1)、icefall/PaddleSpeech RESULTS
- 榜单口径漂移说明：2026 年 leaderboard 切换 cleaned 测试集（ThinkScribe / localaimaster）

*更新记录：2026-10-10 初版（吸收 2026-09 流式开源潮：R2T2 / Audio8 / VibeVoice-Streaming / Nemotron 3.5）。*
