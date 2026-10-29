# Rust 桌面音频输出回环采集与 ASR 方案调研

## 结论摘要

**能做，而且是成熟的桌面音频采集场景。** 正确路线不是去“监听蓝牙”或连接耳机的蓝牙协议，而是在操作系统音频引擎中，对当前送往蓝牙耳机的**播放/渲染端点（render endpoint）做 loopback/monitor capture**，拿到数字 PCM，再交给 ASR。

但“拿到最终进入耳朵里的声音”需要定义清楚：常规桌面 API 能取到**系统送往所选播放设备的数字音频流**，不能保证逐样本等于耳机单元实际发声或耳膜接收到的声波。蓝牙编码/传输、耳机端 DSP/EQ/降噪、耳机音量、佩戴与环境都会改变最终声学结果。若必须测到耳机实际发声，需要耳机内部回采能力或额外的物理麦克风；普通 Rust 桌面软件无法从系统 loopback 还原这些后级变化。

**推荐 MVP：先做 Windows + WASAPI loopback + 本地 ASR。** Windows 可直接选中蓝牙耳机对应的 render endpoint，无需虚拟声卡；采到 PCM 后统一转成 16 kHz、mono、float PCM，做分块/VAD，再送入 Whisper 或流式 ASR。若目标是跨平台，可先评估 `vtx-engine` 这类已有多平台后端的 Rust 引擎；但音频捕获仍需处理 PipeWire/PulseAudio、ScreenCaptureKit/Core Audio 等平台差异与权限，不能假定有一个无条件即插即用的统一 loopback API。

## 1. 要捕获的音频到底在哪里

概念路径大致是：

```text
应用播放 PCM
  → OS 音频引擎混音 / 音量与效果处理
  → 选定的 render endpoint（蓝牙耳机）
  → 蓝牙传输编码/链路
  → 耳机端 DSP、音量/EQ/ANC、DAC 与扬声器
  → 人耳
```

