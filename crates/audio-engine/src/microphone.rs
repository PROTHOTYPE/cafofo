use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Device, SampleFormat, Stream, StreamConfig};
use ringbuf::traits::{Producer, Split};
use ringbuf::{HeapCons, HeapProd, HeapRb};
use rubato::{
    Resampler, SincFixedIn, SincInterpolationParameters, SincInterpolationType, WindowFunction,
};
use serde::{Deserialize, Serialize};

use crate::{
    compute_rms_i16, normalized_f32_to_i16, AudioDeviceInfo, AudioDirection, AudioEngineError,
    AudioMetrics, NoiseSuppressor, DENOISE_FRAME_SIZE, PCM_SCALE, TARGET_SAMPLE_RATE_HZ,
};

const MIC_RING_CAPACITY_SAMPLES: usize = TARGET_SAMPLE_RATE_HZ as usize; // 1s buffer at 48 kHz
const RESAMPLER_INPUT_CHUNK: usize = 480;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MicrophoneConfig {
    pub device_id: Option<String>,
    pub noise_suppression: bool,
}

impl Default for MicrophoneConfig {
    fn default() -> Self {
        Self {
            device_id: None,
            noise_suppression: true,
        }
    }
}

/// Enumerates available audio input devices using `cpal`.
pub fn list_input_devices() -> Result<Vec<AudioDeviceInfo>, AudioEngineError> {
    let host = cpal::default_host();
    let default_name = host
        .default_input_device()
        .and_then(|d| d.name().ok());

    let devices = host
        .input_devices()
        .map_err(|e| AudioEngineError::Backend(format!("failed to enumerate input devices: {e}")))?;

    let mut result = Vec::new();
    for (idx, device) in devices.enumerate() {
        let name = device
            .name()
            .unwrap_or_else(|_| format!("Input Device #{idx}"));
        let default_cfg = device.default_input_config().ok();
        let sample_rate = default_cfg
            .as_ref()
            .map(|c| c.sample_rate().0)
            .unwrap_or(TARGET_SAMPLE_RATE_HZ);
        let channels = default_cfg.as_ref().map(|c| c.channels()).unwrap_or(1);

        result.push(AudioDeviceInfo {
            id: name.clone(),
            is_default: default_name.as_deref() == Some(name.as_str()),
            name,
            direction: AudioDirection::Input,
            sample_rate,
            channels,
        });
    }

    Ok(result)
}

pub struct MicrophoneCapture {
    _stream: Stream,
    pub consumer: HeapCons<i16>,
    pub metrics: Arc<AudioMetrics>,
    rnnoise_enabled: Arc<AtomicBool>,
    muted: Arc<AtomicBool>,
}

impl MicrophoneCapture {
    pub fn start(config: MicrophoneConfig) -> Result<Self, AudioEngineError> {
        let host = cpal::default_host();
        let device = select_input_device(&host, config.device_id.as_deref())?;

        let supported = device
            .default_input_config()
            .map_err(|e| AudioEngineError::Backend(format!("default_input_config failed: {e}")))?;

        let sample_format = supported.sample_format();
        let stream_config: StreamConfig = supported.into();
        let input_rate = stream_config.sample_rate.0;
        let channels = usize::from(stream_config.channels.max(1));

        let rb = HeapRb::<i16>::new(MIC_RING_CAPACITY_SAMPLES);
        let (producer, consumer) = rb.split();

        let metrics = AudioMetrics::new();
        let rnnoise_enabled = Arc::new(AtomicBool::new(config.noise_suppression));
        let muted = Arc::new(AtomicBool::new(false));

        let mut processor = MicDspPipeline::new(
            input_rate,
            producer,
            Arc::clone(&metrics),
            Arc::clone(&rnnoise_enabled),
            Arc::clone(&muted),
        )?;

        let err_fn = |err: cpal::StreamError| {
            tracing::error!(%err, "microphone capture stream error");
        };

        let stream = match sample_format {
            SampleFormat::F32 => device.build_input_stream(
                &stream_config,
                move |data: &[f32], _| processor.push_interleaved_f32(data, channels),
                err_fn,
                None,
            ),
            SampleFormat::I16 => device.build_input_stream(
                &stream_config,
                move |data: &[i16], _| processor.push_interleaved_i16(data, channels),
                err_fn,
                None,
            ),
            SampleFormat::U16 => device.build_input_stream(
                &stream_config,
                move |data: &[u16], _| processor.push_interleaved_u16(data, channels),
                err_fn,
                None,
            ),
            other => {
                return Err(AudioEngineError::Backend(format!(
                    "unsupported cpal sample format: {other:?}"
                )));
            }
        }
        .map_err(|e| AudioEngineError::Backend(format!("failed to build input stream: {e}")))?;

        stream
            .play()
            .map_err(|e| AudioEngineError::Backend(format!("failed to start input stream: {e}")))?;

        Ok(Self {
            _stream: stream,
            consumer,
            metrics,
            rnnoise_enabled,
            muted,
        })
    }

