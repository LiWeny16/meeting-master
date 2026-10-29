//! Static catalog of downloadable local ASR models and on-disk verification.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

const GIB: u64 = 1024 * 1024 * 1024;

#[derive(Debug, Clone, Copy)]
pub(crate) struct CatalogFile {
    /// Path relative to the model directory. Always uses `/` separators.
    pub path: &'static str,
    pub size: u64,
    pub sha256: &'static str,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct CatalogModel {
    pub id: &'static str,
    pub name: &'static str,
    pub vendor: &'static str,
    pub description: &'static str,
    pub repo: &'static str,
    pub languages: &'static [&'static str],
    pub min_vram_bytes: u64,
    pub files: &'static [CatalogFile],
}

impl CatalogModel {
    pub(crate) fn total_bytes(&self) -> u64 {
        self.files.iter().map(|file| file.size).sum()
    }
}

pub(crate) const CATALOG: &[CatalogModel] = &[
    CatalogModel {
        id: "sensevoice-small",
        name: "SenseVoice Small",
        vendor: "FunAudioLLM",
        repo: "csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17",
        description: "Fast multilingual model for CPU-only machines.",
        languages: &["zh", "en", "ja", "ko", "yue"],
        min_vram_bytes: 0,
        files: &[
            CatalogFile {
                path: "model.int8.onnx",
                size: 239_233_841,
                sha256: "c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51",
            },
            CatalogFile {
                path: "tokens.txt",
                size: 315_894,
                sha256: "f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc",
            },
        ],
    },
    CatalogModel {
        id: "qwen3-asr-0.6b",
        name: "Qwen3-ASR 0.6B",
        vendor: "Alibaba Qwen",
        repo: "csukuangfj2/sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25",
        description: "Current-generation compact model with strong Chinese and multilingual accuracy.",
        languages: &["zh", "en", "ja", "ko", "ru", "fr", "de", "es", "yue"],
        min_vram_bytes: 2 * GIB,
        files: &[
            CatalogFile {
                path: "conv_frontend.onnx",
                size: 44_148_281,
                sha256: "d22dc4423e0940e49884e903d2ea2f7e5567c14fc1aed97e4e26d6b8f208ef9e",
            },
            CatalogFile {
                path: "encoder.int8.onnx",
                size: 182_491_662,
                sha256: "60748d3e6744a57c9c91e1b17424a6c2990567e8adceb0783940c03ed98fa9d9",
            },
            CatalogFile {
                path: "decoder.int8.onnx",
                size: 755_914_231,
                sha256: "4f6885be5959ae26af3089d38ee7972c5fafbeeb1cf8d5e76eab6d8b61ca5771",
            },
            CatalogFile {
                path: "tokenizer/merges.txt",
                size: 1_671_853,
                sha256: "8831e4f1a044471340f7c0a83d7bd71306a5b867e95fd870f74d0c5308a904d5",
            },
            CatalogFile {
                path: "tokenizer/tokenizer_config.json",
                size: 12_487,
                sha256: "4942d005604266809309cabc9f4e9cb89ce855d59b14681fdc0e1cc62ea26c4c",
            },
            CatalogFile {
                path: "tokenizer/vocab.json",
                size: 2_776_833,
                sha256: "ca10d7e9fb3ed18575dd1e277a2579c16d108e32f27439684afa0e10b1440910",
            },
        ],
    },
    CatalogModel {
        id: "firered-asr2-large",
        name: "FireRedASR2-AED Large",
        vendor: "FireRedTeam",
        repo: "csukuangfj/sherpa-onnx-fire-red-asr-large-zh_en-2025-02-16",
        description: "Highest Chinese accuracy; larger download and slower on CPU.",
        languages: &["zh", "en"],
        min_vram_bytes: 6 * GIB,
        files: &[
            CatalogFile {
                path: "encoder.int8.onnx",
                size: 1_293_430_814,
                sha256: "e60cfef737a0ea324846a64eca8b9dae35898f353f4e34b62ad7e536e2d86add",
            },
            CatalogFile {
                path: "decoder.int8.onnx",
                size: 445_469_383,
                sha256: "c08b9d0297ed17ad84087085e27a4adedcc4e8b3ef14770369f1665681cc507d",
            },
            CatalogFile {
                path: "tokens.txt",
                size: 71_448,
                sha256: "6907215aeb034f6926b26bf8abfd650f756781622480a2342ec1f29b2072cafe",
            },
        ],
    },
    CatalogModel {
        id: "whisper-large-v3-turbo",
        name: "Whisper Large v3 Turbo",
        vendor: "OpenAI",
        repo: "csukuangfj/sherpa-onnx-whisper-turbo",
        description: "Broad language coverage with fast turbo decoding.",
        languages: &["multilingual (99)"],
        min_vram_bytes: 4 * GIB,
        files: &[
            CatalogFile {
                path: "turbo-encoder.int8.onnx",
                size: 674_716_297,
                sha256: "b02dcdf54f348741e93fe732b67d933c8dcb6735655f710640143081db38878b",
            },
            CatalogFile {
                path: "turbo-decoder.int8.onnx",
                size: 361_080_764,
                sha256: "20accd02388482eb3a46bd615631adfdc85e1eb2c7db9ea3f02a40ffe6b81547",
            },
            CatalogFile {
                path: "turbo-tokens.txt",
                size: 816_730,
                sha256: "b34b360dbb493e781e479794586d661700670d65564001f23024971d1f2fa126",
            },
        ],
    },
    CatalogModel {
        id: "paraformer-zh",
        name: "Paraformer Chinese",
        vendor: "FunASR",
        repo: "csukuangfj/sherpa-onnx-paraformer-zh-2023-09-14",
        description: "Lightweight Chinese model with low memory use.",
        languages: &["zh"],
        min_vram_bytes: 0,
        files: &[
            CatalogFile {
                path: "model.int8.onnx",
                size: 243_371_218,
                sha256: "f36a0433bcf096bd6d6f11b80a3ac8bed110bdca632fe0d731df8d1a84475945",
            },
            CatalogFile {
                path: "tokens.txt",
                size: 75_756,
                sha256: "59aba8873a2ed1e122c25fee421e25f283b63290efbde85c1f01a853d83cb6e6",
            },
        ],
    },
];

