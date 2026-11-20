use serde::{Deserialize, Serialize};

use crate::ScreenCaptureError;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WindowInfo {
    pub hwnd: isize,
    pub pid: u32,
    pub title: String,
    pub process_name: String,
    pub icon_png_base64: Option<String>,
}

/// Enumerates visible, non-cloaked top-level application windows on Windows,
/// extracting `hwnd`, `pid`, window title, executable name, and Base64 PNG icon.
pub fn enumerate_visible_windows() -> Result<Vec<WindowInfo>, ScreenCaptureError> {
    #[cfg(target_os = "windows")]
    {
        windows_impl::enumerate()
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err(ScreenCaptureError::UnsupportedPlatform)
    }
}

/// Extracts the primary icon from a Windows executable (`.exe`) and returns it
/// encoded as a `data:image/png;base64,...` data URL.
pub fn extract_exe_icon_data_url(exe_path: &str) -> Result<Option<String>, ScreenCaptureError> {
    #[cfg(target_os = "windows")]
    {
        Ok(windows_impl::extract_exe_icon_data_url(exe_path))
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = exe_path;
        Err(ScreenCaptureError::UnsupportedPlatform)
    }
}

#[cfg(target_os = "windows")]
mod windows_impl {
    use std::ffi::c_void;
    use std::mem::size_of;
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;

    use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
    use base64::Engine;
    use windows::core::{PCWSTR, PWSTR};
    use windows::Win32::Foundation::{BOOL, CloseHandle, HWND, LPARAM, RECT, WPARAM};
    use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
    use windows::Win32::Graphics::Gdi::{
        CreateCompatibleDC, DeleteDC, DeleteObject, GetDIBits, GetObjectW, BITMAP,
        BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
    };
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::Shell::ExtractIconExW;
    use windows::Win32::UI::WindowsAndMessaging::{
        DestroyIcon, EnumWindows, GetClassLongPtrW, GetIconInfo, GetWindowLongPtrW,
        GetWindowRect, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId,
        IsWindowVisible, SendMessageTimeoutW, GCLP_HICON, GCLP_HICONSM, GWL_EXSTYLE, HICON,
        ICONINFO, ICON_BIG, ICON_SMALL, ICON_SMALL2, SMTO_ABORTIFHUNG, WM_GETICON,
        WS_EX_APPWINDOW, WS_EX_TOOLWINDOW,
    };

    use super::WindowInfo;
    use crate::ScreenCaptureError;

    pub fn enumerate() -> Result<Vec<WindowInfo>, ScreenCaptureError> {
        let mut windows = Vec::<WindowInfo>::new();
        let lparam = LPARAM((&mut windows as *mut Vec<WindowInfo>) as isize);

        unsafe {
            EnumWindows(Some(enum_window_proc), lparam).map_err(|e| {
                ScreenCaptureError::Backend(format!("EnumWindows failed: {e}"))
            })?;
        }

        Ok(windows)
    }

    unsafe extern "system" fn enum_window_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
        if !IsWindowVisible(hwnd).as_bool() {
            return BOOL(1);
        }

        // Filter out cloaked windows (UWP suspended apps, virtual desktop hidden windows, etc.)
        let mut cloaked: u32 = 0;
        let dwm_res = DwmGetWindowAttribute(
            hwnd,
            DWMWA_CLOAKED,
            (&mut cloaked as *mut u32).cast::<c_void>(),
            size_of::<u32>() as u32,
        );
        if dwm_res.is_ok() && cloaked != 0 {
            return BOOL(1);
        }

        let ex_style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
        if (ex_style & WS_EX_TOOLWINDOW.0) != 0 && (ex_style & WS_EX_APPWINDOW.0) == 0 {
            return BOOL(1);
        }

        let mut rect = RECT::default();
        if GetWindowRect(hwnd, &mut rect).is_err()
            || (rect.right - rect.left) <= 0
            || (rect.bottom - rect.top) <= 0
        {
            return BOOL(1);
        }

        let title_len = GetWindowTextLengthW(hwnd);
        if title_len <= 0 {
            return BOOL(1);
        }

        let mut title_buf = vec![0u16; (title_len + 1) as usize];
        let copied = GetWindowTextW(hwnd, &mut title_buf);
        if copied <= 0 {
            return BOOL(1);
        }
        let title = String::from_utf16_lossy(&title_buf[..copied as usize]);
        if title.trim().is_empty() {
            return BOOL(1);
        }

        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == 0 {
            return BOOL(1);
        }

        let process_name = query_process_name(pid).unwrap_or_else(|| "unknown.exe".to_string());
        let icon_png_base64 = extract_window_icon_png_base64(hwnd);

        let list = &mut *(lparam.0 as *mut Vec<WindowInfo>);
        list.push(WindowInfo {
            hwnd: hwnd.0 as isize,
            pid,
            title,
            process_name,
            icon_png_base64,
        });

