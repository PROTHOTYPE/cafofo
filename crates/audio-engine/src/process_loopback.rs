use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;

use ringbuf::traits::Split;
use ringbuf::{HeapCons, HeapRb};
use serde::{Deserialize, Serialize};

use crate::{AudioEngineError, TARGET_SAMPLE_RATE_HZ};

const LOOPBACK_CHANNELS: usize = 2;
/// 10 ms stereo frame at 48 kHz = 480 * 2 samples.
const SILENCE_FRAME_SAMPLES: usize = 480 * LOOPBACK_CHANNELS;
const LOOPBACK_RING_CAPACITY_SAMPLES: usize = TARGET_SAMPLE_RATE_HZ as usize * LOOPBACK_CHANNELS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum LoopbackMode {
    ProcessTreeIsolated,
    StandardSystemFallback,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProcessLoopbackConfig {
    pub target_pid: u32,
    pub allow_standard_fallback: bool,
}

pub struct ProcessLoopbackCapture {
    stop_flag: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
    pub consumer: HeapCons<i16>,
    pub mode: LoopbackMode,
}

impl ProcessLoopbackCapture {
    pub fn start(config: ProcessLoopbackConfig) -> Result<Self, AudioEngineError> {
        let rb = HeapRb::<i16>::new(LOOPBACK_RING_CAPACITY_SAMPLES);
        let (producer, consumer) = rb.split();
        let stop_flag = Arc::new(AtomicBool::new(false));

        #[cfg(target_os = "windows")]
        {
            let (mode, worker) = windows_impl::spawn_loopback_worker(
                config,
                producer,
                Arc::clone(&stop_flag),
            )?;
            Ok(Self {
                stop_flag,
                worker: Some(worker),
                consumer,
                mode,
            })
        }

        #[cfg(not(target_os = "windows"))]
        {
            let _ = (config, producer, stop_flag);
            Err(AudioEngineError::UnsupportedPlatform)
        }
    }

    pub fn stop(&mut self) {
        self.stop_flag.store(true, Ordering::Relaxed);
        if let Some(handle) = self.worker.take() {
            let _ = handle.join();
        }
    }
}

impl Drop for ProcessLoopbackCapture {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(target_os = "windows")]
mod windows_impl {
    use std::ffi::c_void;
    use std::mem::size_of;
    use std::ptr;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Condvar, Mutex};
    use std::thread::{self, JoinHandle};
    use std::time::{Duration, Instant};

    use ringbuf::traits::Producer;
    use ringbuf::HeapProd;
    use windows::core::{implement, Interface, IUnknown, HRESULT, PROPVARIANT};
    use windows::Win32::Foundation::{E_FAIL, S_OK};
    use windows::Win32::Media::Audio::{
        eConsole, eRender, ActivateAudioInterfaceAsync, IActivateAudioInterfaceAsyncOperation,
        IActivateAudioInterfaceCompletionHandler, IActivateAudioInterfaceCompletionHandler_Impl,
        IAudioCaptureClient, IAudioClient, IMMDeviceEnumerator, MMDeviceEnumerator,
        AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM, AUDCLNT_STREAMFLAGS_LOOPBACK,
        AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY, AUDIOCLIENT_ACTIVATION_PARAMS,
        AUDIOCLIENT_ACTIVATION_PARAMS_0, AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
        AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS, PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE,
        VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, WAVEFORMATEX,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED,
    };
    use windows::Win32::System::Variant::VT_BLOB;

    const WAVE_FORMAT_PCM: u16 = 1;

    #[repr(C)]
    struct RawBlobPropVariant {
        vt: u16,
        w_reserved1: u16,
        w_reserved2: u16,
        w_reserved3: u16,
        cb_size: u32,
        #[cfg(target_pointer_width = "64")]
        _pad: u32,
        p_blob_data: *mut u8,
    }

    use super::{
        LoopbackMode, ProcessLoopbackConfig, LOOPBACK_CHANNELS, SILENCE_FRAME_SAMPLES,
    };
    use crate::{AudioEngineError, TARGET_SAMPLE_RATE_HZ};

    #[implement(IActivateAudioInterfaceCompletionHandler)]
    struct ActivationCompletionHandler {
        state: Arc<(Mutex<Option<HRESULT>>, Condvar)>,
    }

    impl IActivateAudioInterfaceCompletionHandler_Impl for ActivationCompletionHandler_Impl {
        fn ActivateCompleted(
            &self,
            activate_operation: Option<&IActivateAudioInterfaceAsyncOperation>,
        ) -> windows::core::Result<()> {
            let hr = match activate_operation {
                Some(op) => {
                    let mut result = HRESULT(0);
                    let mut unk: Option<IUnknown> = None;
                    unsafe { op.GetActivateResult(&mut result, &mut unk) }
                        .err()
                        .map(|e| e.code())
                        .unwrap_or(result)
                }
                None => E_FAIL,
            };

            let (lock, cvar) = &*self.state;
            if let Ok(mut guard) = lock.lock() {
                *guard = Some(hr);
                cvar.notify_all();
            }
            Ok(())
        }
    }

    pub fn spawn_loopback_worker(
        config: ProcessLoopbackConfig,
        mut producer: HeapProd<i16>,
        stop_flag: Arc<AtomicBool>,
    ) -> Result<(LoopbackMode, JoinHandle<()>), AudioEngineError> {
        let (mode_tx, mode_rx) = std::sync::mpsc::channel::<Result<LoopbackMode, AudioEngineError>>();

        let handle = thread::Builder::new()
            .name("cafofo-wasapi-loopback".to_string())
            .spawn(move || unsafe {
                let com_hr = CoInitializeEx(None, COINIT_MULTITHREADED);
                let initialized_com = com_hr.is_ok();

                let activation = activate_process_loopback(config.target_pid).or_else(|err| {
                    if config.allow_standard_fallback {
                        tracing::warn!(
                            pid = config.target_pid,
                            %err,
                            "process-isolated loopback unavailable; falling back to standard render loopback"
                        );
                        activate_standard_loopback().map(|c| (c, LoopbackMode::StandardSystemFallback))
                    } else {
                        Err(err)
                    }
                });

                let (audio_client, _mode) = match activation {
                    Ok(res) => {
                        let _ = mode_tx.send(Ok(res.1));
                        res
                    }
                    Err(err) => {
                        let _ = mode_tx.send(Err(err));
                        if initialized_com {
                            CoUninitialize();
                        }
                        return;
                    }
                };

                run_capture_loop(&audio_client, &mut producer, &stop_flag);

                if initialized_com {
                    CoUninitialize();
                }
            })
            .map_err(|e| AudioEngineError::Backend(format!("failed to spawn loopback thread: {e}")))?;

        let mode = mode_rx
            .recv()
            .map_err(|_| AudioEngineError::Backend("loopback initialization channel closed".into()))??;

        Ok((mode, handle))
    }

    unsafe fn activate_process_loopback(
        target_pid: u32,
    ) -> Result<(IAudioClient, LoopbackMode), AudioEngineError> {
        let mut activation_params = AUDIOCLIENT_ACTIVATION_PARAMS {
            ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
            Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
                ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                    TargetProcessId: target_pid,
                    ProcessLoopbackMode: PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE,
                },
            },
        };

        let raw_prop = RawBlobPropVariant {
            vt: VT_BLOB.0,
            w_reserved1: 0,
            w_reserved2: 0,
            w_reserved3: 0,
            cb_size: size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32,
            #[cfg(target_pointer_width = "64")]
            _pad: 0,
            p_blob_data: (&mut activation_params as *mut AUDIOCLIENT_ACTIVATION_PARAMS).cast::<u8>(),
        };

        let state = Arc::new((Mutex::new(None::<HRESULT>), Condvar::new()));
        let handler: IActivateAudioInterfaceCompletionHandler = ActivationCompletionHandler {
            state: Arc::clone(&state),
        }
        .into();

        let operation = ActivateAudioInterfaceAsync(
            VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
            &IAudioClient::IID,
            Some((&raw_prop as *const RawBlobPropVariant).cast::<PROPVARIANT>()),
            &handler,
        )
        .map_err(|e| AudioEngineError::Backend(format!("ActivateAudioInterfaceAsync failed: {e}")))?;

        let (lock, cvar) = &*state;
        let mut guard = lock
            .lock()
            .map_err(|_| AudioEngineError::Backend("activation mutex poisoned".into()))?;
        while guard.is_none() {
            let (g, timeout) = cvar
                .wait_timeout(guard, Duration::from_secs(3))
                .map_err(|_| AudioEngineError::Backend("activation condvar poisoned".into()))?;
            guard = g;
            if timeout.timed_out() && guard.is_none() {
                return Err(AudioEngineError::Backend(
                    "ActivateAudioInterfaceAsync timed out".into(),
                ));
            }
        }

        let mut activate_hr = S_OK;
        let mut unk: Option<IUnknown> = None;
        operation
            .GetActivateResult(&mut activate_hr, &mut unk)
            .map_err(|e| AudioEngineError::Backend(format!("GetActivateResult failed: {e}")))?;
        activate_hr
            .ok()
            .map_err(|e| AudioEngineError::Backend(format!("process loopback activation error: {e}")))?;

        let client = unk
            .ok_or_else(|| AudioEngineError::Backend("missing IAudioClient from activation".into()))?
            .cast::<IAudioClient>()
            .map_err(|e| AudioEngineError::Backend(format!("cast to IAudioClient failed: {e}")))?;

        initialize_pcm_48k_client(&client, AUDCLNT_STREAMFLAGS_LOOPBACK)?;
        Ok((client, LoopbackMode::ProcessTreeIsolated))
    }

    unsafe fn activate_standard_loopback() -> Result<IAudioClient, AudioEngineError> {
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
                .map_err(|e| AudioEngineError::Backend(format!("MMDeviceEnumerator failed: {e}")))?;
        let device = enumerator
            .GetDefaultAudioEndpoint(eRender, eConsole)
            .map_err(|e| AudioEngineError::Backend(format!("GetDefaultAudioEndpoint failed: {e}")))?;
        let client: IAudioClient = device
            .Activate(CLSCTX_ALL, None)
            .map_err(|e| AudioEngineError::Backend(format!("IMMDevice::Activate failed: {e}")))?;

        initialize_pcm_48k_client(&client, AUDCLNT_STREAMFLAGS_LOOPBACK)?;
        Ok(client)
    }

    unsafe fn initialize_pcm_48k_client(
        client: &IAudioClient,
        extra_flags: u32,
    ) -> Result<(), AudioEngineError> {
        let channels = LOOPBACK_CHANNELS as u16;
        let bits_per_sample = 16u16;
        let block_align = channels * (bits_per_sample / 8);
        let format = WAVEFORMATEX {
            wFormatTag: WAVE_FORMAT_PCM as u16,
            nChannels: channels,
            nSamplesPerSec: TARGET_SAMPLE_RATE_HZ,
            nAvgBytesPerSec: TARGET_SAMPLE_RATE_HZ * u32::from(block_align),
            nBlockAlign: block_align,
            wBitsPerSample: bits_per_sample,
            cbSize: 0,
        };

        // 20 ms buffer in 100 ns units
        let buffer_duration_hns = 200_000i64;
        let flags = extra_flags
            | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
            | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;

        client
            .Initialize(
                AUDCLNT_SHAREMODE_SHARED,
                flags,
                buffer_duration_hns,
                0,
                &format,
                None,
            )
            .map_err(|e| AudioEngineError::Backend(format!("IAudioClient::Initialize failed: {e}")))?;

        Ok(())
    }

    unsafe fn run_capture_loop(
        client: &IAudioClient,
        producer: &mut HeapProd<i16>,
        stop_flag: &AtomicBool,
    ) {
        let capture_client: IAudioCaptureClient = match client.GetService() {
            Ok(c) => c,
            Err(err) => {
                tracing::error!(%err, "failed to get IAudioCaptureClient");
                return;
            }
        };

        if let Err(err) = client.Start() {
            tracing::error!(%err, "failed to start WASAPI loopback client");
            return;
        }

        let silence_frame = [0i16; SILENCE_FRAME_SAMPLES];
        let mut last_audio_at = Instant::now();

        while !stop_flag.load(Ordering::Relaxed) {
            let mut packet_frames = match capture_client.GetNextPacketSize() {
                Ok(n) => n,
                Err(_) => 0,
            };

            let mut pushed_any = false;

            while packet_frames > 0 && !stop_flag.load(Ordering::Relaxed) {
                let mut data_ptr: *mut u8 = ptr::null_mut();
                let mut num_frames = 0u32;
                let mut flags = 0u32;

                if capture_client
                    .GetBuffer(&mut data_ptr, &mut num_frames, &mut flags, None, None)
                    .is_err()
                {
                    break;
                }

                let sample_count = num_frames as usize * LOOPBACK_CHANNELS;
                if (flags & (AUDCLNT_BUFFERFLAGS_SILENT.0 as u32)) != 0 || data_ptr.is_null() {
                    // Explicit silence injection when game/process outputs silent frames
                    let mut remaining = sample_count;
                    while remaining > 0 {
                        let chunk = remaining.min(SILENCE_FRAME_SAMPLES);
                        let _ = producer.push_slice(&silence_frame[..chunk]);
                        remaining -= chunk;
                    }
                } else if sample_count > 0 {
                    let pcm_slice = std::slice::from_raw_parts(
                        data_ptr as *const c_void as *const i16,
                        sample_count,
                    );
                    let _ = producer.push_slice(pcm_slice);
                }

                let _ = capture_client.ReleaseBuffer(num_frames);
                pushed_any = true;
                last_audio_at = Instant::now();

                packet_frames = capture_client.GetNextPacketSize().unwrap_or(0);
            }

            // Inject 10ms silence frame if process is completely quiet so WebRTC pacing stays steady
            if !pushed_any && last_audio_at.elapsed() >= Duration::from_millis(10) {
                let _ = producer.push_slice(&silence_frame);
                last_audio_at = Instant::now();
            }

            thread::sleep(Duration::from_millis(4));
        }

        let _ = client.Stop();
    }
}
