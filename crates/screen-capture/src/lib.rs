//! Window enumeration (with DWM cloak filtering and PNG Base64 icon extraction)
//! and isolated per-window capture via `Windows.Graphics.Capture` (WGC).

pub mod wgc_capture;
pub mod windows_enumerate;

use serde::{Deserialize, Serialize};
use thiserror::Error;

pub use wgc_capture::{WgcWindowCapturer, WindowCaptureHandle};
pub use windows_enumerate::{
    enumerate_visible_windows, extract_exe_icon_data_url, WindowInfo,
};

#[derive(Debug, Error)]
pub enum ScreenCaptureError {
    #[error("Windows Graphics Capture is only supported on Windows 10 1903+")]
    UnsupportedPlatform,
    #[error("capture target not found: {0}")]
    TargetNotFound(String),
    #[error("capture session is already active")]
    AlreadyRunning,
    #[error("capture backend error: {0}")]
    Backend(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum CaptureTarget {
    Window {
        hwnd: isize,
        pid: u32,
        title: String,
        process_name: String,
    },
    Monitor {
        id: String,
        name: String,
        width: u32,
        height: u32,
        is_primary: bool,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CaptureConfig {
    pub target_fps: u32,
    pub capture_cursor: bool,
    pub draw_border: bool,
    pub capture_audio: bool,
}

impl Default for CaptureConfig {
    fn default() -> Self {
        Self {
            target_fps: 60,
            capture_cursor: true,
            draw_border: false,
            capture_audio: true,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PixelFormat {
    Bgra8,
    I420,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CapturedVideoFrame {
    pub width: u32,
    pub height: u32,
    pub timestamp_ms: u64,
    pub pixel_format: PixelFormat,
    /// Tightly packed BGRA8 (`width * height * 4`) bytes.
    pub bgra: Vec<u8>,
}

impl CapturedVideoFrame {
    /// Converts tightly packed BGRA8 (`width * height * 4`) into planar I420 `(Y, U, V)` planes
    /// using BT.601 studio/limited-range coefficients suitable for WebRTC encoders.
    pub fn to_i420_planes(&self) -> (Vec<u8>, Vec<u8>, Vec<u8>) {
        bgra_to_i420(&self.bgra, self.width, self.height)
    }
}

/// Converts tightly packed BGRA8 pixels to planar I420 `(y, u, v)` buffers.
pub fn bgra_to_i420(bgra: &[u8], width: u32, height: u32) -> (Vec<u8>, Vec<u8>, Vec<u8>) {
    let w = width as usize;
    let h = height as usize;
    let cw = w.div_ceil(2);
    let ch = h.div_ceil(2);

    let mut y_plane = vec![0u8; w * h];
    let mut u_plane = vec![128u8; cw * ch];
    let mut v_plane = vec![128u8; cw * ch];

    for row in 0..h {
        let row_offset = row * w;
        for col in 0..w {
            let px = (row_offset + col) * 4;
            let b = i32::from(bgra[px]);
            let g = i32::from(bgra[px + 1]);
            let r = i32::from(bgra[px + 2]);

            let y = ((66 * r + 129 * g + 25 * b + 128) >> 8) + 16;
            y_plane[row_offset + col] = y.clamp(0, 255) as u8;

            if (row & 1) == 0 && (col & 1) == 0 {
                let mut r_sum = r;
                let mut g_sum = g;
                let mut b_sum = b;
                let mut count = 1;

                if col + 1 < w {
                    let p = (row_offset + col + 1) * 4;
                    b_sum += i32::from(bgra[p]);
                    g_sum += i32::from(bgra[p + 1]);
                    r_sum += i32::from(bgra[p + 2]);
                    count += 1;
                }
                if row + 1 < h {
                    let p = ((row + 1) * w + col) * 4;
                    b_sum += i32::from(bgra[p]);
                    g_sum += i32::from(bgra[p + 1]);
                    r_sum += i32::from(bgra[p + 2]);
                    count += 1;
                }
                if col + 1 < w && row + 1 < h {
                    let p = ((row + 1) * w + col + 1) * 4;
                    b_sum += i32::from(bgra[p]);
                    g_sum += i32::from(bgra[p + 1]);
                    r_sum += i32::from(bgra[p + 2]);
                    count += 1;
                }

                let r_avg = r_sum / count;
                let g_avg = g_sum / count;
                let b_avg = b_sum / count;

                let u = ((-38 * r_avg - 74 * g_avg + 112 * b_avg + 128) >> 8) + 128;
                let v = ((112 * r_avg - 94 * g_avg - 18 * b_avg + 128) >> 8) + 128;

                let uv_idx = (row / 2) * cw + (col / 2);
                u_plane[uv_idx] = u.clamp(0, 255) as u8;
                v_plane[uv_idx] = v.clamp(0, 255) as u8;
            }
        }
    }

    (y_plane, u_plane, v_plane)
}
