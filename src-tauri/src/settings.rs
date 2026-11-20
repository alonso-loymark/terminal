//! The app's files on disk (settings.json, the session, saved layouts). The frontend owns their
//! schemas and validation (TypeScript); the backend only finds, reads and writes them, moves the
//! folder of the app's old name, and peeks at the window effect, which has to be known before
//! the window exists.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub const SETTINGS_FILE: &str = "settings.json";
pub const SCHEMA_FILE: &str = "settings.schema.json";
/// Overrides the config folder (end-to-end tests run against a throwaway one).
pub const CONFIG_DIR_VAR: &str = "BRISA_CONFIG_DIR";
/// The config folder of the app's first name ("Terminal"), next to the current one.
pub const LEGACY_CONFIG_DIR: &str = "dev.terminal.desktop";
/// Theme files dropped on the settings screen: anything bigger is not a theme.
pub const MAX_THEME_FILE: u64 = 1024 * 1024;

/// The files the frontend reads and writes in the config folder.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConfigFile {
    Settings,
    SettingsSchema,
    /// Tabs, groups and panes of the last session (written by the app).
    Session,
    /// Saved layouts (JSON with comments, editable by hand).
    Layouts,
    LayoutsSchema,
}

impl ConfigFile {
    pub fn name(self) -> &'static str {
        match self {
            Self::Settings => SETTINGS_FILE,
            Self::SettingsSchema => SCHEMA_FILE,
            Self::Session => "session.json",
            Self::Layouts => "layouts.json",
            Self::LayoutsSchema => "layouts.schema.json",
        }
    }

    /// The files a user opens in an editor.
    pub fn editable(self) -> bool {
        matches!(self, Self::Settings | Self::Layouts)
    }
}

/// The config folder: `BRISA_CONFIG_DIR`, else the app's config folder
/// (`%APPDATA%\<identifier>`), where the files of the app's old name are moved the first time
/// (see [`migrate_legacy`]).
pub fn config_dir(app_config_dir: Option<PathBuf>) -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os(CONFIG_DIR_VAR).filter(|dir| !dir.is_empty()) {
        return Some(PathBuf::from(dir));
    }
    let dir = app_config_dir?;
    if let Some(legacy) = dir.parent().map(|parent| parent.join(LEGACY_CONFIG_DIR))
        && let Err(error) = migrate_legacy(&legacy, &dir)
    {
        eprintln!("[brisa] no se pudo migrar {}: {error}", legacy.display());
    }
    Some(dir)
}

/// Brings the config folder of the app's old name to the new one: settings.json (custom themes
/// included) and anything else in it. Only when the old folder exists and the new one has no
/// settings yet. Moved in one step when possible; otherwise (the old folder is in use, or the
/// new one already exists) copied file by file, never overwriting, leaving the old one alone.
/// Returns whether anything was brought over.
pub fn migrate_legacy(legacy: &Path, dir: &Path) -> io::Result<bool> {
    if !legacy.is_dir() || dir.join(SETTINGS_FILE).exists() {
        return Ok(false);
    }
    if !dir.exists() {
        if let Some(parent) = dir.parent() {
            fs::create_dir_all(parent)?;
        }
        if fs::rename(legacy, dir).is_ok() {
            return Ok(true);
        }
    }
    copy_missing(legacy, dir)?;
    Ok(true)
}

