//! WSL distributions installed for the current user, read from the registry like Windows
//! Terminal does: no `wsl.exe --list` process (which can take a second), so detecting them costs
//! nothing at startup.

/// Docker Desktop's internal distributions are not shells.
pub(crate) fn is_user_distro(name: &str) -> bool {
    let name = name.trim();
    !name.is_empty() && !name.to_ascii_lowercase().starts_with("docker-desktop")
}

/// Distribution names, the default one first.
#[cfg(windows)]
pub fn installed_distros() -> Vec<String> {
    registry::distros()
}

#[cfg(not(windows))]
pub fn installed_distros() -> Vec<String> {
    Vec::new()
}

#[cfg(windows)]
mod registry {
    use windows_sys::Win32::Foundation::ERROR_SUCCESS;
    use windows_sys::Win32::System::Registry::{
        HKEY, HKEY_CURRENT_USER, KEY_READ, RRF_RT_REG_DWORD, RRF_RT_REG_SZ, RegCloseKey,
        RegEnumKeyExW, RegGetValueW, RegOpenKeyExW,
    };

    const LXSS: &str = r"Software\Microsoft\Windows\CurrentVersion\Lxss";
    /// `State` of a distribution that finished installing.
    const STATE_INSTALLED: u32 = 1;

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// Closes the key when dropped.
    struct Key(HKEY);

    impl Drop for Key {
        fn drop(&mut self) {
            // SAFETY: the handle came from RegOpenKeyExW and is closed once.
            unsafe { RegCloseKey(self.0) };
        }
    }

    fn string_value(key: &Key, subkey: Option<&str>, name: &str) -> Option<String> {
        let subkey = subkey.map(wide);
        let subkey_ptr = subkey.as_ref().map_or(std::ptr::null(), |s| s.as_ptr());
        let name = wide(name);
        let mut buffer = [0u16; 512];
        let mut size = (buffer.len() * 2) as u32;
        // SAFETY: valid key, NUL-terminated strings and a buffer of `size` bytes.
        let status = unsafe {
            RegGetValueW(
                key.0,
                subkey_ptr,
                name.as_ptr(),
                RRF_RT_REG_SZ,
                std::ptr::null_mut(),
                buffer.as_mut_ptr().cast(),
                &mut size,
            )
        };
        if status != ERROR_SUCCESS {
            return None;
        }
        let len = (size as usize / 2).min(buffer.len());
        let text = String::from_utf16_lossy(&buffer[..len]);
        Some(text.trim_end_matches('\0').to_owned())
    }

    fn dword_value(key: &Key, subkey: &str, name: &str) -> Option<u32> {
        let subkey = wide(subkey);
        let name = wide(name);
        let mut value = 0u32;
        let mut size = 4u32;
        // SAFETY: valid key, NUL-terminated strings and a 4-byte buffer.
        let status = unsafe {
            RegGetValueW(
                key.0,
                subkey.as_ptr(),
                name.as_ptr(),
                RRF_RT_REG_DWORD,
                std::ptr::null_mut(),
                (&mut value as *mut u32).cast(),
                &mut size,
            )
        };
        (status == ERROR_SUCCESS).then_some(value)
    }

    pub fn distros() -> Vec<String> {
        let path = wide(LXSS);
        let mut handle: HKEY = std::ptr::null_mut();
        // SAFETY: NUL-terminated path; the handle is owned by `Key` from here on.
        let status =
            unsafe { RegOpenKeyExW(HKEY_CURRENT_USER, path.as_ptr(), 0, KEY_READ, &mut handle) };
        if status != ERROR_SUCCESS {
            return Vec::new();
        }
        let key = Key(handle);
        let default = string_value(&key, None, "DefaultDistribution");
        let mut found: Vec<(bool, String)> = Vec::new();
        for index in 0.. {
            let mut name = [0u16; 256];
            let mut len = name.len() as u32;
            // SAFETY: valid key and a buffer of `len` characters.
            let status = unsafe {
                RegEnumKeyExW(
                    key.0,
                    index,
                    name.as_mut_ptr(),
                    &mut len,
                    std::ptr::null(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                )
            };
            if status != ERROR_SUCCESS {
                break;
            }
            let guid = String::from_utf16_lossy(&name[..len as usize]);
            let installed = dword_value(&key, &guid, "State").is_none_or(|s| s == STATE_INSTALLED);
            let Some(distro) = string_value(&key, Some(&guid), "DistributionName") else {
                continue;
            };
            if installed && super::is_user_distro(&distro) {
                found.push((default.as_deref() == Some(guid.as_str()), distro));
            }
        }
        // The default distribution first, the rest as registered.
        found.sort_by_key(|(is_default, _)| !is_default);
        found.into_iter().map(|(_, name)| name).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn docker_desktop_distributions_are_not_shells() {
        assert!(is_user_distro("Ubuntu-24.04"));
        assert!(is_user_distro("Debian"));
        assert!(!is_user_distro("docker-desktop"));
        assert!(!is_user_distro("docker-desktop-data"));
        assert!(!is_user_distro("  "));
    }

    #[test]
    fn reading_the_registry_never_fails() {
        // No WSL here means an empty list, not an error; with WSL, real names.
        for name in installed_distros() {
            assert!(is_user_distro(&name), "{name}");
        }
    }
}