Loopback API 通常提供的是音频引擎或输出端点附近的**数字音频副本**，而非蓝牙无线链路上的 SBC/AAC 等编码包，也不是耳机最终的物理声学输出。[微软对 A2DP offload 的说明](https://learn.microsoft.com/en-us/windows-hardware/drivers/audio/audio-sideband-a2dp-offload)也把可回环信号描述为混音后、编码前的 PCM（具体取决于硬件/驱动路径）。若目标是“把电脑经蓝牙耳机播放的对话转成文字”，这一级通常正合适；不需要解析蓝牙协议，不需要 `btleplug` 之类 BLE/GATT API，也不需要读取耳机麦克风。

需要区分两种需求：

- **系统/端点级捕获**：某个播放设备当前播放的所有应用混音；适合“电脑上耳机听到的都转写”。
- **应用级捕获**：只捕获某个进程/会议软件；避免系统提示音或其他应用混入。Windows 有官方 process-loopback 示例；其他平台需要各自 API 或受支持的应用音频会话机制。

## 2. 各平台的采集方案

| 平台 | 可用路径 | 说明与限制 |
|---|---|---|
| **Windows** | **WASAPI loopback**：枚举 `eRender` 端点，选蓝牙耳机 endpoint，创建 shared-mode `IAudioClient` 并设置 `AUDCLNT_STREAMFLAGS_LOOPBACK`，通过 `IAudioCaptureClient` 读数据。 | 最适合作为首个 MVP。Loopback 仅支持 shared mode，不支持 exclusive-mode loopback。采集内容与 endpoint/音频驱动实现有关；微软文档说明可能从硬件 loopback pin 取数，或由音频引擎将输出复制进 loopback buffer。标准 loopback 默认不等同于“耳机喇叭实际音量”，Windows 有条件性的 post-volume 机制，但依赖 APO/端点支持。endpoint 路由、蓝牙重连/设备变化要监听并重开流。 |
| **Linux** | **PipeWire sink monitor**，或通过 PulseAudio API 读取输出 sink 对应的 monitor source；PipeWire 桌面通常也可通过 `pipewire-pulse` 暴露 PulseAudio 兼容层。 | PipeWire 可将 capture stream 指向 sink monitor（如 `PW_KEY_STREAM_CAPTURE_SINK`）；PulseAudio 可读 `<sink>.monitor`，并可用 monitor-stream 选择特定 sink-input。要处理默认输出变化、sink 切换、节点销毁与重连。直接走 ALSA/独占路径的应用可能绕开 PipeWire/PulseAudio 图。 |
| **macOS** | **ScreenCaptureKit** 可捕获系统/所选内容的音频；macOS 14.2+ 还可用 **Core Audio process taps** 做音频/进程组捕获，并可通过 `CATapDescription.deviceUID` 指定设备。 | 需要用户授权系统音频捕获；Core Audio taps 还要求 `NSAudioCaptureUsageDescription`。ScreenCaptureKit 的系统音频不应默认理解为与某个物理蓝牙输出一一绑定。Rust 端可能需要 Objective-C/Swift 桥接或相应绑定，平台集成成本高于 Windows。 |

### Windows 蓝牙特别注意

WASAPI 采集实现可按这个顺序搭建：COM 初始化 → 枚举/选择 `eRender` `IMMDevice` → 激活 `IAudioClient` 并取 `GetMixFormat()` → 用 `AUDCLNT_SHAREMODE_SHARED` 和 `AUDCLNT_STREAMFLAGS_LOOPBACK` 初始化 → `GetService(IAudioCaptureClient)` → 循环读取 `GetNextPacketSize` / `GetBuffer`，复制数据后立刻 `ReleaseBuffer`。现代 Windows 可用事件驱动缓冲；微软说明 Windows 10 1703 之前需要额外的 render-event workaround。采集线程要处理 COM 生命周期、静音 buffer 标志和设备失效/重连。

- A2DP 是蓝牙耳机常见的高质量立体声播放模式；HFP 则用于耳机麦克风与单声道通话。打开耳机麦克风时，Windows 可能切换 profile，播放音质/采样率会变化。若目标仅是转写远端播放声，**不要为了采集去打开耳机麦克风**。
- 对 endpoint loopback，应让用户选择设备，而不是永远只用启动时的 default endpoint。系统默认设备可能在插拔、蓝牙断连、Dock 切换后改变。
- 系统混音 loopback 与特定进程 loopback 是不同能力。只采一个会议进程时，可评估 Windows process-loopback API；它按进程树捕获且不绑定物理 endpoint，不能保证“该进程当前送往这只蓝牙耳机的声音”。微软文档列出的最低支持版本为 Windows 10 build 20348。使用 `wasapi 0.25.0` 时还要注意：`new_application_loopback_client(pid, include_tree)` 的 `include_tree=false` 在实现中映射成“排除目标进程树”，不是只采目标 PID；调用前核对版本源码并实测。采某个蓝牙 endpoint 的全部声音时，用 endpoint loopback。
- 对受保护内容（DRM/受信任驱动路径可能静音或阻止回环）、独占模式应用、厂商特殊音频驱动、通话/HFP 路径，行为可能不同，必须用真实蓝牙设备实测。不要承诺“任何应用、任何模式都一定捕获”。

## 3. Rust 依赖与实现组合

### 捕获后端（按平台分层）

建议在项目中定义自己的 `AudioCaptureBackend` 抽象，而非假设一个跨平台音频 crate 都能处理系统 loopback：

- **Windows**：`wasapi 0.25.0` 可直接启用 WASAPI loopback；要更完整控制 COM/WASAPI、process loopback、endpoint notifications 等，可用 [`windows 0.62.2`](https://microsoft.github.io/windows-docs-rs/doc/windows/Win32/Media/Audio/struct.IAudioClient.html) 直接调用 Win32 API。
- **Linux**：`pipewire 0.10.1` 可将 capture stream 指向所选蓝牙 sink 的 monitor；PulseAudio/pipewire-pulse 可用 `libpulse-binding 2.30.1` 的 record stream 读取 `<sink>.monitor`。二者都要显式处理 sink/monitor 选择与系统开发库依赖。
- **macOS**：`coreaudio 0.3.3` 的 `process-tap` feature 可走 Core Audio taps，再通过 private aggregate device 读数据；[`screencapturekit`](https://docs.rs/screencapturekit/11.0.0/screencapturekit/) crate 可捕获系统音频，但涉及系统录屏/音频权限与 stream 生命周期。
- **跨平台尝试**：`cpal 0.18.2` 在 Windows WASAPI 后端以及 macOS 14.6+ 有 backend-specific loopback 支持；Windows 使用方式是把 render/output device 当 capture input 来建流，并查询该设备的 input config（callback 样本类型要按 `SampleFormat` 分发）。但 portable cpal API 本身没有统一的系统 loopback 契约，Linux 上暴露 monitor 输入也依赖音频服务/路由。它可用于简化特定平台 POC，但不要假设同一套 cpal 代码能稳定、自动选中三平台的蓝牙输出回环。

### PCM 到 ASR 的处理链

```text
OS capture callback / packet reader
  → 迅速复制 PCM 到有界 ring buffer（不要在实时回调里跑模型/阻塞 I/O）
  → float/int 格式转换、声道 downmix、重采样
  → 可选 VAD 与分块（例如带重叠的数百毫秒至数秒窗口）
  → 本地/云端 ASR
  → 部分结果与稳定文本合并、时间戳输出
```

ASR 常见输入为 **16 kHz mono PCM**，但捕获端可能是 44.1/48 kHz、立体声以及不同的整数/浮点格式，不能硬编码假设。建议先将原始捕获写 WAV 做诊断，再加入 VAD/ASR。

- 格式转换可用 `dasp_sample 0.11.0`；实时 callback 与 ASR worker 之间用有界 SPSC 队列，例如 `ringbuf 0.5.3`，避免回调阻塞、分配或执行模型推理。
- 重采样可用 `rubato 5.0.1`；固定从设备采样率转 16 kHz 时用持久化 fixed-rate resampler，只有需要校正时钟漂移时才考虑 asynchronous resampling。
- **真正流式识别优先评估 [`sherpa-onnx 1.13.8`](https://k2-fsa.github.io/sherpa/onnx/rust-api/)**：`OnlineStream` 接收分块音频并可取 partial/final result、端点检测；确认选用的模型本身支持 online 模式，常见输入为单声道 16 kHz f32。
- **[`whisper-rs 0.16.0`](https://docs.rs/whisper-rs/0.16.0/whisper_rs/) / whisper.cpp** 适合本地高质量转写，接口期望 mono 16 kHz f32；其 `full` 解码不是原生增量解码，实时体验通常靠 VAD + 重叠滑窗 + worker thread，并处理文本重复/修订。
- [`vosk 0.3.1`](https://crates.io/crates/vosk) 也提供增量 partial/final 结果，但 Rust wrapper 为第三方绑定，需要额外 native Vosk 库与模型。云端 WebSocket/gRPC ASR 可减少本地模型部署负担，但会把音频发送出设备。

ASR 不是采集 callback 的工作。推荐有界队列/ring buffer + 独立处理线程/任务，明确队列满时丢弃/降级策略，记录采样率、声道数、时间戳、丢帧和设备变化。对于低延迟字幕，流式模型或 VAD 驱动的小块更合适；Whisper 一类模型通常需要通过滑窗/分块模拟实时输出，并处理重复与文本修订。

### Hugging Face 上的小模型候选（本次核查：2026-10-10）

这部分把“模型宣称低延迟/实时”与**可持续接收音频并增量吐 partial 的真正流式模型**分开评估。模型卡的实时标签、单路 benchmark 和参数量，都不能代替本机双路测试。

| 候选 | 已核实的定位 | 优点 | 风险 / 建议 |
|---|---|---|---|
| [GilgameshWind/X-ASR-zh-en](https://huggingface.co/GilgameshWind/X-ASR-zh-en) | 中英双语 Zipformer transducer；模型卡明确支持 offline + **true streaming**，chunk 160/480/960/1920 ms；可用 sherpa-onnx；Apache-2.0。 | **目前最贴合本项目的首选 POC**：Rust 侧已有 sherpa-onnx API，在线流式路径比 Whisper 的滑窗更直接。480 ms 模型目录约 615 MB（encoder 593 MB、decoder 11.3 MB、joiner 10.3 MB）。 | 160 ms 更快但模型卡所列 benchmark 指标劣于较长 chunk；建议先测 480 ms 与 960 ms。卡片称训练数据约 100 万小时并给出 benchmark，但技术报告标为 coming soon，视为发布方数据而非独立验证。模型大小和 GPU/双路吞吐仍须本机实测。 |
| [FunAudioLLM/SenseVoiceSmall](https://huggingface.co/FunAudioLLM/SenseVoiceSmall) | 約 234M 参数的多语言模型，覆盖中文、英文、粤语、日语、韩语；可通过 sherpa-onnx 做本地离线识别。 | 体积较小，适合作为准确率与分块延迟基准。 | 属于 offline/chunk 路径，不能当作原生 OnlineRecognizer 流式模型；用 VAD + 短块可模拟实时，但需评估修订、重复和延迟。打包前单独核实模型权重许可证。 |
| [FunAudioLLM/Fun-ASR-Nano-2512](https://huggingface.co/FunAudioLLM/Fun-ASR-Nano-2512) | 800M 参数，支持 31 种语言（含中文、英文），Apache-2.0；官方模型卡称低延迟实时转录。另有 [第三方 sherpa-onnx INT8 ONNX 导出](https://huggingface.co/aoiandroid/sherpa-onnx-funasr-nano-int8-2025-12-30)。 | 作为中文方言、专有词及多语言质量对照值得保留；也有 GGUF/CPU edge 运行生态。 | “real-time”不自动等于 sherpa 的增量 online 模式。第三方 ONNX repo 明确是重打包导出，来源为 ModelScope 与社区导出脚本，称本地/offline 使用；其行为可能与官方 Python 推理不同。先验证模型任务接口、导出许可/来源及双路 RTF，再决定是否采用，**暂不作为实时主链路**。 |
| [Qwen/Qwen3-ASR-0.6B](https://huggingface.co/Qwen/Qwen3-ASR-0.6B) | 官方 0.6B 级多语言 ASR 候选；有适配低延迟/分块处理的生态，但本次没有核实到可直接由 sherpa-onnx Rust API 加载的在线模型包。 | 可作为不同模型家族的准确率对照；量化后可能更适合 4 GB 显存设备。 | 不能仅因“chunked/realtime”标签就当作真正增量流式；Rust runtime、授权、量化精度及两路占用需逐项确认。先列为第二阶段 benchmark，不是 MVP 首选。 |
| [Luigi/x-asr-zh-en-960ms-zipformer2-gguf](https://huggingface.co/Luigi/x-asr-zh-en-960ms-zipformer2-gguf) | 社区转换的同系列 GGUF：F16 文件约 292 MB、Q4_K 约 85 MB；目标 runtime 为 RapidSpeech.cpp 的 zipformer 分支。 | 体积很吸引人，可作为后续量化方向线索。 | 模型卡写明 full encoder/transducer port 仍在进行中，当前不是可直接接入的成熟运行包；不要把“文件可下载”误当作“Rust/Windows ASR 可用”。 |
| [moeru-ai 多语言 streaming Zipformer](https://huggingface.co/moeru-ai/sherpa-onnx-streaming-zipformer-ar_en_id_ja_ru_th_vi_zh-2025-02-10) | Hugging Face 标签显示 streaming，名称列有阿拉伯语、英语、印尼语、日语、俄语、泰语、越南语、中文。 | 可作为多语言候选线索。 | 本次可读到的模型卡没有给出足够明确的文件体积、授权和中文/英文混说能力说明；先不进入 shortlist，需核对仓库文件与模型来源。 |

**硬件判断（仅估算，不是实测结论）**：检查到的开发机为 Windows 10 64 位、Ryzen 9 5900HS（8 核 / 16 线程）、约 15.4 GiB 内存、RTX 3050 Laptop 4 GiB 显存。X-ASR-zh-en 的 615 MB 权重从容量看不是 4 GB 显存的硬性障碍，但运行时、缓存、桌面 GPU 占用以及并发调度也要用显存；不能据此保证两路 CUDA 实时。先在 CPU 上以**一个共享模型实例、两条独立音频流状态**测双路是否积压，再比较 CUDA provider；若运行时不适合共享实例，则重新测两份实例的内存峰值。以 480/960 ms 测 partial p95、最终延迟、RTF、CPU/GPU 峰值和丢帧。

**当前建议**：MVP 首测 sherpa-onnx + X-ASR-zh-en 的 480 ms（再对比 960 ms），两路输入保持独立 `OnlineStream` 与时间戳；不要为了最低 chunk 数字盲选 160 ms。用本机实际蓝牙 loopback + 麦克风各录一组中/英文和会议术语样本，评估识别率与 partial 修订，再考虑 Fun-ASR-Nano 或 Qwen 作为质量对照。现在没有任何候选在这台机器上的双路延迟、准确率或显存占用实测结果。各候选在公开榜单里的准确率位置见第 7 节（离线/流式 × 中/英）。

## 4. GitHub 上的相似开源实现

以下仓库已查看 GitHub 仓库页及默认分支 README/相关源码；可作为实际实现参考。它们采集的是操作系统播放路径，不是蓝牙空口数据或耳机扬声器的物理回采。

| 项目 | 采集与 ASR 范围 | 可复用内容 / 限制 | 许可证 |
|---|---|---|---|
| [Auricle](https://github.com/ManeeshJupalle/Auricle) | Windows WASAPI 系统输出 loopback + 麦克风；本地 Whisper，也可配置云端 STT。 | **最贴近 Windows Rust 端到端方案。** 可看 [`capture.rs`](https://github.com/ManeeshJupalle/Auricle/blob/main/crates/auricle-capture/src/capture.rs) 和 [`whisper_local.rs`](https://github.com/ManeeshJupalle/Auricle/blob/main/crates/auricle-stt/src/whisper_local.rs)。README 目标为 Windows 10/11，不是跨平台采集层。 | MIT |
| [vtx-engine](https://github.com/keathmilligan/vtx-engine) | Rust 引擎；Windows WASAPI loopback、Linux PipeWire sink monitor、macOS CoreAudio/ScreenCaptureKit；麦克风/系统/混音流与 Whisper.cpp/VAD。 | **最值得先评估的跨平台 Rust 库/引擎。** 具体后端源码：[Windows](https://github.com/keathmilligan/vtx-engine/blob/master/crates/vtx-engine/src/platform/windows/wasapi.rs)、[Linux](https://github.com/keathmilligan/vtx-engine/blob/master/crates/vtx-engine/src/platform/linux/pipewire.rs)、[macOS](https://github.com/keathmilligan/vtx-engine/blob/master/crates/vtx-engine/src/platform/macos/screencapturekit.rs)。它是完整引擎，仍需处理各平台的权限与设备生命周期，不一定是小型即插即用 crate。 | MIT |
| [Whisper Real-Time Transcription](https://github.com/optiummusic/Whisper-Real-Time-Transcription) | Linux Rust 离线转写；支持输入设备。采系统播放需把 PipeWire/PulseAudio monitor source 路由成输入。 | 有 `whisper-rs`/whisper.cpp、Silero VAD、重采样与片段拼接示例；[audio pipeline](https://github.com/optiummusic/Whisper-Real-Time-Transcription/blob/main/transcriber/src/audio.rs)。不是自动 desktop-loopback；需要手动配置 monitor source。未找到可核实的许可证文件。 | 未核实 |
| [martin](https://github.com/vagnerzampieri/martin) | Linux/Tauri 应用；经 `pw-record` 单独录制 mic 与 system audio，再混合并用 Whisper 转写。 | 可看 [`audio/capture.rs`](https://github.com/vagnerzampieri/martin/blob/main/src-tauri/src/audio/capture.rs) 和 [`transcribe/whisper.rs`](https://github.com/vagnerzampieri/martin/blob/main/src-tauri/src/transcribe/whisper.rs)。更偏录后转写而非最小实时引擎；system capture 失败时可退回 mic-only。 | GPL-3.0 |
| [tauri-plugin-wasapi](https://github.com/CryptoPunk/tauri-plugin-wasapi) | Windows/Tauri 插件，提供麦克风、系统输出 loopback 和进程级 loopback，向 Tauri IPC 传 PCM。 | **适合只复用 Windows 捕获层**，自身不含 ASR；可把 PCM 接到 Whisper/sherpa-onnx。源码：[desktop.rs](https://github.com/CryptoPunk/tauri-plugin-wasapi/blob/main/src/desktop.rs)。未找到可核实的许可证文件。 | 未核实 |
| [hark](https://github.com/PhantomYdn/hark) | macOS 原生 Swift app；macOS 14.4+ Core Audio process taps，可捕获系统/所选 app 音频；支持 whisper.cpp、Apple Speech 等。 | **非 Rust，但可作 macOS 原生 API 参考**；源码：[SystemCaptureSession.swift](https://github.com/PhantomYdn/hark/blob/main/Sources/TapEngine/SystemCaptureSession.swift)、[ProcessTap.swift](https://github.com/PhantomYdn/hark/blob/main/Sources/TapEngine/ProcessTap.swift)。README 标为 pre-1.0 beta。 | MIT |

另有一些检索命中的候选（如 [CorpoDrone](https://github.com/Earu/CorpoDrone)、[Wisp](https://github.com/ppXD/Wisp)、[Nota](https://github.com/kwp-lab/nota)、[clipclip](https://github.com/sincekmori/clipclip)）；本次未逐一核实其当前状态与源码实现，先作为线索，不作为首选依赖。非 Rust 的 [whisper-loopback](https://github.com/jasonssdev/whisper-loopback) 则可参考 macOS BlackHole + Whisper 的虚拟设备方案，但它需要额外虚拟音频设备。

**结论：确有相似开源实现。若先做 Windows Rust MVP，优先读 Auricle 和 `tauri-plugin-wasapi`；若目标是跨平台引擎，先评估 vtx-engine；Linux 可参考 Whisper Real-Time Transcription/martin；macOS 原生 tap 可参考 hark。没有必要为了 ASR 去实现 A2DP 空口解码，OS loopback 是更合适的层。**

## 5. 推荐落地顺序

1. **Windows POC（先验证“抓得到”）**：WASAPI 列出 render endpoints → 用户选蓝牙耳机 → loopback PCM 写 WAV；验证设备选择、声道/采样率、静音与 volume 行为、断连重连。
2. **接入 ASR**：转换为 16 kHz mono，比较 `whisper-rs` 分块方案与 sherpa-onnx 流式模型；先测真实延迟、CPU/GPU 占用和文本重复/漏字。
3. **完善产品行为**：处理 endpoint 默认值改变、设备移除/恢复、无声音、队列溢出、暂停/恢复；给用户明确的系统音频捕获状态指示。
4. **扩展平台**：Linux 做 PipeWire/Pulse monitor 后端；macOS 做 ScreenCaptureKit 或 Core Audio tap，并完成权限说明与用户授权流程。

## 6. 验收测试清单

- 选中蓝牙耳机播放 YouTube/本地语音，确认 loopback WAV 有声且不含麦克风环境声。
- 同时有其他应用播放提示音时，确认系统 endpoint 采集会把它们混进来；如果不接受，改用应用级捕获。
- 改变默认输出、断开/重连蓝牙耳机、切换到另一设备，验证端点重新绑定。
- 对比 Windows 音量静音前后 loopback 样本，记录实际是 pre-volume 还是设备支持 post-volume；不要把“音频内容相同”与“耳机实际响度相同”混为一谈。
- 开启蓝牙耳机麦克风/会议通话，让设备切入 HFP 后重新验证样本、格式、延迟与识别率。
- 测试独占模式应用、播放保护内容和厂商音效；记录不可捕获情形。
- 检查采集线程是否阻塞、丢帧与 ASR 队列延迟是否持续增长。

## 7. 榜单核对：识别准确率排名（非实时 / 实时流式 × 中文 / 英文）

> 核查时间 2026-10-10。以下均为榜单/发布方公布的数字，不是本机实测；榜单持续变动，以链接为准。当日 huggingface.co 直连超时，英文榜单 CSV 经 hf-mirror.com 镜像获取（与 HF 同一数据文件）。另注：2026 年 leaderboard 切换过 cleaned 测试集与聚合列，不同快照的 WER 不可跨表比较；按最新快照合成的模型天梯见 [`docs/asr-model-tier-list.md`](asr-model-tier-list.md)。

### 7.1 非实时（整段离线）· 英文：Hugging Face Open ASR Leaderboard

这是目前最标准的英文离线榜：9 个英文测试集（AMI、Earnings22、GigaSpeech、LibriSpeech clean/other、SPGISpeech、URGENT2024、Voice Arena Monsoon、VoxPopuli）的综合 WER（`avg`，越低越好），并给出 RTFx（吞吐倍数，越大越快）。开放权重模型摘录（[结果 CSV](https://huggingface.co/datasets/hf-audio/open-asr-leaderboard-results/blob/main/english_short_latest.csv)）：

| 模型 | 参数 | avg WER | RTFx | 许可 |
|---|---|---|---|---|
| microsoft/Phi-4-multimodal-instruct | 6B | **5.02** | 163 | MIT |
| ibm-granite/granite-speech-3.3-8b | 9B | 5.26 | 263 | Apache-2.0 |
| ibm-granite/granite-speech-3.3-2b | 3B | 5.36 | 509 | Apache-2.0 |
| Qwen/Qwen3-ASR-1.7B-hf | 2.04B | 5.75 | 836 | Apache-2.0 |
| TheStageAI/thewhisper-large-v3-turbo | 0.8B | 6.07 | 1184 | CC-BY-4.0 |
| OpenMOSS/MOSS-Transcribe-Diarize | 0.91B | 6.29 | 387 | Apache-2.0 |
| Edge0/ARK-ASR-0.6B | 1.15B | 6.29 | 673 | Apache-2.0 |
| nvidia/canary-qwen-2.5b | 2.5B | 6.37 | 882 | CC-BY-4.0 |
| nvidia/parakeet-tdt-0.6b-v3 | 0.6B | 6.51 | 6228 | CC-BY-4.0 |
| Qwen/Qwen3-ASR-0.6B-hf | 0.78B | 6.60 | 750 | Apache-2.0 |
| ibm-granite/granite-speech-5.0-470m-turboctc | 0.47B | 6.84 | **21134** | Apache-2.0 |
| nvidia/nemotron-speech-streaming-en-0.6b | 0.62B | 6.89 | 1114 | NVIDIA 开放许可 |
| distil-whisper/distil-large-v3.5 | 0.8B | 7.02 | 898 | MIT |
| FunAudioLLM/Fun-ASR-Nano-2512-hf | 0.83B | 7.76 | 506 | Apache-2.0 |
| openai/whisper-large-v3 | 2B | 7.84 | 471 | Apache-2.0 |
| openai/whisper-large-v3-turbo | 0.8B | 8.39 | 811 | MIT |
| mistralai/Voxtral-Mini-4B-Realtime-2602 | 4B | 9.01 | 103 | Apache-2.0 |
| nvidia/nemotron-3.5-asr-streaming-0.6b（40 语言） | 0.64B | 10.51 | 1348 | OpenMDW-1.1 |

参照：榜上商业 API 最好的 reson8/resonant-1-flash（4.02）、zoom/scribe_v1（4.15）不属本地模型；开源阵营的准确率头部是“Conformer 编码器 + LLM 解码器”类大模型，小模型靠速度取胜（parakeet-tdt-0.6b RTFx 6000+，turboctc 2 万倍速）。

### 7.2 非实时 · 中文：AISHELL / WenetSpeech CER 榜

中文没有统一离线榜，公认的对照表是 [FireRedASR 官方评测](https://github.com/learningpro/FireRedASR)（CER%，含 AISHELL-1/2 + WenetSpeech net/meeting 四项）：

| 模型 | 参数 | aishell1 | aishell2 | ws_net | ws_meeting | 四项平均 |
|---|---|---|---|---|---|---|
| FireRedASR-LLM | 8.3B | 0.76 | 2.15 | 4.60 | 4.67 | **3.05** |
| FireRedASR-AED | 1.1B | **0.55** | 2.52 | 4.88 | 4.76 | 3.18 |
| Seed-ASR | 12B+ | 0.68 | 2.27 | 4.66 | 5.69 | 3.33 |
| SenseVoice-L | 1.6B | 2.09 | 3.04 | 6.01 | 6.73 | 4.47 |
| Paraformer-Large | 0.2B | 1.68 | 2.85 | 6.74 | 6.97 | 4.56 |
| Qwen-Audio | 8.4B | 1.30 | 3.10 | 9.50 | 10.87 | 6.19 |
| Whisper-Large-v3 | 1.6B | 5.14 | 4.96 | 10.48 | 18.87 | 9.86 |

[SOTA2 榜](https://www.sota2.com/research/sota/automatic-speech-recognition-on-aishell-1-cer)更新条目（2026-01/04 快照）：AISHELL-1 CER：FireRed-ASR（1.1B）**0.54**、Fun-ASR（7.7B）1.22；[WenetSpeech-net CER](https://www.sota2.com/research/sota/automatic-speech-recognition-on-wenetspeech-net-cer)：FireRedASR2S（8B+）3.52、Qwen3-Omni（30B-A3B）3.85、Qwen3-ASR 1.7B 4.13。注意：**SenseVoiceSmall（234M）没有公开主流榜的 CER**（4.47 是 SenseVoice-**L**）；小型本地模型里有榜可查的是 Paraformer-Large（0.2B）和各类流式 Zipformer。FireRedASR-AED 输入限 60 s、FireRedASR-LLM 限 30 s，只适合切段精转。

### 7.3 实时（流式）· 中文：同模型 streaming vs offline 的代价

中文流式没有商业意义上的统一榜，但训练侧（icefall/PaddleSpeech）公布了同模型流式/离线对照（CER%）：

| [icefall multi_zh-hans](https://github.com/k2-fsa/icefall/blob/master/egs/multi_zh-hans/ASR/RESULTS.md)（~160M causal Zipformer-large） | aishell1 test | ws meeting | ws net |
|---|---|---|---|
| Transducer 离线 | 1.38 | 6.26 | 7.07 |
| Transducer 流式 | 1.91 | 7.91 | 8.54 |
| CTC 离线 | 1.50 | 6.52 | 9.64 |
| CTC 流式 | 1.97 | 8.13 | 10.62 |
| Zipformer-xl ~700M 离线 | 1.31 | 5.85 | 6.89 |
| Zipformer ~69M 非流式 | 3.04 | 7.19 | 8.78 |

- [PaddleSpeech WenetSpeech](https://github.com/PaddlePaddle/PaddleSpeech/blob/develop/examples/wenetspeech/asr1/RESULTS.md)：chunk conformer 123M 流式 WS test-net CER 11.0~12.1%、test meeting 18.8~19.9%；AISHELL-1 chunk=16 流式 5.6~7.9% vs 非流式 4.8~6.2%。
- X-ASR-zh-en 模型卡自报流式 WenetSpeech 列：160/480/960/1920 ms = 12.04 / 9.31 / 8.84 / 8.03 CER（列名为推断，技术报告未出）。

**结论**：中文流式小模型（≤200M）的真实水平是 WenetSpeech test-net **CER 8~12%**，离线大模型才能到 3~5%；流式相对离线固定损失约 0.5~1.5 CER，会议场景损失更大。产品上合理结构是“流式实时粗转 + 会后离线精转”，而不是指望一个流式小模型同时满足字幕延迟和定稿准确率。

### 7.4 实时（流式）· 英文

- [Artificial Analysis AA-WER Streaming](https://artificialanalysis.ai/speech-to-text/streaming) 是目前唯一直接评“流式 WER + 端点后延迟”的榜（AgentTalk/VoxPopuli/Earnings22 加权，约 8 小时音频）；Pareto 前沿目前以 API（Cartesia/ElevenLabs/Deepgram 等）为主，支持 open-weights 筛选，但未见中文数据。
- 本地流式模型在离线榜里的速度/准确率位置（供交叉参考）：granite-speech-5.0-470m-turboctc（Streaming-style Conformer+CTC，avg 6.84 / RTFx 21134）、nemotron-speech-streaming-en-0.6b（cache-aware FastConformer+RNNT，avg 6.89 / RTFx 1114）、Voxtral-Mini-4B-Realtime（avg 9.01）。
- [Moonshine v2](https://arxiv.org/html/2602.12241v1)（2026-02，仅英文，边端流式）：滑窗注意力编码器，端点后响应延迟 Tiny **50 ms** / Small **148 ms** / Medium **258 ms**（Apple M3），比同级 Whisper 快 5.8~43.7x；准确率在 Open ASR 榜参数-精度 Pareto 前沿。

**2026-09 流式开源潮（模型卡自报，★ 未独立复现，详见 [天梯榜](asr-model-tier-list.md)）**：
- [Confucius4-R2T2](https://huggingface.co/netease-youdao/Confucius4-R2T2)（网易有道，2B，Qwen3-ASR 底座）：**append-only 稳定前缀、输出永不回改**，chunk 80ms–2s、延迟 200–600ms；Wenet-meeting CER 7.27 vs 离线 5.97（裸流式 20.38）。代码 Apache-2.0，权重为 NetEase 自定义许可（商用前必查）；推理走 vLLM + WebSocket 侧车，非 Rust 原生。
- [Audio8-ASR-Infinite](https://huggingface.co/Edge0/Audio8-ASR-Infinite)（Edge0，~7B 中英）：滚动 KV cache 无限时长；自报 AISHELL-1 CER 1.75、AISHELL-4 2.89 @480ms，但 bf16 权重 8.17GB、需 ~16GB GPU，4GB 本机跑不动；Apache-2.0。
- [VibeVoice-ASR-Streaming](https://arxiv.org/html/2609.02812v2)（微软，1.5B/7B）：流式说话人归属（who said what），5 集均值 24.66 打平 Gemini 3.5 Transcribe Live；会议场景直击，但远场会议 CER 仍高（AISHELL-4 22.76）。

### 7.5 对 Meeting Master 选型的含义

1. **实时层（字幕/当前句）**：中英双语 + Rust 接入，sherpa-onnx 流式 Zipformer/X-ASR-zh-en 仍是本机 4GB 双路的可行起点；但 2026-09 后必须把 Confucius4-R2T2（稳定前缀、中文 CER 显著更优）作为对照组——若量化后能在本机实时运行，应切换主链路。英文单语则 granite-5.0-470m-turboctc、nemotron-speech-streaming-en-0.6b、Moonshine v2 值得对照，但各有不同 runtime（NeMo/自研 ONNX/whisper.cpp 系）与集成成本。
2. **精转层（会后定稿）**：中文对标 FireRedASR-AED 1.1B（aishell1 0.55，需切段 ≤60s）；英文对标 parakeet-tdt-0.6b-v3 或 Qwen3-ASR-1.7B。均非流式。
3. **两层折衷有榜单依据**：中文流式 8~12% CER vs 离线 3~5%；英文流式小模型 6.5~7 avg WER vs 离线头部 5~6。
4. **榜单都是单路、干净测试集**；双路并发、蓝牙 loopback、中英混说、会议术语不在任何榜单覆盖范围，最终指标必须本机实测（见第 6 节清单）。

## 参考资料

### 官方平台文档

- Microsoft, [Loopback Recording (WASAPI)](https://learn.microsoft.com/en-us/windows/win32/coreaudio/loopback-recording)
- Microsoft, [AUDCLNT_STREAMFLAGS_LOOPBACK](https://learn.microsoft.com/en-us/windows/win32/coreaudio/audclnt-streamflags-xxx-constants)
- Microsoft, [Application Loopback Audio Sample](https://learn.microsoft.com/en-us/samples/microsoft/windows-classic-samples/applicationloopbackaudio-sample/), [Process loopback mode minimum OS](https://learn.microsoft.com/en-us/windows/win32/api/audioclientactivationparams/ne-audioclientactivationparams-process_loopback_mode)
- Microsoft, [Bluetooth Classic Audio (A2DP/HFP)](https://learn.microsoft.com/en-us/windows-hardware/drivers/bluetooth/bluetooth-classic-audio)
- Microsoft, [Audio Sideband A2DP Offload](https://learn.microsoft.com/en-us/windows-hardware/drivers/audio/audio-sideband-a2dp-offload)
- Microsoft, [Windows 11 APIs for Audio Processing Objects](https://learn.microsoft.com/en-us/windows-hardware/drivers/audio/windows-11-apis-for-audio-processing-objects), [Device Events](https://learn.microsoft.com/en-us/windows/win32/coreaudio/device-events), [DRM Requirements](https://learn.microsoft.com/en-us/windows-hardware/drivers/audio/drm-requirements)
- PipeWire, [Audio](https://docs.pipewire.org/page_audio.html), [audio-capture example](https://docs.pipewire.org/audio-capture_8c-example.html), [Loopback](https://pipewire.pages.freedesktop.org/pipewire/page_module_loopback.html), [Bluetooth configuration](https://pipewire.pages.freedesktop.org/wireplumber/daemon/configuration/bluetooth.html)
- PulseAudio, [FAQ](https://www.freedesktop.org/wiki/Software/PulseAudio/FAQ/) and [monitor documentation](https://www.freedesktop.org/wiki/Software/PulseAudio/Documentation/Developer/Clients/WritingVolumeControlUIs/)
- Apple, [Capturing system audio with Core Audio taps](https://developer.apple.com/documentation/coreaudio/capturing-system-audio-with-core-audio-taps)
- Apple, [Capturing screen content in macOS (ScreenCaptureKit)](https://developer.apple.com/documentation/screencapturekit/capturing-screen-content-in-macos), [`capturesAudio`](https://developer.apple.com/documentation/screencapturekit/scstreamconfiguration/capturesaudio)
- Apple, [`CATapDescription.deviceUID`](https://developer.apple.com/documentation/coreaudio/catapdescription/deviceuid), [`NSAudioCaptureUsageDescription`](https://developer.apple.com/documentation/bundleresources/information-property-list/nsaudiocaptureusagedescription)

### ASR 榜单与模型基准（第 7 节）

- Hugging Face：[Open ASR Leaderboard](https://huggingface.co/spaces/hf-audio/open_asr_leaderboard)（[结果数据集](https://huggingface.co/datasets/hf-audio/open-asr-leaderboard-results)、[趋势博客](https://huggingface.co/blog/open-asr-leaderboard)、[论文 2510.06961](https://huggingface.co/papers/2510.06961)）
- 中文离线：[FireRedASR 评测表](https://github.com/learningpro/FireRedASR) · [SOTA2 AISHELL-1 CER](https://www.sota2.com/research/sota/automatic-speech-recognition-on-aishell-1-cer) · [SOTA2 WenetSpeech-net CER](https://www.sota2.com/research/sota/automatic-speech-recognition-on-wenetspeech-net-cer)
- 中文流式：[icefall multi_zh-hans RESULTS](https://github.com/k2-fsa/icefall/blob/master/egs/multi_zh-hans/ASR/RESULTS.md) · [PaddleSpeech WenetSpeech RESULTS](https://github.com/PaddlePaddle/PaddleSpeech/blob/develop/examples/wenetspeech/asr1/RESULTS.md)
- 英文流式：[AA-WER Streaming](https://artificialanalysis.ai/speech-to-text/streaming)（[方法学](https://artificialanalysis.ai/methodology/speech-to-text)）· [Moonshine v2 论文](https://arxiv.org/html/2602.12241v1)

### Rust crates（版本以调研时核对的文档为准）

- Windows：[wasapi 0.25.0](https://docs.rs/wasapi/0.25.0/wasapi/) · [`new_application_loopback_client`](https://docs.rs/wasapi/0.25.0/wasapi/struct.AudioClient.html#method.new_application_loopback_client) · [windows 0.62.2 / `IAudioClient`](https://microsoft.github.io/windows-docs-rs/doc/windows/Win32/Media/Audio/struct.IAudioClient.html) · [cpal 0.18.2](https://docs.rs/cpal/0.18.2/cpal/)
- Linux：[pipewire 0.10.1](https://docs.rs/pipewire/0.10.1/pipewire/) · [libpulse-binding 2.30.1](https://docs.rs/libpulse-binding/2.30.1/libpulse_binding/stream/struct.Stream.html)
- macOS：[coreaudio 0.3.3](https://docs.rs/coreaudio/0.3.3/coreaudio/) · [screencapturekit 11.0.0](https://docs.rs/screencapturekit/11.0.0/screencapturekit/)
- 音频处理：[ringbuf 0.5.3](https://crates.io/crates/ringbuf) · [dasp_sample 0.11.0](https://crates.io/crates/dasp_sample) · [rubato 5.0.1](https://docs.rs/rubato/5.0.1/rubato/)
- ASR：[sherpa-onnx 1.13.8 Rust API](https://k2-fsa.github.io/sherpa/onnx/rust-api/) · [whisper-rs 0.16.0](https://docs.rs/whisper-rs/0.16.0/whisper_rs/) · [vosk 0.3.1](https://crates.io/crates/vosk)