        BOOL(1)
    }

    unsafe fn query_process_name(pid: u32) -> Option<String> {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = vec![0u16; 1024];
        let mut size = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            PWSTR(buf.as_mut_ptr()),
            &mut size,
        )
        .is_ok();
        let _ = CloseHandle(handle);

        if !ok || size == 0 {
            return None;
        }

        let full_path = String::from_utf16_lossy(&buf[..size as usize]);
        Path::new(&full_path)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .or(Some(full_path))
    }

    unsafe fn extract_window_icon_png_base64(hwnd: HWND) -> Option<String> {
        let hicon = resolve_hicon(hwnd)?;
        hicon_to_png_base64(hicon)
    }

    unsafe fn resolve_hicon(hwnd: HWND) -> Option<HICON> {
        for icon_type in [ICON_BIG, ICON_SMALL2, ICON_SMALL] {
            let mut result: usize = 0;
            let sent = SendMessageTimeoutW(
                hwnd,
                WM_GETICON,
                WPARAM(icon_type as usize),
                LPARAM(0),
                SMTO_ABORTIFHUNG,
                50,
                Some(&mut result),
            );
            if sent.0 != 0 && result != 0 {
                return Some(HICON(result as *mut c_void));
            }
        }

        for index in [GCLP_HICON, GCLP_HICONSM] {
            let ptr = GetClassLongPtrW(hwnd, index);
            if ptr != 0 {
                return Some(HICON(ptr as *mut c_void));
            }
        }

        None
    }

    unsafe fn hicon_to_png_base64(hicon: HICON) -> Option<String> {
        let mut icon_info = ICONINFO::default();
        if GetIconInfo(hicon, &mut icon_info).is_err() {
            return None;
        }

        let color_bmp = icon_info.hbmColor;
        let mask_bmp = icon_info.hbmMask;

        let result = (|| {
            if color_bmp.is_invalid() {
                return None;
            }

            let mut bmp = BITMAP::default();
            if GetObjectW(
                color_bmp,
                size_of::<BITMAP>() as i32,
                Some((&mut bmp as *mut BITMAP).cast::<c_void>()),
            ) == 0
            {
                return None;
            }

            let width = bmp.bmWidth;
            let height = bmp.bmHeight.abs();
            if width <= 0 || height <= 0 || width > 512 || height > 512 {
                return None;
            }

            let hdc = CreateCompatibleDC(None);
            if hdc.is_invalid() {
                return None;
            }

            let mut bmi = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: width,
                    biHeight: -height, // top-down DIB
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    ..Default::default()
                },
                ..Default::default()
            };

            let mut bgra = vec![0u8; (width * height * 4) as usize];
            let scan_lines = GetDIBits(
                hdc,
                color_bmp,
                0,
                height as u32,
                Some(bgra.as_mut_ptr().cast::<c_void>()),
                &mut bmi,
                DIB_RGB_COLORS,
            );
            let _ = DeleteDC(hdc);

            if scan_lines == 0 {
                return None;
            }

            // Convert BGRA -> RGBA for PNG encoding
            let mut rgba = vec![0u8; bgra.len()];
            let mut has_alpha = false;
            for (dst, src) in rgba.chunks_exact_mut(4).zip(bgra.chunks_exact(4)) {
                dst[0] = src[2];
                dst[1] = src[1];
                dst[2] = src[0];
                dst[3] = src[3];
                if src[3] != 0 {
                    has_alpha = true;
                }
            }
            if !has_alpha {
                for px in rgba.chunks_exact_mut(4) {
                    px[3] = 255;
                }
            }

            let mut png_bytes = Vec::new();
            {
                let mut encoder = png::Encoder::new(&mut png_bytes, width as u32, height as u32);
                encoder.set_color(png::ColorType::Rgba);
                encoder.set_depth(png::BitDepth::Eight);
                let mut writer = encoder.write_header().ok()?;
                writer.write_image_data(&rgba).ok()?;
            }

            Some(BASE64_STANDARD.encode(png_bytes))
        })();

        if !color_bmp.is_invalid() {
            let _ = DeleteObject(color_bmp);
        }
        if !mask_bmp.is_invalid() {
            let _ = DeleteObject(mask_bmp);
        }

        result
    }

    pub fn extract_exe_icon_data_url(exe_path: &str) -> Option<String> {
        let trimmed = exe_path.trim();
        if trimmed.is_empty() {
            return None;
        }
        let path = Path::new(trimmed);
        if !path.is_file() {
            return None;
        }

        let wide: Vec<u16> = path
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();

        let mut large_icon = HICON::default();
        let mut small_icon = HICON::default();
        let extracted = unsafe {
            ExtractIconExW(
                PCWSTR(wide.as_ptr()),
                0,
                Some(&mut large_icon),
                Some(&mut small_icon),
                1,
            )
        };

        let png_base64 = if extracted > 0 {
            let chosen = if !large_icon.is_invalid() {
                Some(large_icon)
            } else if !small_icon.is_invalid() {
                Some(small_icon)
            } else {
                None
            };
            chosen.and_then(|hicon| unsafe { hicon_to_png_base64(hicon) })
        } else {
            None
        };

        unsafe {
            if !large_icon.is_invalid() {
                let _ = DestroyIcon(large_icon);
            }
            if !small_icon.is_invalid() {
                let _ = DestroyIcon(small_icon);
            }
        }

        png_base64.map(|b64| format!("data:image/png;base64,{b64}"))
    }
}
