//! Windows DPAPI-backed secret storage.
//!
//! Secrets are encrypted with `CryptProtectData` for the current Windows user
//! and persisted as `dpapi:<base64>` strings. They are never written to disk in
//! plaintext and never sent to the frontend.

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;

pub(crate) const DPAPI_PREFIX: &str = "dpapi:";

/// Encrypt a UTF-8 secret for the current Windows user.
#[cfg(windows)]
pub(crate) fn protect(secret: &str) -> Result<String, String> {
    let ciphertext = protect_bytes(secret.as_bytes())?;
    Ok(format!("{DPAPI_PREFIX}{}", BASE64.encode(ciphertext)))
}

/// Decrypt a value previously produced by [`protect`].
#[cfg(windows)]
pub(crate) fn unprotect(stored: &str) -> Result<String, String> {
    let encoded = stored
        .strip_prefix(DPAPI_PREFIX)
        .ok_or_else(|| "Stored secret uses an unsupported format.".to_string())?;
    let ciphertext = BASE64
        .decode(encoded.trim())
        .map_err(|error| format!("Stored secret is not valid base64: {error}"))?;
    let plaintext = unprotect_bytes(&ciphertext)?;
    String::from_utf8(plaintext).map_err(|_| "Decrypted secret is not valid UTF-8.".to_string())
}

#[cfg(windows)]
fn protect_bytes(plaintext: &[u8]) -> Result<Vec<u8>, String> {
    use windows::Win32::Security::Cryptography::{
        CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData,
    };
    use windows::core::PCWSTR;

    let mut input = plaintext.to_vec();
    let input_len = u32::try_from(input.len())
        .map_err(|_| "Secret is too large for Windows DPAPI.".to_string())?;
    let input_blob = CRYPT_INTEGER_BLOB {
        cbData: input_len,
        pbData: input.as_mut_ptr(),
    };
    let mut output = CRYPT_INTEGER_BLOB::default();

    // SAFETY: `input_blob` points at a live buffer for the duration of the
    // call, and `output` is an out-parameter owned by DPAPI on success.
    let result = unsafe {
        CryptProtectData(
            &input_blob,
            PCWSTR::null(),
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    let ciphertext = result
        .map_err(|error| format!("Windows DPAPI encryption failed: {error}"))
        .and_then(|()| copy_and_free(output));

    input.fill(0);
    ciphertext
}

#[cfg(windows)]
fn unprotect_bytes(ciphertext: &[u8]) -> Result<Vec<u8>, String> {
    use windows::Win32::Security::Cryptography::{
        CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptUnprotectData,
    };

    let mut input = ciphertext.to_vec();
    let input_len = u32::try_from(input.len())
        .map_err(|_| "Stored secret is too large for Windows DPAPI.".to_string())?;
    let input_blob = CRYPT_INTEGER_BLOB {
        cbData: input_len,
        pbData: input.as_mut_ptr(),
    };
    let mut output = CRYPT_INTEGER_BLOB::default();

    // SAFETY: `input_blob` points at a live buffer for the duration of the
    // call; `output` receives an allocation that is released below.
    let result = unsafe {
        CryptUnprotectData(
            &input_blob,
            None,
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    let plaintext = result
        .map_err(|error| {
            format!("Windows DPAPI decryption failed (the credential store may belong to another user or machine): {error}")
        })
        .and_then(|()| copy_and_free(output));

    input.fill(0);
    plaintext
}

/// Copy a DPAPI output blob and release it with `LocalFree`.
#[cfg(windows)]
fn copy_and_free(
    blob: windows::Win32::Security::Cryptography::CRYPT_INTEGER_BLOB,
) -> Result<Vec<u8>, String> {
    use windows::Win32::Foundation::{HLOCAL, LocalFree};

    if blob.pbData.is_null() || blob.cbData == 0 {
        return Err("Windows DPAPI returned an empty payload.".to_string());
    }

    // SAFETY: DPAPI guarantees `pbData` points at `cbData` readable bytes.
    let bytes = unsafe { std::slice::from_raw_parts(blob.pbData, blob.cbData as usize).to_vec() };
    // SAFETY: DPAPI allocates this buffer with LocalAlloc; it must be released
    // exactly once with LocalFree.
    unsafe {
        let _ = LocalFree(Some(HLOCAL(blob.pbData as *mut core::ffi::c_void)));
    }
    Ok(bytes)
}

/// DPAPI is Windows-only. Other targets fail closed instead of storing
/// secrets in plaintext.
#[cfg(not(windows))]
pub(crate) fn protect(_secret: &str) -> Result<String, String> {
    Err("Secret storage is only supported on Windows.".to_string())
}

#[cfg(not(windows))]
pub(crate) fn unprotect(_stored: &str) -> Result<String, String> {
    Err("Secret storage is only supported on Windows.".to_string())
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn dpapi_round_trip_preserves_unicode() {
        let secret = "sk-test-秘密-1234";
        let encrypted = protect(secret).expect("protect");
        assert!(encrypted.starts_with(DPAPI_PREFIX));
        assert!(!encrypted.contains(secret));
        assert_eq!(unprotect(&encrypted).expect("unprotect"), secret);
    }

    #[test]
    fn dpapi_rejects_unrecognized_storage_format() {
        assert!(unprotect("plain-text-secret").is_err());
        assert!(unprotect("dpapi:not-base64!").is_err());
    }
}
