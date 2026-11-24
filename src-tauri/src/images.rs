//! Images pasted or dropped on a terminal, saved as files so a program (an AI agent) can take
//! them by path: a temporary folder of Brisa, emptied of files older than a few hours. No Tauri:
//! tested on its own.

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Bigger than any screenshot; protects the disk from a runaway drop.
pub const MAX_IMAGE_BYTES: usize = 64 * 1024 * 1024;
/// "A few hours": long enough for the agent to read it (some read the file when the message is
/// sent, not when it is pasted).
pub const KEEP_FOR: Duration = Duration::from_secs(6 * 60 * 60);

const PREFIX: &str = "brisa-";
const PNG_MAGIC: &[u8] = b"\x89PNG\r\n\x1a\n";

#[derive(Debug, thiserror::Error)]
pub enum ImageError {
    #[error("no es una imagen PNG")]
    NotPng,
    #[error("la imagen pesa más de {} MB", MAX_IMAGE_BYTES / 1024 / 1024)]
    TooLarge,
    #[error("la imagen adjunta pesa más de {} MB", MAX_ATTACHMENT_BYTES / 1024 / 1024)]
    AttachmentTooLarge,
    #[error("la imagen adjunta no es una de las que guardó Brisa")]
    NotOurs,
    #[error("no se pudo guardar la imagen: {0}")]
    Io(#[from] io::Error),
}

/// An image attached to a message for an agent (the orchestrator): the Messages API takes up to
/// 5 MB per image (the page already scales screenshots down to 1568 px).
pub const MAX_ATTACHMENT_BYTES: usize = 5 * 1024 * 1024;

/// Where the images go: `%TEMP%\brisa-images`.
pub fn images_dir() -> PathBuf {
    std::env::temp_dir().join("brisa-images")
}

/// Saves a PNG with a new name (never overwrites) and returns its path. Old images go first.
pub fn save_png(dir: &Path, bytes: &[u8]) -> Result<PathBuf, ImageError> {
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err(ImageError::TooLarge);
    }
    if !bytes.starts_with(PNG_MAGIC) {
        return Err(ImageError::NotPng);
    }
    fs::create_dir_all(dir)?;
    let _ = remove_old(dir, KEEP_FOR, SystemTime::now());
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or_default();
    for n in 0..1000 {
        let name = if n == 0 {
            format!("{PREFIX}{stamp}.png")
        } else {
            format!("{PREFIX}{stamp}-{n}.png")
        };
        let path = dir.join(name);
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(mut file) => {
                if let Err(error) = file.write_all(bytes) {
                    drop(file);
                    let _ = fs::remove_file(&path);
                    return Err(error.into());
                }
                return Ok(path);
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.into()),
        }
    }
    Err(io::Error::other("no hay un nombre libre").into())
}

/// Removes Brisa's images older than `keep` (only ours: `brisa-*.png`). Returns how many.
pub fn remove_old(dir: &Path, keep: Duration, now: SystemTime) -> io::Result<usize> {
    let mut removed = 0;
    for entry in fs::read_dir(dir)? {
        let Ok(entry) = entry else { continue };
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.starts_with(PREFIX) || !name.ends_with(".png") {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        let Ok(modified) = meta.modified() else {
            continue;
        };
        let old = now.duration_since(modified).is_ok_and(|age| age >= keep);
        if meta.is_file() && old && fs::remove_file(entry.path()).is_ok() {
            removed += 1;
        }
    }
    Ok(removed)
}

/// Reads an image attached to a message: only a PNG that Brisa saved in `dir` (a pasted
/// image), never any other file the page could name.
pub fn read_attachment(dir: &Path, path: &Path) -> Result<Vec<u8>, ImageError> {
    let file = fs::canonicalize(path)?;
    let ours = fs::canonicalize(dir)?;
    let name = file
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    if file.parent() != Some(ours.as_path()) || !name.starts_with(PREFIX) || !name.ends_with(".png")
    {
        return Err(ImageError::NotOurs);
    }
    if fs::metadata(&file)?.len() > MAX_ATTACHMENT_BYTES as u64 {
        return Err(ImageError::AttachmentTooLarge);
    }
    let bytes = fs::read(&file)?;
    if !bytes.starts_with(PNG_MAGIC) {
        return Err(ImageError::NotPng);
    }
    Ok(bytes)
}

/// Standard base64 with padding (an image inside a JSON message). No crate for 20 lines.
pub fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            chunk.get(1).copied().unwrap_or(0),
            chunk.get(2).copied().unwrap_or(0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(char::from(ALPHABET[((n >> (18 - 6 * i)) & 63) as usize]));
            } else {
                out.push('=');
            }
        }
    }
    out
}