    pub fn set_noise_suppression(&self, enabled: bool) {
        self.rnnoise_enabled.store(enabled, Ordering::Relaxed);
    }

    pub fn set_muted(&self, muted: bool) {
        self.muted.store(muted, Ordering::Relaxed);
        self.metrics.set_muted(muted);
    }
}

fn select_input_device(
    host: &cpal::Host,
    device_id: Option<&str>,
) -> Result<Device, AudioEngineError> {
    if let Some(target_id) = device_id {
        let mut devices = host
            .input_devices()
            .map_err(|e| AudioEngineError::Backend(format!("input_devices failed: {e}")))?;
        if let Some(found) = devices.find(|d| d.name().ok().as_deref() == Some(target_id)) {
            return Ok(found);
        }
        return Err(AudioEngineError::DeviceNotFound(target_id.to_string()));
    }

    host.default_input_device()
        .ok_or(AudioEngineError::NoStreamConfig)
}

struct MicDspPipeline {
    resampler: Option<SincFixedIn<f32>>,
    resampler_in_buf: Vec<f32>,
    frame_48k_buf: Vec<f32>,
    denoiser: NoiseSuppressor,
    scaled_in: [f32; DENOISE_FRAME_SIZE],
    scaled_out: [f32; DENOISE_FRAME_SIZE],
    pcm_out: [i16; DENOISE_FRAME_SIZE],
    producer: HeapProd<i16>,
    metrics: Arc<AudioMetrics>,
    rnnoise_enabled: Arc<AtomicBool>,
    muted: Arc<AtomicBool>,
}

impl MicDspPipeline {
    fn new(
        input_rate: u32,
        producer: HeapProd<i16>,
        metrics: Arc<AudioMetrics>,
        rnnoise_enabled: Arc<AtomicBool>,
        muted: Arc<AtomicBool>,
    ) -> Result<Self, AudioEngineError> {
        let resampler = if input_rate != TARGET_SAMPLE_RATE_HZ {
            let params = SincInterpolationParameters {
                sinc_len: 128,
                f_cutoff: 0.95,
                interpolation: SincInterpolationType::Linear,
                oversampling_factor: 128,
                window: WindowFunction::BlackmanHarris2,
            };
            let ratio = f64::from(TARGET_SAMPLE_RATE_HZ) / f64::from(input_rate);
            Some(
                SincFixedIn::<f32>::new(ratio, 2.0, params, RESAMPLER_INPUT_CHUNK, 1).map_err(
                    |e| AudioEngineError::Backend(format!("failed to create rubato resampler: {e}")),
                )?,
            )
        } else {
            None
        };

        Ok(Self {
            resampler,
            resampler_in_buf: Vec::with_capacity(RESAMPLER_INPUT_CHUNK * 4),
            frame_48k_buf: Vec::with_capacity(DENOISE_FRAME_SIZE * 4),
            denoiser: NoiseSuppressor::new(),
            scaled_in: [0.0; DENOISE_FRAME_SIZE],
            scaled_out: [0.0; DENOISE_FRAME_SIZE],
            pcm_out: [0; DENOISE_FRAME_SIZE],
            producer,
            metrics,
            rnnoise_enabled,
            muted,
        })
    }

