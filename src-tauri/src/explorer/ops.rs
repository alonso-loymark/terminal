//! File operations from the explorer's context menu, and opening things in other programs.

use std::fs::{self, OpenOptions};
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Deserialize;

use super::ExplorerError;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NewEntryKind {
    File,
    Dir,
}

const RESERVED: &[&str] = &["CON", "PRN", "AUX", "NUL"];

/// A single valid Windows file name (no folders, no reserved device names).
pub fn validate_name(name: &str) -> Result<&str, ExplorerError> {
    let invalid = |why: &str| Err(ExplorerError::Invalid(why.to_owned()));
    if name.trim().is_empty() || name == "." || name == ".." {
        return invalid("el nombre está vacío");
    }
    if name.ends_with([' ', '.']) {
        return invalid("el nombre no puede terminar en espacio ni en punto");
    }
    if name
        .chars()
        .any(|c| matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || c < ' ')
    {
        return invalid("caracteres no permitidos: < > : \" / \\ | ? *");
    }
    let stem = name.split('.').next().unwrap_or(name).trim_end();
    let device = RESERVED.iter().any(|r| r.eq_ignore_ascii_case(stem))
        || ((stem.len() == 4)
            && (stem[..3].eq_ignore_ascii_case("COM") || stem[..3].eq_ignore_ascii_case("LPT"))
            && stem.as_bytes()[3].is_ascii_digit());
    if device {
        return invalid("es un nombre reservado de Windows");
    }
    Ok(name)
}

/// Creates an empty file or a folder named `name` inside `dir`; never overwrites.
pub fn create_entry(dir: &Path, name: &str, kind: NewEntryKind) -> Result<PathBuf, ExplorerError> {
    let path = dir.join(validate_name(name)?);
    match kind {
        NewEntryKind::File => OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map(drop),
        NewEntryKind::Dir => fs::create_dir(&path),
    }
    .map_err(|e| ExplorerError::io(&path, e))?;
    Ok(path)
}

/// Renames in place (same folder). A case-only rename (`readme` → `README`) is allowed.
pub fn rename_entry(path: &Path, new_name: &str) -> Result<PathBuf, ExplorerError> {
    let name = validate_name(new_name)?;
    let parent = path
        .parent()
        .ok_or_else(|| ExplorerError::Invalid("no se puede renombrar una unidad".to_owned()))?;
    let target = parent.join(name);
    let same = path
        .file_name()
        .is_some_and(|old| old.to_string_lossy().eq_ignore_ascii_case(name));
    if !same && fs::symlink_metadata(&target).is_ok() {
        return Err(ExplorerError::io(
            &target,
            std::io::Error::from(std::io::ErrorKind::AlreadyExists),
        ));
    }
    fs::rename(path, &target).map_err(|e| ExplorerError::io(path, e))?;
    Ok(target)
}

