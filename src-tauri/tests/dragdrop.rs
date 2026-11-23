//! Drops from other apps: what Brisa's drop target reads from real OLE data objects (built with
//! SHCreateDataObject and filled like a browser, Explorer or a bitmap app would).
#![cfg(windows)]

use std::mem::ManuallyDrop;

use brisa_lib::dragdrop::{self, Dropped};
use windows::Win32::Foundation::HGLOBAL;
use windows::Win32::System::Com::{
    COINIT_APARTMENTTHREADED, CoInitializeEx, DVASPECT_CONTENT, FORMATETC, IDataObject, STGMEDIUM,
    STGMEDIUM_0, TYMED_HGLOBAL,
};
use windows::Win32::System::DataExchange::RegisterClipboardFormatW;
use windows::Win32::System::Memory::{GMEM_MOVEABLE, GlobalAlloc, GlobalLock, GlobalUnlock};
use windows::Win32::System::Ole::{CF_DIB, CF_HDROP};
use windows::Win32::UI::Shell::SHCreateDataObject;
use windows::core::{HSTRING, PCWSTR};

const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR\0\0\0\x01";

fn data_object() -> IDataObject {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        SHCreateDataObject(None, None, None).expect("SHCreateDataObject")
    }
}

fn format_id(name: &str) -> u16 {
    unsafe { RegisterClipboardFormatW(PCWSTR(HSTRING::from(name).as_ptr())) as u16 }
}

/// Puts `bytes` as format `cf` (item `index`) in an HGLOBAL the data object takes over.
fn set(data: &IDataObject, cf: u16, index: i32, bytes: &[u8]) {
    unsafe {
        let handle: HGLOBAL = GlobalAlloc(GMEM_MOVEABLE, bytes.len().max(1)).unwrap();
        let ptr = GlobalLock(handle) as *mut u8;
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr, bytes.len());
        let _ = GlobalUnlock(handle);
        let format = FORMATETC {
            cfFormat: cf,
            ptd: std::ptr::null_mut(),
            dwAspect: DVASPECT_CONTENT.0,
            lindex: index,
            tymed: TYMED_HGLOBAL.0 as u32,
        };
        let medium = STGMEDIUM {
            tymed: TYMED_HGLOBAL.0 as u32,
            u: STGMEDIUM_0 { hGlobal: handle },
            pUnkForRelease: ManuallyDrop::new(None),
        };
        data.SetData(&format, &medium, true).expect("SetData");
    }
}

fn file_group(name: &str, size: Option<u32>) -> Vec<u8> {
    let mut d = vec![0u8; 592];
    if let Some(size) = size {
        d[0..4].copy_from_slice(&0x40u32.to_le_bytes());
        d[68..72].copy_from_slice(&size.to_le_bytes());
    }
    for (i, unit) in name.encode_utf16().enumerate() {
        d[72 + i * 2..74 + i * 2].copy_from_slice(&unit.to_le_bytes());
    }
    let mut bytes = 1u32.to_le_bytes().to_vec();
    bytes.extend(d);
    bytes
}

#[test]
fn a_browser_image_comes_as_a_virtual_file() {
    let data = data_object();
    set(
        &data,
        format_id("FileGroupDescriptorW"),
        -1,
        &file_group("gato ñ.png", Some(PNG.len() as u32)),
    );
    // The HGLOBAL is bigger than the file: the descriptor's size wins.
    let mut contents = PNG.to_vec();
    contents.extend_from_slice(&[0xEE; 7]);
    set(&data, format_id("FileContents"), 0, &contents);
    assert!(dragdrop::read_paths(&data).is_empty());
    assert!(dragdrop::has_image(&data));
    assert_eq!(
        dragdrop::read_image(&data),
        Some(Dropped::Image {
            bytes: PNG.to_vec(),
            name: "gato ñ.png".into()
        })
    );
}

#[test]
fn a_dragged_link_is_not_an_image() {
    let data = data_object();
    set(
        &data,
        format_id("FileGroupDescriptorW"),
        -1,
        &file_group("Página.url", None),
    );
    set(
        &data,
        format_id("FileContents"),
        0,
        b"[InternetShortcut]\r\nURL=https://example.com\r\n",
    );
    assert!(!dragdrop::has_image(&data));
    assert_eq!(dragdrop::read_image(&data), None);
}

#[test]
fn bitmaps_from_other_apps_png_first_then_dib() {
    let data = data_object();
    set(&data, format_id("PNG"), -1, PNG);
    assert!(dragdrop::has_image(&data));
    assert_eq!(
        dragdrop::read_image(&data),
        Some(Dropped::Image {
            bytes: PNG.to_vec(),
            name: "imagen.png".into()
        })
    );

    // A 1×1 32-bit DIB becomes a .bmp the page can decode.
    let data = data_object();
    let mut dib = Vec::new();
    for v in [40u32, 1, 1] {
        dib.extend_from_slice(&v.to_le_bytes());
    }
    dib.extend_from_slice(&1u16.to_le_bytes());
    dib.extend_from_slice(&32u16.to_le_bytes());
    dib.extend_from_slice(&[0; 24]);
    dib.extend_from_slice(&[1, 2, 3, 4]);
    set(&data, CF_DIB.0, -1, &dib);
    let Some(Dropped::Image { bytes, name }) = dragdrop::read_image(&data) else {
        panic!("sin imagen")
    };
    assert_eq!(&bytes[..2], b"BM");
    assert_eq!(&bytes[14..], &dib[..]);
    assert_eq!(name, "imagen.bmp");
}

#[test]
fn files_from_explorer_arrive_as_paths() {
    let data = data_object();
    // DROPFILES { pFiles = 20, pt, fNC, fWide = TRUE } + wide paths, double NUL at the end.
    let mut drop = Vec::new();
    drop.extend_from_slice(&20u32.to_le_bytes());
    drop.extend_from_slice(&[0; 12]);
    drop.extend_from_slice(&1u32.to_le_bytes());
    for path in [r"C:\fotos\captura 1.png", r"C:\Users\ñandú\notas.txt"] {
        for unit in path.encode_utf16().chain([0]) {
            drop.extend_from_slice(&unit.to_le_bytes());
        }
    }
    drop.extend_from_slice(&[0, 0]);
    set(&data, CF_HDROP.0, -1, &drop);
    let paths: Vec<String> = dragdrop::read_paths(&data)
        .iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    assert_eq!(
        paths,
        [r"C:\fotos\captura 1.png", r"C:\Users\ñandú\notas.txt"]
    );
}
