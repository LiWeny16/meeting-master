//! Small helpers shared by the ASR modules.

use std::time::{SystemTime, UNIX_EPOCH};

/// Truncate `value` to at most `max_chars` characters, appending an ellipsis
/// when content was removed.
pub(crate) fn truncate_chars(value: &str, max_chars: usize) -> String {
    let mut chars = value.chars();
    let prefix: String = chars.by_ref().take(max_chars).collect();
    if chars.next().is_some() {
        format!("{prefix}...")
    } else {
        prefix
    }
}

/// Collapse arbitrary whitespace (including newlines) into single spaces.
pub(crate) fn collapse_whitespace(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Current Unix time in milliseconds, clamped to the positive `i64` range.
pub(crate) fn now_unix_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncation_respects_character_boundaries() {
        assert_eq!(truncate_chars("hello", 10), "hello");
        assert_eq!(truncate_chars("hello", 5), "hello");
        assert_eq!(truncate_chars("hello!", 5), "hello...");
        assert_eq!(truncate_chars("语音识别", 2), "语音...");
    }

    #[test]
    fn whitespace_is_collapsed() {
        assert_eq!(collapse_whitespace("  a\n b\tc "), "a b c");
    }
}
