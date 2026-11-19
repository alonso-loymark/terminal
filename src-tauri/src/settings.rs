//! The settings file on disk. The frontend owns its schema and validation (TypeScript); the
//! backend only finds, reads and writes the file, and peeks at the window effect, which has to
//! be known before the window exists.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub const SETTINGS_FILE: &str = "settings.json";
pub const SCHEMA_FILE: &str = "settings.schema.json";
/// Overrides the config folder (end-to-end tests run against a throwaway one).
pub const CONFIG_DIR_VAR: &str = "TERMINAL_CONFIG_DIR";
/// Theme files dropped on the settings screen: anything bigger is not a theme.
pub const MAX_THEME_FILE: u64 = 1024 * 1024;

/// The folder holding settings.json: `TERMINAL_CONFIG_DIR`, else the app's config folder
/// (`%APPDATA%\<identifier>`).
pub fn config_dir(app_config_dir: Option<PathBuf>) -> Option<PathBuf> {
    std::env::var_os(CONFIG_DIR_VAR)
        .filter(|dir| !dir.is_empty())
        .map(PathBuf::from)
        .or(app_config_dir)
}

/// The file's text, or None if it does not exist yet.
pub fn read(path: &Path) -> io::Result<Option<String>> {
    match fs::read(path) {
        Ok(bytes) => {
            // Notepad and others may save UTF-8 with a BOM.
            let text = String::from_utf8_lossy(&bytes);
            Ok(Some(text.trim_start_matches('\u{feff}').to_owned()))
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

/// Replaces the file in one step (temporary file + rename): an editor or the watcher never sees
/// it half written, and a crash leaves the old version.
pub fn write(path: &Path, text: &str) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let mut temp = path.as_os_str().to_owned();
    temp.push(".tmp");
    let temp = PathBuf::from(temp);
    fs::write(&temp, text)?;
    fs::rename(&temp, path).inspect_err(|_| {
        let _ = fs::remove_file(&temp);
    })
}

/// Writes only if the content differs (the schema is rewritten at every start otherwise).
pub fn write_if_changed(path: &Path, text: &str) -> io::Result<bool> {
    if read(path)?.as_deref() == Some(text) {
        return Ok(false);
    }
    write(path, text).map(|()| true)
}

/// A theme file (JSON) dropped on the settings screen.
pub fn read_theme_file(path: &Path) -> io::Result<String> {
    let meta = fs::metadata(path)?;
    if !meta.is_file() || meta.len() > MAX_THEME_FILE {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "no es un archivo de tema (máximo 1 MB)",
        ));
    }
    read(path)?.ok_or_else(|| io::ErrorKind::NotFound.into())
}

/// Windows backdrop behind the (translucent) window.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Backdrop {
    #[default]
    None,
    Mica,
    Acrylic,
}

/// What the window needs at creation. Transparency cannot be switched on later, so it is read
/// from the file before the window exists; an opaque window (the default) costs nothing extra.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct WindowLook {
    pub transparent: bool,
    pub backdrop: Backdrop,
}

/// `appearance.backdrop` and `appearance.opacity` from the settings text. Anything unreadable
/// means the default (opaque): the frontend reports the error.
pub fn window_look(text: Option<&str>) -> WindowLook {
    let Some(value) =
        text.and_then(|t| serde_json::from_str::<serde_json::Value>(&strip_jsonc(t)).ok())
    else {
        return WindowLook::default();
    };
    let appearance = value.get("appearance");
    let backdrop = appearance
        .and_then(|a| a.get("backdrop"))
        .and_then(|b| serde_json::from_value::<Backdrop>(b.clone()).ok())
        .unwrap_or_default();
    let opacity = appearance
        .and_then(|a| a.get("opacity"))
        .and_then(serde_json::Value::as_f64)
        .unwrap_or(100.0);
    WindowLook {
        transparent: backdrop != Backdrop::None || opacity < 100.0,
        backdrop,
    }
}