/// The image format of `bytes` by its signature (what a drop is checked against).
pub fn image_kind(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(PNG_MAGIC) {
        Some("png")
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("gif")
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("webp")
    } else if bytes.len() >= 26 && bytes.starts_with(b"BM") {
        Some("bmp")
    } else {
        None
    }
}

/// A clipboard / drag DIB (`CF_DIB`, `CF_DIBV5`: the bitmap without its file header) as a
/// `.bmp` file, which the page can decode and turn into a PNG.
pub fn dib_to_bmp(dib: &[u8]) -> Option<Vec<u8>> {
    let u32_at = |at: usize| {
        dib.get(at..at + 4)
            .map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    };
    let header = u32_at(0)? as usize;
    if !(header == 12 || header >= 40) || dib.len() <= header {
        return None;
    }
    let (bit_count, compression, colors_used) = if header == 12 {
        // BITMAPCOREHEADER: 3-byte palette entries.
        let bits = u16::from_le_bytes([*dib.get(10)?, *dib.get(11)?]);
        (bits, 0, 0)
    } else {
        let bits = u16::from_le_bytes([*dib.get(14)?, *dib.get(15)?]);
        (bits, u32_at(16)?, u32_at(32)?)
    };
    // BI_BITFIELDS / BI_ALPHABITFIELDS: the masks follow a plain BITMAPINFOHEADER (the bigger
    // headers carry them inside).
    let masks = match (header, compression) {
        (40, 3) => 12,
        (40, 6) => 16,
        _ => 0,
    };
    let entry = if header == 12 { 3 } else { 4 };
    let palette = if colors_used > 0 {
        colors_used as usize * entry
    } else if bit_count <= 8 {
        (1usize << bit_count) * entry
    } else {
        0
    };
    let offset = 14 + header + masks + palette;
    let size = 14 + dib.len();
    if offset > size {
        return None;
    }
    let mut bmp = Vec::with_capacity(size);
    bmp.extend_from_slice(b"BM");
    bmp.extend_from_slice(&u32::try_from(size).ok()?.to_le_bytes());
    bmp.extend_from_slice(&[0, 0, 0, 0]);
    bmp.extend_from_slice(&u32::try_from(offset).ok()?.to_le_bytes());
    bmp.extend_from_slice(dib);
    Some(bmp)
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR";

    fn temp(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("brisa-images-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn base64_matches_the_standard_alphabet_and_padding() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
        assert_eq!(base64(&[0xff, 0xfe, 0xfd, 0x00]), "//79AA==");
        assert_eq!(base64(PNG), "iVBORw0KGgoAAAANSUhEUg==");
    }

    #[test]
    fn only_our_saved_pngs_can_be_attached() {
        let dir = temp("attach");
        let saved = save_png(&dir, PNG).unwrap();
        assert_eq!(read_attachment(&dir, &saved).unwrap(), PNG);
        // Another file of the same folder, a PNG elsewhere, a file that is not there.
        let other = dir.join("notas.png");
        fs::write(&other, PNG).unwrap();
        assert!(matches!(
            read_attachment(&dir, &other),
            Err(ImageError::NotOurs)
        ));
        let outside = temp("attach-outside");
        fs::create_dir_all(&outside).unwrap();
        let elsewhere = outside.join("brisa-1.png");
        fs::write(&elsewhere, PNG).unwrap();
        assert!(matches!(
            read_attachment(&dir, &elsewhere),
            Err(ImageError::NotOurs)
        ));
        assert!(read_attachment(&dir, &dir.join("brisa-0.png")).is_err());
        // Renamed to look like ours but not a PNG.
        let fake = dir.join("brisa-9.png");
        fs::write(&fake, b"GIF89a").unwrap();
        assert!(matches!(
            read_attachment(&dir, &fake),
            Err(ImageError::NotPng)
        ));
        let big = dir.join("brisa-big.png");
        let mut bytes = PNG.to_vec();
        bytes.resize(MAX_ATTACHMENT_BYTES + 1, 0);
        fs::write(&big, bytes).unwrap();
        assert!(matches!(
            read_attachment(&dir, &big),
            Err(ImageError::AttachmentTooLarge)
        ));
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&outside);
    }

    #[test]
    fn a_png_is_saved_with_a_new_name_each_time() {
        let dir = temp("save");
        let a = save_png(&dir, PNG).unwrap();
        let b = save_png(&dir, PNG).unwrap();
        assert_ne!(a, b);
        assert_eq!(fs::read(&a).unwrap(), PNG);
        assert!(
            a.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("brisa-")
        );
        assert_eq!(a.extension().unwrap(), "png");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn only_pngs_of_a_sane_size_are_saved() {
        let dir = temp("reject");
        assert!(matches!(
            save_png(&dir, b"GIF89a...."),
            Err(ImageError::NotPng)
        ));
        let mut huge = PNG.to_vec();
        huge.resize(MAX_IMAGE_BYTES + 1, 0);
        assert!(matches!(save_png(&dir, &huge), Err(ImageError::TooLarge)));
        assert!(!dir.exists());
    }

    #[test]
    fn old_images_are_removed_and_nothing_else() {
        let dir = temp("old");
        let recent = save_png(&dir, PNG).unwrap();
        let old = save_png(&dir, PNG).unwrap();
        let foreign = dir.join("notes.png");
        fs::write(&foreign, PNG).unwrap();
        let hours_ago = SystemTime::now() - Duration::from_secs(7 * 60 * 60);
        fs::File::options()
            .write(true)
            .open(&old)
            .unwrap()
            .set_modified(hours_ago)
            .unwrap();
        fs::File::options()
            .write(true)
            .open(&foreign)
            .unwrap()
            .set_modified(hours_ago)
            .unwrap();
        assert_eq!(remove_old(&dir, KEEP_FOR, SystemTime::now()).unwrap(), 1);
        assert!(recent.exists() && !old.exists() && foreign.exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn image_formats_by_signature() {
        assert_eq!(image_kind(PNG), Some("png"));
        assert_eq!(image_kind(&[0xFF, 0xD8, 0xFF, 0xE0]), Some("jpeg"));
        assert_eq!(image_kind(b"GIF89a"), Some("gif"));
        assert_eq!(image_kind(b"RIFF\0\0\0\0WEBPVP8 "), Some("webp"));
        assert_eq!(
            image_kind(b"[InternetShortcut]\r\nURL=https://example.com"),
            None
        );
        assert_eq!(image_kind(b""), None);
    }

    fn info_header(width: i32, height: i32, bits: u16, compression: u32, colors: u32) -> Vec<u8> {
        let mut h = Vec::new();
        h.extend_from_slice(&40u32.to_le_bytes());
        h.extend_from_slice(&width.to_le_bytes());
        h.extend_from_slice(&height.to_le_bytes());
        h.extend_from_slice(&1u16.to_le_bytes());
        h.extend_from_slice(&bits.to_le_bytes());
        h.extend_from_slice(&compression.to_le_bytes());
        h.extend_from_slice(&[0; 12]);
        h.extend_from_slice(&colors.to_le_bytes());
        h.extend_from_slice(&0u32.to_le_bytes());
        h
    }

    fn offset(bmp: &[u8]) -> u32 {
        u32::from_le_bytes([bmp[10], bmp[11], bmp[12], bmp[13]])
    }

    #[test]
    fn a_dib_becomes_a_bmp_with_the_pixels_where_the_header_says() {
        // 2×2, 32 bits, BI_RGB: pixels right after the header.
        let mut dib = info_header(2, 2, 32, 0, 0);
        dib.extend_from_slice(&[0xAA; 16]);
        let bmp = dib_to_bmp(&dib).unwrap();
        assert_eq!(&bmp[..2], b"BM");
        assert_eq!(
            u32::from_le_bytes([bmp[2], bmp[3], bmp[4], bmp[5]]) as usize,
            bmp.len()
        );
        assert_eq!(offset(&bmp), 14 + 40);
        assert_eq!(image_kind(&bmp), Some("bmp"));
        // BI_BITFIELDS after a plain header: three masks first.
        let mut dib = info_header(1, 1, 32, 3, 0);
        dib.extend_from_slice(&[0; 12 + 4]);
        assert_eq!(offset(&dib_to_bmp(&dib).unwrap()), 14 + 40 + 12);
        // 8 bits: a 256-color palette (or the number of colors used).
        let mut dib = info_header(1, 1, 8, 0, 0);
        dib.extend_from_slice(&vec![0; 256 * 4 + 4]);
        assert_eq!(offset(&dib_to_bmp(&dib).unwrap()), 14 + 40 + 1024);
        let mut dib = info_header(1, 1, 8, 0, 2);
        dib.extend_from_slice(&[0; 2 * 4 + 4]);
        assert_eq!(offset(&dib_to_bmp(&dib).unwrap()), 14 + 40 + 8);
        // Garbage is not a bitmap.
        assert!(dib_to_bmp(b"hello").is_none());
        assert!(dib_to_bmp(&info_header(1, 1, 8, 0, 0)).is_none());
    }
}
