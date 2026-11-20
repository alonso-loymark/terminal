//! A minimal HTTP(S) POST with a streamed response, over WinHTTP: part of Windows (no HTTP
//! crate in the binary), with the system's proxy settings and certificate store.
//!
//! Synchronous WinHTTP on the request's own thread. Cancelling closes the request handle from
//! the cancelling thread, which WinHTTP supports to abort a blocking call (it then fails with
//! ERROR_WINHTTP_OPERATION_CANCELLED); after any call the thread checks the token before
//! touching the handle again.

use std::ffi::c_void;
use std::ptr::{null, null_mut};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use windows_sys::Win32::Foundation::GetLastError;
use windows_sys::Win32::Networking::WinHttp::{
    WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY, WINHTTP_ACCESS_TYPE_DEFAULT_PROXY, WINHTTP_FLAG_SECURE,
    WINHTTP_QUERY_FLAG_NUMBER, WINHTTP_QUERY_STATUS_CODE, WinHttpCloseHandle, WinHttpConnect,
    WinHttpOpen, WinHttpOpenRequest, WinHttpQueryHeaders, WinHttpReadData, WinHttpReceiveResponse,
    WinHttpSendRequest, WinHttpSetTimeouts,
};

use super::{CancelToken, Endpoint};

/// Resolve, connect, send; then up to this long between two pieces of the response (the API
/// sends pings while the model thinks).
const TIMEOUTS_MS: (i32, i32, i32, i32) = (15_000, 20_000, 30_000, 120_000);

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Session and connection handles.
struct Handle(*mut c_void);

impl Drop for Handle {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: a handle WinHTTP returned, closed exactly once.
            unsafe { WinHttpCloseHandle(self.0) };
        }
    }
}

/// The request handle: closed by whoever comes first, the request thread or a cancel.
struct Request {
    handle: *mut c_void,
    closed: AtomicBool,
}

// SAFETY: WinHTTP handles may be used and closed from any thread; `closed` guards the close.
unsafe impl Send for Request {}
// SAFETY: see above.
unsafe impl Sync for Request {}

impl Request {
    fn close(&self) {
        if !self.closed.swap(true, Ordering::SeqCst) {
            // SAFETY: a valid request handle, closed exactly once (guarded by `closed`).
            unsafe { WinHttpCloseHandle(self.handle) };
        }
    }
}

impl Drop for Request {
    fn drop(&mut self) {
        self.close();
    }
}

/// Why the exchange failed before or while reading the response (not an HTTP status).
#[derive(Debug)]
pub enum HttpError {
    Cancelled,
    Network(String),
}

fn last_error(what: &str) -> HttpError {
    // SAFETY: reads the calling thread's last error code.
    let code = unsafe { GetLastError() };
    let reason = match code {
        12002 => "se agotó el tiempo de espera".to_owned(),
        12007 => "no se pudo resolver el nombre del servidor".to_owned(),
        12017 => return HttpError::Cancelled,
        12029 => "no se pudo conectar con el servidor".to_owned(),
        12030 => "se cortó la conexión".to_owned(),
        12175 | 12045 | 12169 => "falló la conexión segura (certificado o TLS)".to_owned(),
        12180 | 12166 => "falló la configuración del proxy".to_owned(),
        _ => format!("error {code}"),
    };
    HttpError::Network(format!("{what}: {reason}"))
}