    fn push_interleaved_f32(&mut self, data: &[f32], channels: usize) {
        let inv_ch = 1.0 / channels as f32;
        for frame in data.chunks_exact(channels) {
            let mono = frame.iter().copied().sum::<f32>() * inv_ch;
            self.push_mono_sample(mono);
        }
        self.process_ready_frames();
    }

    fn push_interleaved_i16(&mut self, data: &[i16], channels: usize) {
        let inv_ch = 1.0 / channels as f32;
        for frame in data.chunks_exact(channels) {
            let mono = frame
                .iter()
                .map(|&s| f32::from(s) / PCM_SCALE)
                .sum::<f32>()
                * inv_ch;
            self.push_mono_sample(mono);
        }
        self.process_ready_frames();
    }

    fn push_interleaved_u16(&mut self, data: &[u16], channels: usize) {
        let inv_ch = 1.0 / channels as f32;
        for frame in data.chunks_exact(channels) {
            let mono = frame
                .iter()
                .map(|&s| (f32::from(s) - 32768.0) / PCM_SCALE)
                .sum::<f32>()
                * inv_ch;
            self.push_mono_sample(mono);
        }
        self.process_ready_frames();
    }

    #[inline]
    fn push_mono_sample(&mut self, sample: f32) {
        if self.resampler.is_some() {
            self.resampler_in_buf.push(sample);
        } else {
            self.frame_48k_buf.push(sample);
        }
    }

    fn process_ready_frames(&mut self) {
        if let Some(resampler) = self.resampler.as_mut() {
            let needed = resampler.input_frames_next();
            while self.resampler_in_buf.len() >= needed {
                let chunk: Vec<f32> = self.resampler_in_buf.drain(..needed).collect();
                if let Ok(resampled) = resampler.process(&[chunk], None) {
                    if let Some(mono_48k) = resampled.first() {
                        self.frame_48k_buf.extend_from_slice(mono_48k);
                    }
                }
            }
        }

        let is_muted = self.muted.load(Ordering::Relaxed);
        let use_rnnoise = self.rnnoise_enabled.load(Ordering::Relaxed);

        while self.frame_48k_buf.len() >= DENOISE_FRAME_SIZE {
            let frame_slice: Vec<f32> = self.frame_48k_buf.drain(..DENOISE_FRAME_SIZE).collect();

            if is_muted {
                self.pcm_out.fill(0);
                self.metrics.set_levels(0.0, 0.0);
                let _ = self.producer.push_slice(&self.pcm_out);
                continue;
            }

            let vad = if use_rnnoise {
                for (dst, &src) in self.scaled_in.iter_mut().zip(frame_slice.iter()) {
                    *dst = (src * PCM_SCALE).clamp(i16::MIN as f32, i16::MAX as f32);
                }

                let vad = self
                    .denoiser
                    .process_scaled_frame(&self.scaled_in, &mut self.scaled_out)
                    .unwrap_or(0.0);

                for (dst, &src) in self.pcm_out.iter_mut().zip(self.scaled_out.iter()) {
                    *dst = src.clamp(i16::MIN as f32, i16::MAX as f32) as i16;
                }
                vad
            } else {
                for (dst, &src) in self.pcm_out.iter_mut().zip(frame_slice.iter()) {
                    *dst = normalized_f32_to_i16(src);
                }
                0.0
            };

            let rms = compute_rms_i16(&self.pcm_out);
            self.metrics.set_levels(rms, vad);
            let _ = self.producer.push_slice(&self.pcm_out);
        }
    }
}
