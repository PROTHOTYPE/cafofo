use std::sync::mpsc;

use crate::{CaptureConfig, CapturedVideoFrame, ScreenCaptureError};

pub struct WindowCaptureHandle {
    pub frames: mpsc::Receiver<CapturedVideoFrame>,
    stop_tx: Option<std::sync::mpsc::Sender<()>>,
    worker: Option<std::thread::JoinHandle<()>>,
}

impl WindowCaptureHandle {
    pub fn stop(&mut self) {
        if let Some(tx) = self.stop_tx.take() {
            let _ = tx.send(());
        }
        if let Some(handle) = self.worker.take() {
            let _ = handle.join();
        }
    }
}

impl Drop for WindowCaptureHandle {
    fn drop(&mut self) {
        self.stop();
    }
}

pub struct WgcWindowCapturer;

impl WgcWindowCapturer {
    pub fn is_supported() -> bool {
        #[cfg(target_os = "windows")]
        {
            windows::Graphics::Capture::GraphicsCaptureSession::IsSupported().unwrap_or(false)
        }
        #[cfg(not(target_os = "windows"))]
        {
            false
        }
    }

    /// Starts an isolated `Windows.Graphics.Capture` session for the specified `hwnd`.
    /// Delivers tightly packed BGRA8 frames over a bounded channel without capturing
    /// overlapping windows.
    pub fn start_window(
        hwnd: isize,
        config: CaptureConfig,
    ) -> Result<WindowCaptureHandle, ScreenCaptureError> {
        #[cfg(target_os = "windows")]
        {
            windows_impl::start(hwnd, config)
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = (hwnd, config);
            Err(ScreenCaptureError::UnsupportedPlatform)
        }
    }
}

#[cfg(target_os = "windows")]
mod windows_impl {
    use std::ffi::c_void;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{mpsc, Arc};
    use std::thread;
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

