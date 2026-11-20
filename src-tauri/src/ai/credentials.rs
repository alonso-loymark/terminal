//! The Anthropic API key in the Windows Credential Manager (a generic credential of this user
//! on this machine). Never in settings.json, never in plain text on disk, never logged; the
//! frontend only ever sees its last four characters.

use std::ptr::null_mut;

use windows_sys::Win32::Foundation::{ERROR_NOT_FOUND, GetLastError};
use windows_sys::Win32::Security::Credentials::{
    CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC, CREDENTIALW, CredDeleteW, CredFree, CredReadW,
    CredWriteW,
};

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

/// The secret stored under `target`, if any.
pub fn read(target: &str) -> Option<String> {
    let target = wide(target);
    let mut credential: *mut CREDENTIALW = null_mut();
    // SAFETY: valid target string and out pointer; the buffer is freed with CredFree below.
    if unsafe { CredReadW(target.as_ptr(), CRED_TYPE_GENERIC, 0, &mut credential) } == 0 {
        return None;
    }
    // SAFETY: CredReadW succeeded: `credential` points to a valid CREDENTIALW whose blob holds
    // `CredentialBlobSize` bytes.
    let secret = unsafe {
        let c = &*credential;
        let bytes = if c.CredentialBlob.is_null() {
            &[][..]
        } else {
            std::slice::from_raw_parts(c.CredentialBlob, c.CredentialBlobSize as usize)
        };
        let secret = String::from_utf8(bytes.to_vec()).ok();
        CredFree(credential.cast());
        secret
    };
    secret.filter(|s| !s.is_empty())
}

pub fn write(target: &str, secret: &str) -> Result<(), String> {
    let mut target_w = wide(target);
    let mut user = wide("Brisa");
    let mut comment = wide("API key de Anthropic para la IA de Brisa");
    let mut blob = secret.as_bytes().to_vec();
    let credential = CREDENTIALW {
        Type: CRED_TYPE_GENERIC,
        TargetName: target_w.as_mut_ptr(),
        Comment: comment.as_mut_ptr(),
        CredentialBlobSize: u32::try_from(blob.len()).map_err(|_| "clave demasiado larga")?,
        CredentialBlob: blob.as_mut_ptr(),
        Persist: CRED_PERSIST_LOCAL_MACHINE,
        UserName: user.as_mut_ptr(),
        ..Default::default()
    };
    // SAFETY: every pointer in `credential` is valid for the duration of the call.
    let ok = unsafe { CredWriteW(&credential, 0) };
    blob.fill(0);
    if ok == 0 {
        // SAFETY: reads the calling thread's last error code.
        return Err(format!("CredWrite falló (error {})", unsafe {
            GetLastError()
        }));
    }
    Ok(())
}

/// True if there was one to delete.
pub fn delete(target: &str) -> Result<bool, String> {
    let target = wide(target);
    // SAFETY: valid target string.
    if unsafe { CredDeleteW(target.as_ptr(), CRED_TYPE_GENERIC, 0) } != 0 {
        return Ok(true);
    }
    // SAFETY: reads the calling thread's last error code.
    match unsafe { GetLastError() } {
        ERROR_NOT_FOUND => Ok(false),
        code => Err(format!("CredDelete falló (error {code})")),
    }
}

/// "…abcd": enough to tell keys apart, nothing more.
pub fn hint(target: &str) -> Option<String> {
    let secret = read(target)?;
    let tail: String = secret
        .chars()
        .rev()
        .take(4)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    Some(format!("…{tail}"))
}
