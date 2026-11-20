use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;

use serde::{Deserialize, Serialize};

/// Common Win32 Virtual-Key codes useful for Push-to-Talk configuration.
pub const VK_XBUTTON1: u16 = 0x05;
pub const VK_XBUTTON2: u16 = 0x06;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PushToTalkConfig {
    /// Win32 Virtual-Key code (`None` disables Push-to-Talk / uses open mic).
    pub vk_code: Option<u16>,
    /// Lightweight polling interval in milliseconds (defaults to 15 ms).
    pub poll_interval_ms: u64,
}

impl Default for PushToTalkConfig {
    fn default() -> Self {
        Self {
            vk_code: None,
            poll_interval_ms: 15,
        }
    }
}

/// Non-intrusive global Push-to-Talk detector using `GetAsyncKeyState` polling.
/// Does not install OS hooks, avoiding input blocking/consumption inside fullscreen games.
pub struct PushToTalkMonitor {
    vk_code: Arc<AtomicU16>,
    pressed: Arc<AtomicBool>,
    stop_flag: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}

impl PushToTalkMonitor {
    pub fn start(config: PushToTalkConfig) -> Self {
        let vk_code = Arc::new(AtomicU16::new(config.vk_code.unwrap_or(0)));
        let pressed = Arc::new(AtomicBool::new(false));
        let stop_flag = Arc::new(AtomicBool::new(false));

        let vk_clone = Arc::clone(&vk_code);
        let pressed_clone = Arc::clone(&pressed);
        let stop_clone = Arc::clone(&stop_flag);
        let poll_interval = Duration::from_millis(config.poll_interval_ms.max(5));

        let worker = thread::Builder::new()
            .name("cafofo-ptt-poller".to_string())
            .spawn(move || {
                while !stop_clone.load(Ordering::Relaxed) {
                    let vk = vk_clone.load(Ordering::Relaxed);
                    let is_down = if vk == 0 {
                        false
                    } else {
                        is_vk_pressed(vk)
                    };
                    pressed_clone.store(is_down, Ordering::Relaxed);
                    thread::sleep(poll_interval);
                }
            })
            .ok();

        Self {
            vk_code,
            pressed,
            stop_flag,
            worker,
        }
    }

    pub fn set_key(&self, vk_code: Option<u16>) {
        self.vk_code.store(vk_code.unwrap_or(0), Ordering::Relaxed);
        if vk_code.is_none() {
            self.pressed.store(false, Ordering::Relaxed);
        }
    }

    pub fn key(&self) -> Option<u16> {
        match self.vk_code.load(Ordering::Relaxed) {
            0 => None,
            vk => Some(vk),
        }
    }

    pub fn is_enabled(&self) -> bool {
        self.vk_code.load(Ordering::Relaxed) != 0
    }

    pub fn is_pressed(&self) -> bool {
        self.pressed.load(Ordering::Relaxed)
    }
}

impl Drop for PushToTalkMonitor {
    fn drop(&mut self) {
        self.stop_flag.store(true, Ordering::Relaxed);
        if let Some(handle) = self.worker.take() {
            let _ = handle.join();
        }
    }
}

#[inline]
pub fn is_vk_pressed(vk_code: u16) -> bool {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;
        let state = unsafe { GetAsyncKeyState(i32::from(vk_code)) };
        (state as u16 & 0x8000) != 0
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = vk_code;
        false
    }
}
