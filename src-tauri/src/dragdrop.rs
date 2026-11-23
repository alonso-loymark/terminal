//! Drops from other apps (Windows OLE drag & drop) on the page. Replaces wry's handler on the
//! WebView2 windows, which only takes files: a browser drags an image as a "virtual file"
//! (`FileGroupDescriptorW` + `FileContents`: bytes, no path) and other apps drag a bitmap
//! ("PNG", `CF_DIBV5`, `CF_DIB`); wry turns those down. Files still arrive as paths (CF_HDROP,
//! or the shell item array for paths longer than MAX_PATH, as in wry).
//!
//! wry stays enabled on purpose: it tells WebView2 not to take external drops
//! (`AllowExternalDrop(false)`, otherwise a drop could navigate the page) and registers its
//! targets when the webview is created; `register` replaces them once the page listens.

use std::path::PathBuf;

use crate::images::{self, MAX_IMAGE_BYTES};

/// What was dropped.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Dropped {
    Files(Vec<PathBuf>),
    /// An image that is not a file: its bytes (PNG, JPEG, GIF, WebP or BMP) and a name.
    Image {
        bytes: Vec<u8>,
        name: String,
    },
}

/// A drag over the page, in physical pixels of the window's client area.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DropEvent {
    Over { x: i32, y: i32, image: bool },
    Leave,
    Drop { x: i32, y: i32, dropped: Dropped },
}

/// The data formats an image can come in (also what the e2e feeds `debug_drop`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageSource {
    /// A virtual file's contents (a browser's dragged image): any image format.
    File,
    /// The registered "PNG" format.
    Png,
    /// `CF_DIB` / `CF_DIBV5`: a bitmap without its file header.
    Dib,
}

/// The dropped image from one of its formats, checked by signature (a dragged link is a virtual
/// `.url` file: not an image).
pub fn image_from(source: ImageSource, bytes: Vec<u8>, name: &str) -> Option<Dropped> {
    if bytes.len() > MAX_IMAGE_BYTES {
        return None;
    }
    let bytes = match source {
        ImageSource::File => bytes,
        ImageSource::Png => bytes,
        ImageSource::Dib => images::dib_to_bmp(&bytes)?,
    };
    let kind = images::image_kind(&bytes)?;
    if source == ImageSource::Png && kind != "png" {
        return None;
    }
    let name = if name.is_empty() {
        format!("imagen.{kind}")
    } else {
        name.to_owned()
    };
    Some(Dropped::Image { bytes, name })
}

/// One entry of a `FILEGROUPDESCRIPTORW`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VirtualFile {
    pub name: String,
    pub size: Option<u64>,
}

const DESCRIPTOR_SIZE: usize = 592;
const FD_FILESIZE: u32 = 0x40;
const FILE_ATTRIBUTE_DIRECTORY: u32 = 0x10;

/// Parses a `FILEGROUPDESCRIPTORW` (a count, then 592-byte `FILEDESCRIPTORW`s: flags at 0,
/// attributes at 36, size high/low at 64/68, a 260-WCHAR name at 72). Folders are skipped.
pub fn parse_file_group(bytes: &[u8]) -> Vec<VirtualFile> {
    let u32_at = |at: usize| {
        bytes
            .get(at..at + 4)
            .map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    };
    let Some(count) = u32_at(0) else {
        return Vec::new();
    };
    let mut files = Vec::new();
    for i in 0..count.min(1024) as usize {
        let base = 4 + i * DESCRIPTOR_SIZE;
        let Some(raw) = bytes.get(base..base + DESCRIPTOR_SIZE) else {
            break;
        };
        let flags = u32_at(base).unwrap_or(0);
        let attributes = u32_at(base + 36).unwrap_or(0);
        if attributes & FILE_ATTRIBUTE_DIRECTORY != 0 {
            continue;
        }
        let wide: Vec<u16> = raw[72..]
            .as_chunks::<2>()
            .0
            .iter()
            .map(|&c| u16::from_le_bytes(c))
            .take_while(|&c| c != 0)
            .collect();
        let size = (flags & FD_FILESIZE != 0).then(|| {
            (u64::from(u32_at(base + 64).unwrap_or(0)) << 32)
                | u64::from(u32_at(base + 68).unwrap_or(0))
        });
        files.push(VirtualFile {
            name: String::from_utf16_lossy(&wide),
            size,
        });
    }
    files
}

