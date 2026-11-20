//! Native audio engine for Cafofo:
//! - Input device enumeration (`cpal`)
//! - Microphone pipeline: `cpal` -> 48 kHz resample (`rubato`) -> RNNoise (`nnnoiseless`) -> lock-free `ringbuf`
//! - Isolated per-process WASAPI loopback capture with safe standard loopback fallback & silence injection
//! - Lightweight global Push-to-Talk polling (`GetAsyncKeyState` on Windows)

pub mod microphone;
pub mod process_loopback;
pub mod ptt;

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;

use nnnoiseless::DenoiseState;
use serde::{Deserialize, Serialize};
use thiserror::Error;

pub use microphone::{list_input_devices, MicrophoneCapture, MicrophoneConfig};
pub use process_loopback::{LoopbackMode, ProcessLoopbackCapture, ProcessLoopbackConfig};
pub use ptt::{PushToTalkConfig, PushToTalkMonitor};

/// Target sample rate required by RNNoise (`nnnoiseless`) and WebRTC/LiveKit Opus.
pub const TARGET_SAMPLE_RATE_HZ: u32 = 48_000;
/// RNNoise operates on exact 10 ms mono frames at 48 kHz (480 samples).
pub const DENOISE_FRAME_SIZE: usize = DenoiseState::FRAME_SIZE;
/// RNNoise expects PCM samples scaled to the 16-bit signed range (`-32768.0..32767.0`).
pub const PCM_SCALE: f32 = 32768.0;

#[derive(Debug, Error)]
pub enum AudioEngineError {
    #[error("feature only supported on Windows")]
    UnsupportedPlatform,
    #[error("audio device not found: {0}")]
    DeviceNotFound(String),
    #[error("no supported audio stream config available")]
    NoStreamConfig,
    #[error("invalid frame length: expected {expected} samples, got {actual}")]
    InvalidFrameLength { expected: usize, actual: usize },
    #[error("audio backend error: {0}")]
    Backend(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum AudioDirection {
    Input,
    Output,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AudioDeviceInfo {
    pub id: String,
    pub name: String,
    pub direction: AudioDirection,
    pub is_default: bool,
    pub sample_rate: u32,
    pub channels: u16,
}

/// Real-time lock-free audio telemetry shared between the audio thread and callers.
#[derive(Debug, Default)]
pub struct AudioMetrics {
    rms_bits: AtomicU32,
    vad_bits: AtomicU32,
    muted: AtomicBool,
}

impl AudioMetrics {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub fn set_levels(&self, rms: f32, vad: f32) {
        self.rms_bits.store(rms.to_bits(), Ordering::Relaxed);
        self.vad_bits.store(vad.to_bits(), Ordering::Relaxed);
    }

    pub fn rms(&self) -> f32 {
        f32::from_bits(self.rms_bits.load(Ordering::Relaxed))
    }

    pub fn vad(&self) -> f32 {
        f32::from_bits(self.vad_bits.load(Ordering::Relaxed))
    }

    pub fn set_muted(&self, muted: bool) {
        self.muted.store(muted, Ordering::Relaxed);
    }

    pub fn is_muted(&self) -> bool {
        self.muted.load(Ordering::Relaxed)
    }
}

/// Wrapper around `nnnoiseless::DenoiseState` operating on 48 kHz mono frames
/// scaled to `-32768.0..32767.0`.
pub struct NoiseSuppressor {
    state: Box<DenoiseState<'static>>,
}

impl Default for NoiseSuppressor {
    fn default() -> Self {
        Self::new()
    }
}

impl NoiseSuppressor {
    pub fn new() -> Self {
        Self {
            state: DenoiseState::new(),
        }
    }

    /// Processes a single 480-sample frame already scaled to `-32768.0..32767.0`
    /// and returns the voice activity probability (`0.0..=1.0`).
    pub fn process_scaled_frame(
        &mut self,
        input_scaled: &[f32],
        output_scaled: &mut [f32],
    ) -> Result<f32, AudioEngineError> {
        if input_scaled.len() != DENOISE_FRAME_SIZE {
            return Err(AudioEngineError::InvalidFrameLength {
                expected: DENOISE_FRAME_SIZE,
                actual: input_scaled.len(),
            });
        }
        if output_scaled.len() != DENOISE_FRAME_SIZE {
            return Err(AudioEngineError::InvalidFrameLength {
                expected: DENOISE_FRAME_SIZE,
                actual: output_scaled.len(),
            });
        }

        Ok(self.state.process_frame(output_scaled, input_scaled))
    }
}

/// Converts normalized mono `f32` (`-1.0..=1.0`) samples into `i16` PCM.
pub fn normalized_f32_to_i16(sample: f32) -> i16 {
    (sample * PCM_SCALE).clamp(i16::MIN as f32, i16::MAX as f32) as i16
}

/// Computes normalized RMS amplitude (`0.0..=1.0`) for an `i16` PCM frame.
pub fn compute_rms_i16(samples: &[i16]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let sum_sq: f64 = samples
        .iter()
        .map(|&s| {
            let norm = f64::from(s) / f64::from(PCM_SCALE);
            norm * norm
        })
        .sum();
    (sum_sq / samples.len() as f64).sqrt().clamp(0.0, 1.0) as f32
}