/// POSTs `body` to `endpoint` + `path` and hands each piece of the response to `on_data`
/// (with the status code). Returns the status code.
pub fn post(
    endpoint: &Endpoint,
    path: &str,
    headers: &[(&str, &str)],
    body: &[u8],
    cancel: &CancelToken,
    on_data: &mut dyn FnMut(u16, &[u8]),
) -> Result<u16, HttpError> {
    let agent = wide("Brisa");
    // SAFETY: valid null-terminated strings; null proxy name/bypass with automatic proxy.
    let mut session = Handle(unsafe {
        WinHttpOpen(
            agent.as_ptr(),
            WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
            null(),
            null(),
            0,
        )
    });
    if session.0.is_null() {
        // Before Windows 8.1 there is no automatic proxy: the configured one.
        // SAFETY: as above.
        session = Handle(unsafe {
            WinHttpOpen(
                agent.as_ptr(),
                WINHTTP_ACCESS_TYPE_DEFAULT_PROXY,
                null(),
                null(),
                0,
            )
        });
    }
    if session.0.is_null() {
        return Err(last_error("WinHttpOpen"));
    }
    let (resolve, connect, send, receive) = TIMEOUTS_MS;
    // SAFETY: valid session handle.
    unsafe { WinHttpSetTimeouts(session.0, resolve, connect, send, receive) };
    let host = wide(&endpoint.host);
    // SAFETY: valid session handle and host string.
    let connection = Handle(unsafe { WinHttpConnect(session.0, host.as_ptr(), endpoint.port, 0) });
    if connection.0.is_null() {
        return Err(last_error("conexión"));
    }
    let verb = wide("POST");
    let object = wide(&format!("{}{path}", endpoint.base_path));
    // SAFETY: valid connection handle and strings; null version/referrer/accept types.
    let handle = unsafe {
        WinHttpOpenRequest(
            connection.0,
            verb.as_ptr(),
            object.as_ptr(),
            null(),
            null(),
            null(),
            if endpoint.secure {
                WINHTTP_FLAG_SECURE
            } else {
                0
            },
        )
    };
    if handle.is_null() {
        return Err(last_error("pedido"));
    }
    let request = Arc::new(Request {
        handle,
        closed: AtomicBool::new(false),
    });
    let for_cancel = request.clone();
    cancel.on_cancel(move || for_cancel.close());

    let header_text: String = headers
        .iter()
        .map(|(name, value)| format!("{name}: {value}\r\n"))
        .collect();
    let header_text = wide(&header_text);
    let body_len = u32::try_from(body.len())
        .map_err(|_| HttpError::Network("pedido demasiado grande".into()))?;
    if cancel.is_cancelled() {
        return Err(HttpError::Cancelled);
    }
    // SAFETY: valid request handle; headers null-terminated (length u32::MAX = -1: up to the
    // terminator); the body outlives the call.
    let sent = unsafe {
        WinHttpSendRequest(
            request.handle,
            header_text.as_ptr(),
            u32::MAX,
            body.as_ptr().cast(),
            body_len,
            body_len,
            0,
        )
    };
    if sent == 0 {
        return Err(if cancel.is_cancelled() {
            HttpError::Cancelled
        } else {
            last_error("envío")
        });
    }
    if cancel.is_cancelled() {
        return Err(HttpError::Cancelled);
    }
    // SAFETY: valid request handle.
    if unsafe { WinHttpReceiveResponse(request.handle, null_mut()) } == 0 {
        return Err(if cancel.is_cancelled() {
            HttpError::Cancelled
        } else {
            last_error("respuesta")
        });
    }
    let mut status: u32 = 0;
    let mut size = size_of::<u32>() as u32;
    if cancel.is_cancelled() {
        return Err(HttpError::Cancelled);
    }
    // SAFETY: valid request handle; `status` is a writable u32 of `size` bytes.
    let ok = unsafe {
        WinHttpQueryHeaders(
            request.handle,
            WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
            null(),
            (&raw mut status).cast(),
            &mut size,
            null_mut(),
        )
    };
    if ok == 0 {
        return Err(last_error("estado"));
    }
    let status = status as u16;
    let mut buf = vec![0u8; 16 * 1024];
    loop {
        if cancel.is_cancelled() {
            return Err(HttpError::Cancelled);
        }
        let mut read: u32 = 0;
        // SAFETY: valid request handle; `buf` is writable for its length.
        let ok = unsafe {
            WinHttpReadData(
                request.handle,
                buf.as_mut_ptr().cast(),
                buf.len() as u32,
                &mut read,
            )
        };
        if ok == 0 {
            return Err(if cancel.is_cancelled() {
                HttpError::Cancelled
            } else {
                last_error("lectura")
            });
        }
        if read == 0 {
            return Ok(status);
        }
        on_data(status, &buf[..read as usize]);
    }
}