/// A name that looks like an image (the contents are checked anyway).
pub fn is_image_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]
        .iter()
        .any(|ext| lower.ends_with(ext))
}

#[cfg(windows)]
pub use win::{has_image, read_image, read_paths, register};

#[cfg(windows)]
mod win {
    use std::cell::Cell;
    use std::ffi::{OsString, c_void};
    use std::os::windows::ffi::OsStringExt;
    use std::path::PathBuf;
    use std::rc::Rc;

    use windows::Win32::Foundation::{
        DRAGDROP_E_INVALIDHWND, HGLOBAL, HWND, LPARAM, POINT, POINTL, S_OK,
    };
    use windows::Win32::Graphics::Gdi::ScreenToClient;
    use windows::Win32::System::Com::{
        CoTaskMemFree, DVASPECT_CONTENT, FORMATETC, IDataObject, IStream, STGMEDIUM,
        STREAM_SEEK_SET, TYMED_HGLOBAL, TYMED_ISTREAM,
    };
    use windows::Win32::System::DataExchange::RegisterClipboardFormatW;
    use windows::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};
    use windows::Win32::System::Ole::{
        CF_DIB, CF_DIBV5, CF_HDROP, DROPEFFECT, DROPEFFECT_COPY, DROPEFFECT_NONE, IDropTarget,
        IDropTarget_Impl, RegisterDragDrop, ReleaseStgMedium, RevokeDragDrop,
    };
    use windows::Win32::System::SystemServices::MODIFIERKEYS_FLAGS;
    use windows::Win32::UI::Shell::{
        DragQueryFileW, HDROP, IShellItemArray, SHCreateShellItemArrayFromDataObject,
        SIGDN_FILESYSPATH,
    };
    use windows::Win32::UI::WindowsAndMessaging::EnumChildWindows;
    use windows::core::{BOOL, Ref, implement, w};

    use super::{
        DropEvent, Dropped, ImageSource, MAX_IMAGE_BYTES, image_from, is_image_name,
        parse_file_group,
    };

    fn format(cf: u16, index: i32, tymed: u32) -> FORMATETC {
        FORMATETC {
            cfFormat: cf,
            ptd: std::ptr::null_mut(),
            dwAspect: DVASPECT_CONTENT.0,
            lindex: index,
            tymed,
        }
    }

    fn registered(name: windows::core::PCWSTR) -> u16 {
        // SAFETY: a static, NUL-terminated name.
        unsafe { RegisterClipboardFormatW(name) as u16 }
    }

    fn offers(data: &IDataObject, cf: u16) -> bool {
        // SAFETY: a valid FORMATETC for the call.
        unsafe { data.QueryGetData(&format(cf, -1, TYMED_HGLOBAL.0 as u32)) == S_OK }
    }

    /// The bytes of an HGLOBAL (at most `limit`).
    fn global_bytes(handle: HGLOBAL, limit: usize) -> Option<Vec<u8>> {
        // SAFETY: the handle comes from a medium we own until ReleaseStgMedium; locked while
        // copied.
        unsafe {
            let size = GlobalSize(handle);
            if size == 0 || size > limit {
                return None;
            }
            let ptr = GlobalLock(handle);
            if ptr.is_null() {
                return None;
            }
            let bytes = std::slice::from_raw_parts(ptr as *const u8, size).to_vec();
            let _ = GlobalUnlock(handle);
            Some(bytes)
        }
    }

    fn stream_bytes(stream: &IStream, limit: usize) -> Option<Vec<u8>> {
        let mut out = Vec::new();
        let mut chunk = vec![0u8; 64 * 1024];
        // SAFETY: reads into a buffer of the length passed.
        unsafe {
            let _ = stream.Seek(0, STREAM_SEEK_SET, None);
            loop {
                let mut read = 0u32;
                let result = stream.Read(
                    chunk.as_mut_ptr() as *mut c_void,
                    chunk.len() as u32,
                    Some(&mut read),
                );
                if result.is_err() {
                    return None;
                }
                if read == 0 {
                    break;
                }
                out.extend_from_slice(&chunk[..read as usize]);
                if out.len() > limit {
                    return None;
                }
            }
        }
        Some(out)
    }

    /// The bytes of format `cf` (item `index` for FileContents), from an HGLOBAL or a stream.
    fn data_bytes(data: &IDataObject, cf: u16, index: i32) -> Option<Vec<u8>> {
        let tymed = TYMED_HGLOBAL.0 as u32 | TYMED_ISTREAM.0 as u32;
        // SAFETY: the medium is ours until released below; its union member matches `tymed`.
        unsafe {
            let mut medium: STGMEDIUM = data.GetData(&format(cf, index, tymed)).ok()?;
            let bytes = if medium.tymed == TYMED_HGLOBAL.0 as u32 {
                global_bytes(medium.u.hGlobal, MAX_IMAGE_BYTES)
            } else if medium.tymed == TYMED_ISTREAM.0 as u32 {
                (*medium.u.pstm)
                    .as_ref()
                    .and_then(|s| stream_bytes(s, MAX_IMAGE_BYTES))
            } else {
                None
            };
            ReleaseStgMedium(&mut medium);
            bytes
        }
    }

    /// Dropped file-system paths: CF_HDROP, or the shell item array (Explorer cannot build
    /// CF_HDROP for paths of MAX_PATH or more).
    pub fn read_paths(data: &IDataObject) -> Vec<PathBuf> {
        let mut paths = Vec::new();
        // SAFETY: the medium is released after reading; DragQueryFileW gets buffers of the
        // length it asked for.
        unsafe {
            if let Ok(mut medium) = data.GetData(&format(CF_HDROP.0, -1, TYMED_HGLOBAL.0 as u32)) {
                let drop = HDROP(medium.u.hGlobal.0);
                let count = DragQueryFileW(drop, u32::MAX, None);
                for i in 0..count {
                    let len = DragQueryFileW(drop, i, None) as usize;
                    let mut buf = vec![0u16; len + 1];
                    DragQueryFileW(drop, i, Some(&mut buf));
                    paths.push(OsString::from_wide(&buf[..len]).into());
                }
                ReleaseStgMedium(&mut medium);
                if !paths.is_empty() {
                    return paths;
                }
            }
            let Ok(items) = SHCreateShellItemArrayFromDataObject::<_, IShellItemArray>(data) else {
                return paths;
            };
            for i in 0..items.GetCount().unwrap_or(0) {
                let Ok(item) = items.GetItemAt(i) else {
                    continue;
                };
                // Fails for items with no file-system path (virtual files, devices).
                let Ok(name) = item.GetDisplayName(SIGDN_FILESYSPATH) else {
                    continue;
                };
                paths.push(OsString::from_wide(name.as_wide()).into());
                CoTaskMemFree(Some(name.0 as _));
            }
        }
        paths
    }

    fn virtual_image_index(data: &IDataObject) -> Option<(usize, super::VirtualFile)> {
        let group = data_bytes(data, registered(w!("FileGroupDescriptorW")), -1)?;
        parse_file_group(&group)
            .into_iter()
            .enumerate()
            .find(|(_, f)| is_image_name(&f.name))
    }

    /// Whether the drag carries an image that is not a file (cheap: no image bytes are read).
    pub fn has_image(data: &IDataObject) -> bool {
        virtual_image_index(data).is_some()
            || offers(data, registered(w!("PNG")))
            || offers(data, CF_DIBV5.0)
            || offers(data, CF_DIB.0)
    }

    /// The dropped image: a virtual file first (the original bytes), then "PNG", then a DIB.
    pub fn read_image(data: &IDataObject) -> Option<Dropped> {
        if let Some((index, file)) = virtual_image_index(data) {
            let contents = registered(w!("FileContents"));
            if let Some(mut bytes) = data_bytes(data, contents, index as i32) {
                // An HGLOBAL can be bigger than its contents.
                if let Some(size) = file.size.and_then(|s| usize::try_from(s).ok()) {
                    bytes.truncate(size);
                }
                if let Some(image) = image_from(ImageSource::File, bytes, &file.name) {
                    return Some(image);
                }
            }
        }
        if let Some(bytes) = data_bytes(data, registered(w!("PNG")), -1)
            && let Some(image) = image_from(ImageSource::Png, bytes, "")
        {
            return Some(image);
        }
        [CF_DIBV5.0, CF_DIB.0].into_iter().find_map(|cf| {
            data_bytes(data, cf, -1).and_then(|b| image_from(ImageSource::Dib, b, ""))
        })
    }

    #[derive(Clone, Copy, PartialEq, Eq)]
    enum Kind {
        None,
        Files,
        Image,
    }

    fn classify(data: &IDataObject) -> Kind {
        if !read_paths(data).is_empty() {
            Kind::Files
        } else if has_image(data) {
            Kind::Image
        } else {
            Kind::None
        }
    }

    #[implement(IDropTarget)]
    struct DropTarget {
        /// The top-level window: positions are relative to its client area (the page).
        top: HWND,
        sink: Rc<dyn Fn(DropEvent)>,
        kind: Cell<Kind>,
    }

    impl DropTarget {
        fn client(&self, pt: &POINTL) -> (i32, i32) {
            let mut point = POINT { x: pt.x, y: pt.y };
            // SAFETY: a valid window handle and point.
            let _ = unsafe { ScreenToClient(self.top, &mut point) };
            (point.x, point.y)
        }

        fn effect(&self, out: *mut DROPEFFECT) {
            if !out.is_null() {
                let effect = if self.kind.get() == Kind::None {
                    DROPEFFECT_NONE
                } else {
                    DROPEFFECT_COPY
                };
                // SAFETY: OLE passes a valid in/out pointer (checked for null).
                unsafe { *out = effect };
            }
        }
    }

    #[allow(non_snake_case)]
    impl IDropTarget_Impl for DropTarget_Impl {
        fn DragEnter(
            &self,
            data: Ref<'_, IDataObject>,
            _keys: MODIFIERKEYS_FLAGS,
            pt: &POINTL,
            effect: *mut DROPEFFECT,
        ) -> windows::core::Result<()> {
            let kind = data.as_ref().map_or(Kind::None, classify);
            self.kind.set(kind);
            self.effect(effect);
            if kind != Kind::None {
                let (x, y) = self.client(pt);
                (self.sink)(DropEvent::Over {
                    x,
                    y,
                    image: kind == Kind::Image,
                });
            }
            Ok(())
        }

        fn DragOver(
            &self,
            _keys: MODIFIERKEYS_FLAGS,
            pt: &POINTL,
            effect: *mut DROPEFFECT,
        ) -> windows::core::Result<()> {
            self.effect(effect);
            let kind = self.kind.get();
            if kind != Kind::None {
                let (x, y) = self.client(pt);
                (self.sink)(DropEvent::Over {
                    x,
                    y,
                    image: kind == Kind::Image,
                });
            }
            Ok(())
        }

        fn DragLeave(&self) -> windows::core::Result<()> {
            if self.kind.replace(Kind::None) != Kind::None {
                (self.sink)(DropEvent::Leave);
            }
            Ok(())
        }

        fn Drop(
            &self,
            data: Ref<'_, IDataObject>,
            _keys: MODIFIERKEYS_FLAGS,
            pt: &POINTL,
            effect: *mut DROPEFFECT,
        ) -> windows::core::Result<()> {
            let kind = self.kind.replace(Kind::None);
            let (x, y) = self.client(pt);
            let dropped = match (kind, data.as_ref()) {
                (Kind::Files, Some(data)) => Some(read_paths(data))
                    .filter(|p| !p.is_empty())
                    .map(Dropped::Files),
                (Kind::Image, Some(data)) => read_image(data),
                _ => None,
            };
            if !effect.is_null() {
                // SAFETY: OLE passes a valid in/out pointer (checked for null).
                unsafe {
                    *effect = if dropped.is_some() {
                        DROPEFFECT_COPY
                    } else {
                        DROPEFFECT_NONE
                    }
                };
            }
            (self.sink)(match dropped {
                Some(dropped) => DropEvent::Drop { x, y, dropped },
                None => DropEvent::Leave,
            });
            Ok(())
        }
    }

    unsafe extern "system" fn collect(hwnd: HWND, lparam: LPARAM) -> BOOL {
        // SAFETY: `lparam` is the Vec passed by `register`, alive during EnumChildWindows.
        let children = unsafe { &mut *(lparam.0 as *mut Vec<HWND>) };
        children.push(hwnd);
        true.into()
    }

    /// Takes over drops on every window inside `top` (the WebView2 ones), replacing whatever
    /// was registered (wry's handler, or ours from an earlier page load). Main thread only:
    /// OLE calls the targets on the thread that registered them. Returns how many windows.
    pub fn register(top: isize, sink: Rc<dyn Fn(DropEvent)>) -> usize {
        let top = HWND(top as *mut c_void);
        let mut children: Vec<HWND> = Vec::new();
        // SAFETY: the callback only pushes into the Vec, which outlives the call.
        unsafe {
            let _ = EnumChildWindows(
                Some(top),
                Some(collect),
                LPARAM(&mut children as *mut Vec<HWND> as isize),
            );
        }
        let mut count = 0;
        for child in children {
            let target: IDropTarget = DropTarget {
                top,
                sink: sink.clone(),
                kind: Cell::new(Kind::None),
            }
            .into();
            // SAFETY: windows of this thread (children of the app's window).
            unsafe {
                if let Err(error) = RevokeDragDrop(child)
                    && error.code() == DRAGDROP_E_INVALIDHWND
                {
                    continue;
                }
                if RegisterDragDrop(child, &target).is_ok() {
                    count += 1;
                }
            }
        }
        count
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn descriptor(name: &str, flags: u32, attributes: u32, size: u64) -> Vec<u8> {
        let mut d = vec![0u8; DESCRIPTOR_SIZE];
        d[0..4].copy_from_slice(&flags.to_le_bytes());
        d[36..40].copy_from_slice(&attributes.to_le_bytes());
        d[64..68].copy_from_slice(&((size >> 32) as u32).to_le_bytes());
        d[68..72].copy_from_slice(&(size as u32).to_le_bytes());
        for (i, unit) in name.encode_utf16().enumerate() {
            d[72 + i * 2..74 + i * 2].copy_from_slice(&unit.to_le_bytes());
        }
        d
    }

    fn file_group(entries: &[(&str, u32, u32, u64)]) -> Vec<u8> {
        let mut bytes = (entries.len() as u32).to_le_bytes().to_vec();
        for (name, flags, attributes, size) in entries {
            bytes.extend(descriptor(name, *flags, *attributes, *size));
        }
        bytes
    }

    #[test]
    fn virtual_files_are_read_from_the_descriptor() {
        let bytes = file_group(&[
            ("carpeta", 0, FILE_ATTRIBUTE_DIRECTORY, 0),
            ("captura ñ.png", FD_FILESIZE, 0, 1234),
            ("Página.url", 0, 0, 0),
        ]);
        assert_eq!(
            parse_file_group(&bytes),
            vec![
                VirtualFile {
                    name: "captura ñ.png".into(),
                    size: Some(1234)
                },
                VirtualFile {
                    name: "Página.url".into(),
                    size: None
                },
            ]
        );
        // Truncated or empty data: what can be read, nothing more.
        assert_eq!(parse_file_group(&bytes[..4 + DESCRIPTOR_SIZE + 10]), vec![]);
        assert_eq!(parse_file_group(&[]), vec![]);
    }

    #[test]
    fn only_real_images_are_taken() {
        assert!(
            is_image_name("photo.JPG") && is_image_name("a.webp") && !is_image_name("page.url")
        );
        let png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
        assert_eq!(
            image_from(ImageSource::File, png.clone(), "gato.png"),
            Some(Dropped::Image {
                bytes: png.clone(),
                name: "gato.png".into()
            })
        );
        assert_eq!(
            image_from(ImageSource::Png, png.clone(), ""),
            Some(Dropped::Image {
                bytes: png,
                name: "imagen.png".into()
            })
        );
        // A link dragged from a browser is a virtual .url file; "PNG" that is not a PNG.
        assert_eq!(
            image_from(ImageSource::File, b"[InternetShortcut]".to_vec(), "x.png"),
            None
        );
        assert_eq!(
            image_from(ImageSource::Png, vec![0xFF, 0xD8, 0xFF, 0xE0], ""),
            None
        );
        assert_eq!(image_from(ImageSource::Dib, b"nope".to_vec(), ""), None);
    }
}