/// Sends to the Recycle Bin. Where there is none (network drives) Windows asks before deleting
/// for good instead of doing it silently (FOF_WANTNUKEWARNING).
#[cfg(windows)]
pub fn trash(paths: &[PathBuf]) -> Result<(), ExplorerError> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::UI::Shell::{
        FO_DELETE, FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_NOERRORUI, FOF_SILENT,
        FOF_WANTNUKEWARNING, SHFILEOPSTRUCTW, SHFileOperationW,
    };

    if paths.is_empty() {
        return Ok(());
    }
    // pFrom: absolute paths separated by NUL, ending in a double NUL.
    let mut from: Vec<u16> = Vec::new();
    for path in paths {
        if !path.is_absolute() {
            return Err(ExplorerError::Invalid(format!(
                "ruta no absoluta: {}",
                path.display()
            )));
        }
        from.extend(path.as_os_str().encode_wide());
        from.push(0);
    }
    from.push(0);
    let mut op = SHFILEOPSTRUCTW {
        hwnd: std::ptr::null_mut(),
        wFunc: FO_DELETE,
        pFrom: from.as_ptr(),
        pTo: std::ptr::null(),
        fFlags: (FOF_ALLOWUNDO
            | FOF_NOCONFIRMATION
            | FOF_SILENT
            | FOF_NOERRORUI
            | FOF_WANTNUKEWARNING) as _,
        fAnyOperationsAborted: 0,
        hNameMappings: std::ptr::null_mut(),
        lpszProgressTitle: std::ptr::null(),
    };
    // SAFETY: `op` is fully initialized and `from` outlives the call.
    let code = unsafe { SHFileOperationW(&mut op) };
    if code != 0 {
        return Err(ExplorerError::Unavailable(format!(
            "no se pudo mover a la papelera (código {code:#x})"
        )));
    }
    if op.fAnyOperationsAborted != 0 {
        return Err(ExplorerError::Unavailable("operación cancelada".to_owned()));
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn trash(_paths: &[PathBuf]) -> Result<(), ExplorerError> {
    Err(ExplorerError::Unavailable("solo en Windows".to_owned()))
}

/// `code <path>`: VS Code's launcher from the PATH or its usual install folders.
pub fn open_in_vscode(path: &Path) -> Result<(), ExplorerError> {
    let code = crate::pty::find_on_path("code.cmd")
        .or_else(|| {
            [
                ("LOCALAPPDATA", r"Programs\Microsoft VS Code\bin\code.cmd"),
                ("ProgramFiles", r"Microsoft VS Code\bin\code.cmd"),
            ]
            .into_iter()
            .filter_map(|(var, rel)| std::env::var_os(var).map(|dir| PathBuf::from(dir).join(rel)))
            .find(|candidate| candidate.is_file())
        })
        .ok_or_else(|| ExplorerError::Unavailable("VS Code no está en el PATH".to_owned()))?;
    let mut command = Command::new(code);
    command.arg(path);
    detached(command)
}

/// The folder in Windows' file manager; a file is shown selected in its folder.
pub fn open_in_file_manager(path: &Path) -> Result<(), ExplorerError> {
    let mut command = Command::new("explorer.exe");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // explorer parses its own command line: `/select,"C:\a b\c.txt"` must arrive verbatim
        // (paths cannot contain quotes, so this is safe).
        let path = path.display();
        if fs::metadata(path.to_string()).is_ok_and(|meta| meta.is_dir()) {
            command.raw_arg(format!("\"{path}\""));
        } else {
            command.raw_arg(format!("/select,\"{path}\""));
        }
    }
    #[cfg(not(windows))]
    command.arg(path);
    detached(command)
}

/// Starts a GUI program that outlives the terminal: no console window, no waiting.
fn detached(mut command: Command) -> Result<(), ExplorerError> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map(drop)
        .map_err(|e| ExplorerError::Unavailable(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names() {
        for ok in [
            "a.txt",
            "Ñandú áé.md",
            ".gitignore",
            "con espacios",
            "CONSOLA",
            "COM10",
        ] {
            assert!(validate_name(ok).is_ok(), "{ok}");
        }
        for bad in [
            "",
            "  ",
            ".",
            "..",
            "a/b",
            "a\\b",
            "x:y",
            "q?",
            "t*",
            "fin.",
            "fin ",
            "CON",
            "nul.txt",
            "com1",
            "LPT9.log",
            "tab\tname",
        ] {
            assert!(validate_name(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn create_and_rename() {
        let dir = std::env::temp_dir().join(format!("terminal-ops-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let file = create_entry(&dir, "nuevo archivo.txt", NewEntryKind::File).unwrap();
        assert!(file.is_file());
        assert!(
            create_entry(&dir, "nuevo archivo.txt", NewEntryKind::File).is_err(),
            "never overwrites"
        );
        let sub = create_entry(&dir, "Carpeta ñ", NewEntryKind::Dir).unwrap();
        assert!(sub.is_dir());
        assert!(
            rename_entry(&file, "Carpeta ñ").is_err(),
            "target exists: refused"
        );
        let renamed = rename_entry(&file, "otro nombre.md").unwrap();
        assert!(renamed.is_file() && !file.exists());
        let upper = rename_entry(&renamed, "OTRO NOMBRE.md").unwrap();
        assert!(upper.ends_with("OTRO NOMBRE.md"), "case-only rename");
        fs::remove_dir_all(&dir).ok();
    }
}