/// JSON with comments (`//`, `/* */`) and trailing commas → plain JSON, as the settings file
/// allows both (like VS Code's and Windows Terminal's).
pub fn strip_jsonc(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    let mut in_string = false;
    while let Some(c) = chars.next() {
        if in_string {
            out.push(c);
            match c {
                '\\' => {
                    if let Some(next) = chars.next() {
                        out.push(next);
                    }
                }
                '"' => in_string = false,
                _ => {}
            }
            continue;
        }
        match c {
            '"' => {
                in_string = true;
                out.push(c);
            }
            '/' if chars.peek() == Some(&'/') => {
                for next in chars.by_ref() {
                    if next == '\n' {
                        out.push('\n');
                        break;
                    }
                }
            }
            '/' if chars.peek() == Some(&'*') => {
                chars.next();
                let mut last = ' ';
                for next in chars.by_ref() {
                    if last == '*' && next == '/' {
                        break;
                    }
                    last = next;
                }
                out.push(' ');
            }
            '}' | ']' => {
                // A comma right before the closing bracket (spaces aside) is dropped.
                let trimmed = out.trim_end_matches(char::is_whitespace).len();
                if out[..trimmed].ends_with(',') {
                    out.truncate(trimmed - 1);
                }
                out.push(c);
            }
            _ => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn comments_and_trailing_commas_are_accepted() {
        let text = r#"{
  // comentario
  "a": "http://no-es-comentario", /* bloque */
  "b": [1, 2,],
  "c": "coma, y llave } adentro \" y comilla",
}"#;
        let value: serde_json::Value = serde_json::from_str(&strip_jsonc(text)).unwrap();
        assert_eq!(value["a"], "http://no-es-comentario");
        assert_eq!(value["b"], serde_json::json!([1, 2]));
        assert_eq!(value["c"], "coma, y llave } adentro \" y comilla");
    }

    #[test]
    fn the_window_is_transparent_only_when_asked() {
        assert_eq!(window_look(None), WindowLook::default());
        assert_eq!(window_look(Some("{ roto")), WindowLook::default());
        assert!(!window_look(Some(r#"{"appearance": {"fontSize": 14}}"#)).transparent);
        let mica = window_look(Some(
            "{ \"appearance\": { \"backdrop\": \"mica\", } // efecto\n}",
        ));
        assert_eq!(
            mica,
            WindowLook {
                transparent: true,
                backdrop: Backdrop::Mica
            }
        );
        let translucent = window_look(Some(r#"{"appearance": {"opacity": 85}}"#));
        assert!(translucent.transparent && translucent.backdrop == Backdrop::None);
        // An unknown effect is the frontend's error to report; the window stays opaque.
        assert!(!window_look(Some(r#"{"appearance": {"backdrop": "glass"}}"#)).transparent);
    }

    #[test]
    fn writes_are_atomic_and_skip_identical_content() {
        let dir = std::env::temp_dir().join(format!("terminal-settings-{}", std::process::id()));
        let path = dir.join("sub").join(SETTINGS_FILE);
        assert_eq!(read(&path).unwrap(), None);
        write(&path, "{\"a\": 1}").unwrap();
        assert_eq!(read(&path).unwrap().as_deref(), Some("{\"a\": 1}"));
        assert!(!write_if_changed(&path, "{\"a\": 1}").unwrap());
        assert!(write_if_changed(&path, "{\"a\": 2}").unwrap());
        assert!(!dir.join("sub").join("settings.json.tmp").exists());
        // A BOM (Notepad) is not part of the text.
        fs::write(&path, "\u{feff}{}").unwrap();
        assert_eq!(read(&path).unwrap().as_deref(), Some("{}"));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn theme_files_are_size_limited() {
        let dir = std::env::temp_dir().join(format!("terminal-theme-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let small = dir.join("tema.json");
        fs::write(&small, r##"{"name": "x", "background": "#000000"}"##).unwrap();
        assert!(read_theme_file(&small).unwrap().contains("background"));
        let big = dir.join("grande.json");
        fs::write(&big, vec![b' '; (MAX_THEME_FILE + 1) as usize]).unwrap();
        assert!(read_theme_file(&big).is_err());
        assert!(read_theme_file(&dir).is_err());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_config_dir_can_be_overridden() {
        // Only checks the fallback: setting the variable would race with other tests.
        if std::env::var_os(CONFIG_DIR_VAR).is_none() {
            assert_eq!(
                config_dir(Some(PathBuf::from(r"C:\cfg"))),
                Some(PathBuf::from(r"C:\cfg"))
            );
        }
    }
}