    use windows::core::{factory, Interface};
    use windows::Foundation::TypedEventHandler;
    use windows::Graphics::Capture::{
        Direct3D11CaptureFramePool, GraphicsCaptureItem, GraphicsCaptureSession,
    };
    use windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
    use windows::Graphics::DirectX::DirectXPixelFormat;
    use windows::Graphics::SizeInt32;
    use windows::Win32::Foundation::{HWND, LPARAM};
    use windows::Win32::Graphics::Direct3D::{
        D3D_DRIVER_TYPE_HARDWARE, D3D_FEATURE_LEVEL_11_0,
    };
    use windows::Win32::Graphics::Direct3D11::{
        D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D,
        D3D11_CPU_ACCESS_READ, D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_MAP_READ,
        D3D11_MAPPED_SUBRESOURCE, D3D11_SDK_VERSION, D3D11_TEXTURE2D_DESC, D3D11_USAGE_STAGING,
    };
    use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC};
    use windows::Win32::Graphics::Dxgi::IDXGIDevice;
    use windows::Win32::System::WinRT::Direct3D11::{
        CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess,
    };
    use windows::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;
    use windows::Win32::System::WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED};

    use super::WindowCaptureHandle;
    use crate::{CaptureConfig, CapturedVideoFrame, PixelFormat, ScreenCaptureError};

    pub fn start(
        hwnd_raw: isize,
        config: CaptureConfig,
    ) -> Result<WindowCaptureHandle, ScreenCaptureError> {
        let (frame_tx, frame_rx) = mpsc::sync_channel::<CapturedVideoFrame>(2);
        let (stop_tx, stop_rx) = mpsc::channel::<()>();
        let (init_tx, init_rx) = mpsc::channel::<Result<(), ScreenCaptureError>>();

        let worker = thread::Builder::new()
            .name(format!("cafofo-wgc-{hwnd_raw}"))
            .spawn(move || unsafe {
                let ro_hr = RoInitialize(RO_INIT_MULTITHREADED);
                let init_res = run_wgc_session(hwnd_raw, config, frame_tx, stop_rx, init_tx.clone());
                if let Err(err) = init_res {
                    let _ = init_tx.send(Err(err));
                }
                if ro_hr.is_ok() {
                    RoUninitialize();
                }
            })
            .map_err(|e| ScreenCaptureError::Backend(format!("failed to spawn WGC thread: {e}")))?;

        init_rx
            .recv()
            .map_err(|_| ScreenCaptureError::Backend("WGC initialization channel closed".into()))??;

        Ok(WindowCaptureHandle {
            frames: frame_rx,
            stop_tx: Some(stop_tx),
            worker: Some(worker),
        })
    }

    unsafe fn run_wgc_session(
        hwnd_raw: isize,
        config: CaptureConfig,
        frame_tx: mpsc::SyncSender<CapturedVideoFrame>,
        stop_rx: mpsc::Receiver<()>,
        init_tx: mpsc::Sender<Result<(), ScreenCaptureError>>,
    ) -> Result<(), ScreenCaptureError> {
        let (d3d_device, d3d_context) = create_d3d11_device()?;
        let dxgi_device: IDXGIDevice = d3d_device
            .cast()
            .map_err(|e| ScreenCaptureError::Backend(format!("IDXGIDevice cast failed: {e}")))?;
        let winrt_device: IDirect3DDevice = CreateDirect3D11DeviceFromDXGIDevice(&dxgi_device)
            .map_err(|e| {
                ScreenCaptureError::Backend(format!(
                    "CreateDirect3D11DeviceFromDXGIDevice failed: {e}"
                ))
            })?
            .cast()
            .map_err(|e| ScreenCaptureError::Backend(format!("IDirect3DDevice cast failed: {e}")))?;

        let hwnd = HWND(hwnd_raw as *mut c_void);
        let interop = factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>().map_err(|e| {
            ScreenCaptureError::Backend(format!("IGraphicsCaptureItemInterop unavailable: {e}"))
        })?;

        let item: GraphicsCaptureItem = interop
            .CreateForWindow(hwnd)
            .map_err(|e| ScreenCaptureError::TargetNotFound(format!("HWND {hwnd_raw}: {e}")))?;

        let mut current_size = item
            .Size()
            .map_err(|e| ScreenCaptureError::Backend(format!("GraphicsCaptureItem::Size: {e}")))?;
        if current_size.Width <= 0 || current_size.Height <= 0 {
            current_size = SizeInt32 {
                Width: 1280,
                Height: 720,
            };
        }

        let frame_pool = Direct3D11CaptureFramePool::CreateFreeThreaded(
            &winrt_device,
            DirectXPixelFormat::B8G8R8A8UIntNormalized,
            2,
            current_size,
        )
        .map_err(|e| ScreenCaptureError::Backend(format!("CreateFreeThreaded failed: {e}")))?;

        let session: GraphicsCaptureSession = frame_pool
            .CreateCaptureSession(&item)
            .map_err(|e| ScreenCaptureError::Backend(format!("CreateCaptureSession failed: {e}")))?;

        let _ = session.SetIsCursorCaptureEnabled(config.capture_cursor);
        let _ = session.SetIsBorderRequired(config.draw_border);

        let closed_flag = Arc::new(AtomicBool::new(false));
        let closed_flag_cb = Arc::clone(&closed_flag);
        let _ = item.Closed(&TypedEventHandler::<GraphicsCaptureItem, _>::new(
            move |_, _| {
                closed_flag_cb.store(true, Ordering::Relaxed);
                Ok(())
            },
        ));

        let (notify_tx, notify_rx) = mpsc::sync_channel::<()>(1);
        frame_pool
            .FrameArrived(&TypedEventHandler::<Direct3D11CaptureFramePool, _>::new(
                move |_, _| {
                    let _ = notify_tx.try_send(());
                    Ok(())
                },
            ))
            .map_err(|e| ScreenCaptureError::Backend(format!("FrameArrived subscribe failed: {e}")))?;

        session
            .StartCapture()
            .map_err(|e| ScreenCaptureError::Backend(format!("StartCapture failed: {e}")))?;

        let _ = init_tx.send(Ok(()));

        let min_frame_interval =
            Duration::from_secs_f64(1.0 / f64::from(config.target_fps.clamp(5, 120)));
        let mut last_emit = Instant::now() - min_frame_interval;
        let mut staging: Option<(ID3D11Texture2D, u32, u32)> = None;

        loop {
            if stop_rx.try_recv().is_ok() || closed_flag.load(Ordering::Relaxed) {
                break;
            }

            // Wait briefly for a frame arrival notification so stop checks stay responsive
            let _ = notify_rx.recv_timeout(Duration::from_millis(25));

            while let Ok(frame) = frame_pool.TryGetNextFrame() {
                if stop_rx.try_recv().is_ok() || closed_flag.load(Ordering::Relaxed) {
                    break;
                }

                let content_size = frame.ContentSize().unwrap_or(current_size);
                if content_size.Width > 0
                    && content_size.Height > 0
                    && (content_size.Width != current_size.Width
                        || content_size.Height != current_size.Height)
                {
                    current_size = content_size;
                    let _ = frame_pool.Recreate(
                        &winrt_device,
                        DirectXPixelFormat::B8G8R8A8UIntNormalized,
                        2,
                        current_size,
                    );
                    staging = None;
                }

                if last_emit.elapsed() < min_frame_interval {
                    continue;
                }

                let Ok(surface) = frame.Surface() else {
                    continue;
                };
                let Ok(access) = surface.cast::<IDirect3DDxgiInterfaceAccess>() else {
                    continue;
                };
                let Ok(texture) = access.GetInterface::<ID3D11Texture2D>() else {
                    continue;
                };

                if let Some(captured) = copy_texture_to_bgra(
                    &d3d_device,
                    &d3d_context,
                    &texture,
                    &mut staging,
                ) {
                    last_emit = Instant::now();
                    // Drop oldest if consumer is slower than capture FPS
                    let _ = frame_tx.try_send(captured);
                }
            }
        }

        let _ = session.Close();
        let _ = frame_pool.Close();
        let _ = LPARAM(0);
        Ok(())
    }

    unsafe fn create_d3d11_device() -> Result<(ID3D11Device, ID3D11DeviceContext), ScreenCaptureError>
    {
        let mut device: Option<ID3D11Device> = None;
        let mut context: Option<ID3D11DeviceContext> = None;
        let feature_levels = [D3D_FEATURE_LEVEL_11_0];

        D3D11CreateDevice(
            None,
            D3D_DRIVER_TYPE_HARDWARE,
            None,
            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            Some(&feature_levels),
            D3D11_SDK_VERSION,
            Some(&mut device),
            None,
            Some(&mut context),
        )
        .map_err(|e| ScreenCaptureError::Backend(format!("D3D11CreateDevice failed: {e}")))?;

        match (device, context) {
            (Some(d), Some(c)) => Ok((d, c)),
            _ => Err(ScreenCaptureError::Backend(
                "D3D11CreateDevice returned null device or context".into(),
            )),
        }
    }

    unsafe fn copy_texture_to_bgra(
        device: &ID3D11Device,
        context: &ID3D11DeviceContext,
        source: &ID3D11Texture2D,
        staging_cache: &mut Option<(ID3D11Texture2D, u32, u32)>,
    ) -> Option<CapturedVideoFrame> {
        let mut desc = D3D11_TEXTURE2D_DESC::default();
        source.GetDesc(&mut desc);
        if desc.Width == 0 || desc.Height == 0 {
            return None;
        }

        let needs_new_staging = match staging_cache {
            Some((_, w, h)) => *w != desc.Width || *h != desc.Height,
            None => true,
        };

        if needs_new_staging {
            let staging_desc = D3D11_TEXTURE2D_DESC {
                Width: desc.Width,
                Height: desc.Height,
                MipLevels: 1,
                ArraySize: 1,
                Format: DXGI_FORMAT_B8G8R8A8_UNORM,
                SampleDesc: DXGI_SAMPLE_DESC {
                    Count: 1,
                    Quality: 0,
                },
                Usage: D3D11_USAGE_STAGING,
                BindFlags: 0,
                CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
                MiscFlags: 0,
            };

            let mut tex: Option<ID3D11Texture2D> = None;
            device
                .CreateTexture2D(&staging_desc, None, Some(&mut tex))
                .ok()?;
            *staging_cache = Some((tex?, desc.Width, desc.Height));
        }

        let (staging_tex, width, height) = staging_cache.as_ref()?;
        context.CopyResource(staging_tex, source);

        let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
        context
            .Map(staging_tex, 0, D3D11_MAP_READ, 0, Some(&mut mapped))
            .ok()?;

        let row_bytes = (*width as usize) * 4;
        let row_pitch = mapped.RowPitch as usize;
        let mut bgra = vec![0u8; row_bytes * (*height as usize)];

        let src_ptr = mapped.pData as *const u8;
        for y in 0..(*height as usize) {
            let src_row = std::slice::from_raw_parts(src_ptr.add(y * row_pitch), row_bytes);
            let dst_row = &mut bgra[y * row_bytes..(y + 1) * row_bytes];
            dst_row.copy_from_slice(src_row);
        }

        context.Unmap(staging_tex, 0);

        let timestamp_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);

        Some(CapturedVideoFrame {
            width: *width,
            height: *height,
            timestamp_ms,
            pixel_format: PixelFormat::Bgra8,
            bgra,
        })
    }
}