fn copy_missing(from: &Path, to: &Path) -> io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_missing(&entry.path(), &target)?;
        } else if !target.exists() {
            fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
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
    /// `appearance.titleBar: "native"`: Windows' own title bar instead of the tabs in it.
    pub native_title_bar: bool,
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
    let native_title_bar = appearance
        .and_then(|a| a.get("titleBar"))
        .and_then(serde_json::Value::as_str)
        == Some("native");
    WindowLook {
        transparent: backdrop != Backdrop::None || opacity < 100.0,
        backdrop,
        native_title_bar,
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
                backdrop: Backdrop::Mica,
                native_title_bar: false,
            }
        );
        let translucent = window_look(Some(r#"{"appearance": {"opacity": 85}}"#));
        assert!(translucent.transparent && translucent.backdrop == Backdrop::None);
        // An unknown effect is the frontend's error to report; the window stays opaque.
        assert!(!window_look(Some(r#"{"appearance": {"backdrop": "glass"}}"#)).transparent);
    }

    #[test]
    fn the_title_bar_is_ours_unless_native_is_asked() {
        assert!(!window_look(None).native_title_bar);
        assert!(!window_look(Some(r#"{"appearance": {"titleBar": "custom"}}"#)).native_title_bar);
        assert!(window_look(Some(r#"{"appearance": {"titleBar": "native"}}"#)).native_title_bar);
        assert!(!window_look(Some(r#"{"appearance": {"titleBar": 3}}"#)).native_title_bar);
    }

    #[test]
    fn writes_are_atomic_and_skip_identical_content() {
        let dir = std::env::temp_dir().join(format!("brisa-settings-{}", std::process::id()));
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
        let dir = std::env::temp_dir().join(format!("brisa-theme-{}", std::process::id()));
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
    fn the_old_config_folder_moves_to_the_new_name() {
        let base = std::env::temp_dir().join(format!("brisa-migrate-{}", std::process::id()));
        let legacy = base.join(LEGACY_CONFIG_DIR);
        let dir = base.join("dev.brisa.desktop");
        fs::create_dir_all(legacy.join("sub")).unwrap();
        let settings = "{\n  // mis temas\n  \"themes\": [{\"name\": \"Mío\"}]\n}\n";
        fs::write(legacy.join(SETTINGS_FILE), settings).unwrap();
        fs::write(legacy.join("sub").join("x.txt"), "x").unwrap();
        assert!(migrate_legacy(&legacy, &dir).unwrap());
        assert_eq!(
            read(&dir.join(SETTINGS_FILE)).unwrap().as_deref(),
            Some(settings)
        );
        assert!(dir.join("sub").join("x.txt").exists());
        assert!(!legacy.exists(), "moved, not copied");
        // Once migrated (or with settings of its own) nothing else happens.
        fs::create_dir_all(&legacy).unwrap();
        fs::write(legacy.join(SETTINGS_FILE), "{\"viejo\": true}").unwrap();
        assert!(!migrate_legacy(&legacy, &dir).unwrap());
        assert_eq!(
            read(&dir.join(SETTINGS_FILE)).unwrap().as_deref(),
            Some(settings)
        );
        // No old folder: nothing to do.
        assert!(!migrate_legacy(&base.join("no-existe"), &base.join("otra")).unwrap());
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn an_existing_new_folder_gets_copies_without_overwriting() {
        let base = std::env::temp_dir().join(format!("brisa-migrate-copy-{}", std::process::id()));
        let legacy = base.join(LEGACY_CONFIG_DIR);
        let dir = base.join("dev.brisa.desktop");
        fs::create_dir_all(&legacy).unwrap();
        fs::create_dir_all(&dir).unwrap();
        fs::write(legacy.join(SETTINGS_FILE), "{\"a\": 1}").unwrap();
        fs::write(legacy.join("layouts.json"), "{\"viejo\": 1}").unwrap();
        fs::write(dir.join("layouts.json"), "{\"nuevo\": 1}").unwrap();
        assert!(migrate_legacy(&legacy, &dir).unwrap());
        assert_eq!(
            read(&dir.join(SETTINGS_FILE)).unwrap().as_deref(),
            Some("{\"a\": 1}")
        );
        assert_eq!(
            read(&dir.join("layouts.json")).unwrap().as_deref(),
            Some("{\"nuevo\": 1}")
        );
        assert!(
            legacy.join(SETTINGS_FILE).exists(),
            "the old folder is left alone"
        );
        fs::remove_dir_all(&base).ok();
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