pub(crate) fn find(model_id: &str) -> Option<&'static CatalogModel> {
    CATALOG.iter().find(|model| model.id == model_id)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InstalledFile {
    pub path: String,
    pub size: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InstalledManifest {
    pub model_id: String,
    pub installed_at: i64,
    pub files: Vec<InstalledFile>,
    pub total_bytes: u64,
}

pub(crate) fn manifest_file(model_dir: &Path) -> PathBuf {
    model_dir.join("installed.json")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum InstallState {
    NotInstalled,
    Installed,
    Corrupted,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Inspection {
    pub state: InstallState,
    pub installed_bytes: u64,
    pub installed_at: Option<i64>,
}

/// Inspect a model directory using the manifest plus actual file sizes.
///
/// A directory is only reported as installed when `installed.json` exists, its
/// recorded files match the catalog, and every catalog file exists on disk with
/// the expected size.
pub(crate) fn inspect(model_dir: &Path, model: &CatalogModel) -> Inspection {
    if !manifest_file(model_dir).is_file() {
        return Inspection {
            state: InstallState::NotInstalled,
            installed_bytes: 0,
            installed_at: None,
        };
    }

    let actual_bytes = sum_existing_bytes(model_dir, model);
    match read_manifest(model_dir) {
        Ok(manifest) => {
            let installed_at = Some(manifest.installed_at);
            if manifest_matches(&manifest, model, model_dir) {
                Inspection {
                    state: InstallState::Installed,
                    installed_bytes: model.total_bytes(),
                    installed_at,
                }
            } else {
                Inspection {
                    state: InstallState::Corrupted,
                    installed_bytes: actual_bytes,
                    installed_at,
                }
            }
        }
        Err(_) => Inspection {
            state: InstallState::Corrupted,
            installed_bytes: actual_bytes,
            installed_at: None,
        },
    }
}

pub(crate) fn read_manifest(model_dir: &Path) -> Result<InstalledManifest, String> {
    let path = manifest_file(model_dir);
    let data = fs::read(&path).map_err(|error| {
        format!(
            "Could not read install manifest {}: {error}",
            path.display()
        )
    })?;
    serde_json::from_slice(&data)
        .map_err(|error| format!("Install manifest {} is invalid: {error}", path.display()))
}

fn manifest_matches(manifest: &InstalledManifest, model: &CatalogModel, model_dir: &Path) -> bool {
    if manifest.model_id != model.id
        || manifest.total_bytes != model.total_bytes()
        || manifest.files.len() != model.files.len()
    {
        return false;
    }

    let mut recorded: HashMap<&str, &InstalledFile> = HashMap::new();
    for file in &manifest.files {
        if recorded.insert(file.path.as_str(), file).is_some() {
            return false;
        }
    }

    model.files.iter().all(|expected| {
        let Some(entry) = recorded.get(expected.path) else {
            return false;
        };
        if entry.size != expected.size || entry.sha256 != expected.sha256 {
            return false;
        }
        match fs::metadata(model_dir.join(expected.path)) {
            Ok(metadata) => metadata.is_file() && metadata.len() == expected.size,
            Err(_) => false,
        }
    })
}

fn sum_existing_bytes(model_dir: &Path, model: &CatalogModel) -> u64 {
    model
        .files
        .iter()
        .filter_map(|file| fs::metadata(model_dir.join(file.path)).ok())
        .filter(|metadata| metadata.is_file())
        .map(|metadata| metadata.len())
        .sum()
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::*;

    #[test]
    fn catalog_entries_are_well_formed() {
        let mut ids = HashSet::new();

        for model in CATALOG {
            assert!(!model.id.is_empty(), "model id must not be empty");
            assert!(ids.insert(model.id), "duplicate model id: {}", model.id);
            assert!(!model.name.is_empty());
            assert!(!model.vendor.is_empty());
            assert!(!model.repo.is_empty());
            assert!(!model.description.is_empty());
            assert!(!model.languages.is_empty());
            assert!(!model.files.is_empty(), "{} has no files", model.id);

            let mut total = 0u64;
            let mut paths = HashSet::new();
            for file in model.files {
                assert!(!file.path.is_empty());
                assert!(
                    paths.insert(file.path),
                    "{} has duplicate file {}",
                    model.id,
                    file.path
                );
                assert!(file.size > 0, "{}: {} has no size", model.id, file.path);
                assert_eq!(
                    file.sha256.len(),
                    64,
                    "{}: {} hash must be 64 hex chars",
                    model.id,
                    file.path
                );
                assert!(
                    file.sha256
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)),
                    "{}: {} hash must be lowercase hex",
                    model.id,
                    file.path
                );
                total = total.saturating_add(file.size);
            }
            assert_eq!(model.total_bytes(), total);
            assert!(model.total_bytes() > 0);
        }
    }
}
