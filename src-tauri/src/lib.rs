use once_cell::sync::Lazy;
use rdev::{listen, EventType};
use serde::Serialize;
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    thread,
    time::Instant,
};
use tauri::{AppHandle, Emitter};

static SAMPLER: Lazy<NativeSampler> = Lazy::new(NativeSampler::default);

#[derive(Default)]
struct NativeSampler {
    started: AtomicBool,
    emitting: AtomicBool,
    last_event_at: Mutex<Option<Instant>>,
    #[cfg(target_os = "macos")]
    last_hid_timestamp: Mutex<Option<u64>>,
    source: Mutex<&'static str>,
}

#[derive(Clone, Serialize)]
struct NativeSample {
    source: &'static str,
    interval_ms: f64,
    movement: f64,
}

#[derive(Clone, Serialize)]
struct NativeStatus {
    source: &'static str,
    running: bool,
    message: String,
}

impl NativeSampler {
    fn start(&self, app: AppHandle) -> Result<NativeStatus, String> {
        self.emitting.store(true, Ordering::SeqCst);
        *self
            .last_event_at
            .lock()
            .map_err(|_| "native sampler lock poisoned".to_string())? = None;
        #[cfg(target_os = "macos")]
        {
            *self
                .last_hid_timestamp
                .lock()
                .map_err(|_| "native sampler lock poisoned".to_string())? = None;
        }

        if !self.started.swap(true, Ordering::SeqCst) {
            start_platform_sampler(app.clone());
        }

        let source = self.current_source();
        app.emit(
            "native-status",
            NativeStatus {
                source,
                running: true,
                message: "native sampler running".to_string(),
            },
        )
        .map_err(|error| error.to_string())?;

        Ok(NativeStatus {
            source,
            running: true,
            message: "native sampler running".to_string(),
        })
    }

    fn stop(&self) -> NativeStatus {
        self.emitting.store(false, Ordering::SeqCst);
        if let Ok(mut last) = self.last_event_at.lock() {
            *last = None;
        }

        NativeStatus {
            source: self.current_source(),
            running: false,
            message: "native sampler stopped".to_string(),
        }
    }

    fn set_source(&self, source: &'static str) {
        if let Ok(mut current) = self.source.lock() {
            *current = source;
        }
    }

    fn current_source(&self) -> &'static str {
        self.source
            .lock()
            .map(|source| *source)
            .unwrap_or("native-unknown")
    }
}

fn emit_interval(app: &AppHandle, source: &'static str, interval_ms: f64, movement: f64) {
    if interval_ms > 0.0 && interval_ms < 1000.0 {
        let _ = app.emit(
            "native-sample",
            NativeSample {
                source,
                interval_ms,
                movement,
            },
        );
    }
}

fn start_platform_sampler(app: AppHandle) {
    #[cfg(target_os = "macos")]
    {
        if macos_iohid::start(app.clone()).is_ok() {
            return;
        }
    }

    start_rdev_fallback(app);
}

fn start_rdev_fallback(app: AppHandle) {
    SAMPLER.set_source("native-rdev-fallback");
    thread::spawn(move || {
        let app_for_events = app.clone();
        let result = listen(move |event| {
            if !SAMPLER.emitting.load(Ordering::SeqCst) {
                return;
            }

            let movement = match event.event_type {
                EventType::MouseMove { .. } => 1.0,
                EventType::Wheel { delta_x, delta_y } => {
                    delta_x.abs() as f64 + delta_y.abs() as f64
                }
                _ => return,
            };

            let now = Instant::now();
            let interval_ms = {
                let mut last = match SAMPLER.last_event_at.lock() {
                    Ok(last) => last,
                    Err(_) => return,
                };
                let interval = last.map(|value| now.duration_since(value).as_secs_f64() * 1000.0);
                *last = Some(now);
                interval
            };

            if let Some(interval_ms) = interval_ms {
                emit_interval(
                    &app_for_events,
                    "native-rdev-fallback",
                    interval_ms,
                    movement,
                );
            }
        });

        if let Err(error) = result {
            let _ = app.emit(
                "native-status",
                NativeStatus {
                    source: "native-rdev-fallback",
                    running: false,
                    message: format!("native sampler failed: {error:?}"),
                },
            );
        }
    });
}

#[cfg(target_os = "macos")]
mod macos_iohid {
    use super::{emit_interval, NativeStatus, SAMPLER};
    use std::{ffi::c_void, sync::OnceLock, thread, time::Instant};
    use tauri::{AppHandle, Emitter};

    type CFAllocatorRef = *const c_void;
    type CFIndex = isize;
    type CFOptionFlags = u64;
    type CFRunLoopRef = *mut c_void;
    type CFStringRef = *const c_void;
    type CFMutableDictionaryRef = *mut c_void;
    type CFNumberRef = *const c_void;
    type IOHIDManagerRef = *mut c_void;
    type IOReturn = i32;
    type IOHIDReportType = i32;

    #[repr(C)]
    struct CFDictionaryKeyCallBacks {
        version: CFIndex,
        retain: *const c_void,
        release: *const c_void,
        copy_description: *const c_void,
        equal: *const c_void,
        hash: *const c_void,
    }

    #[repr(C)]
    struct CFDictionaryValueCallBacks {
        version: CFIndex,
        retain: *const c_void,
        release: *const c_void,
        copy_description: *const c_void,
        equal: *const c_void,
    }

    const K_IO_RETURN_SUCCESS: IOReturn = 0;
    const K_CF_NUMBER_SINT32_TYPE: CFIndex = 3;
    const K_CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;
    const K_HID_PAGE_GENERIC_DESKTOP: i32 = 0x01;
    const K_HID_USAGE_GD_MOUSE: i32 = 0x02;

    #[repr(C)]
    struct MachTimebaseInfo {
        numer: u32,
        denom: u32,
    }

    extern "C" {
        fn mach_timebase_info(info: *mut MachTimebaseInfo) -> i32;

        static kCFAllocatorDefault: CFAllocatorRef;
        static kCFRunLoopDefaultMode: CFStringRef;
        static kCFTypeDictionaryKeyCallBacks: CFDictionaryKeyCallBacks;
        static kCFTypeDictionaryValueCallBacks: CFDictionaryValueCallBacks;

        fn CFDictionaryCreateMutable(
            allocator: CFAllocatorRef,
            capacity: CFIndex,
            key_callbacks: *const c_void,
            value_callbacks: *const c_void,
        ) -> CFMutableDictionaryRef;
        fn CFDictionarySetValue(
            dictionary: CFMutableDictionaryRef,
            key: *const c_void,
            value: *const c_void,
        );
        fn CFNumberCreate(
            allocator: CFAllocatorRef,
            the_type: CFIndex,
            value_ptr: *const c_void,
        ) -> CFNumberRef;
        fn CFStringCreateWithCString(
            allocator: CFAllocatorRef,
            c_str: *const i8,
            encoding: u32,
        ) -> CFStringRef;
        fn CFRelease(value: *const c_void);
        fn CFRunLoopGetCurrent() -> CFRunLoopRef;
        fn CFRunLoopRun();

        fn IOHIDManagerCreate(allocator: CFAllocatorRef, options: CFOptionFlags)
            -> IOHIDManagerRef;
        fn IOHIDManagerOpen(manager: IOHIDManagerRef, options: CFOptionFlags) -> IOReturn;
        fn IOHIDManagerSetDeviceMatching(manager: IOHIDManagerRef, matching: *const c_void);
        fn IOHIDManagerScheduleWithRunLoop(
            manager: IOHIDManagerRef,
            run_loop: CFRunLoopRef,
            run_loop_mode: CFStringRef,
        );
        fn IOHIDManagerRegisterInputReportWithTimeStampCallback(
            manager: IOHIDManagerRef,
            callback: Option<InputReportCallback>,
            context: *mut c_void,
        );
    }

    type InputReportCallback = unsafe extern "C" fn(
        context: *mut c_void,
        result: IOReturn,
        sender: *mut c_void,
        report_type: IOHIDReportType,
        report_id: u32,
        report: *mut u8,
        report_length: CFIndex,
        timestamp: u64,
    );

    static TIMEBASE: OnceLock<(f64, f64)> = OnceLock::new();

    pub fn start(app: AppHandle) -> Result<(), String> {
        SAMPLER.set_source("native-iohid-report");

        thread::Builder::new()
            .name("mousex-iohid".to_string())
            .spawn(move || {
                if let Err(error) = run(app.clone()) {
                    let _ = app.emit(
                        "native-status",
                        NativeStatus {
                            source: "native-iohid-report",
                            running: false,
                            message: format!(
                                "IOHID report sampler failed, fallback may be needed: {error}"
                            ),
                        },
                    );
                    super::start_rdev_fallback(app);
                }
            })
            .map_err(|error| error.to_string())?;

        Ok(())
    }

    fn run(app: AppHandle) -> Result<(), String> {
        let manager = unsafe { IOHIDManagerCreate(kCFAllocatorDefault, 0) };
        if manager.is_null() {
            return Err("IOHIDManagerCreate returned null".to_string());
        }

        let matching = create_mouse_matching_dictionary()?;
        unsafe {
            IOHIDManagerSetDeviceMatching(manager, matching.cast_const());
            CFRelease(matching.cast_const());
        }

        let open_result = unsafe { IOHIDManagerOpen(manager, 0) };
        if open_result != K_IO_RETURN_SUCCESS {
            unsafe {
                CFRelease(manager.cast_const());
            }
            return Err(format!("IOHIDManagerOpen failed: {open_result}"));
        }

        let run_loop = unsafe { CFRunLoopGetCurrent() };
        if run_loop.is_null() {
            return Err("CFRunLoopGetCurrent returned null".to_string());
        }

        let app_context = Box::into_raw(Box::new(app.clone()));
        unsafe {
            IOHIDManagerScheduleWithRunLoop(manager, run_loop, kCFRunLoopDefaultMode);
            IOHIDManagerRegisterInputReportWithTimeStampCallback(
                manager,
                Some(input_report_callback),
                app_context.cast(),
            );
        }

        let _ = app.emit(
            "native-status",
            NativeStatus {
                source: "native-iohid-report",
                running: true,
                message: "IOHID report sampler running".to_string(),
            },
        );

        unsafe {
            CFRunLoopRun();
        }

        Ok(())
    }

    fn create_mouse_matching_dictionary() -> Result<CFMutableDictionaryRef, String> {
        let dictionary = unsafe {
            CFDictionaryCreateMutable(
                kCFAllocatorDefault,
                0,
                (&kCFTypeDictionaryKeyCallBacks as *const CFDictionaryKeyCallBacks).cast(),
                (&kCFTypeDictionaryValueCallBacks as *const CFDictionaryValueCallBacks).cast(),
            )
        };
        if dictionary.is_null() {
            return Err("CFDictionaryCreateMutable returned null".to_string());
        }

        let usage_page = K_HID_PAGE_GENERIC_DESKTOP;
        let usage = K_HID_USAGE_GD_MOUSE;
        let usage_page_number = unsafe {
            CFNumberCreate(
                kCFAllocatorDefault,
                K_CF_NUMBER_SINT32_TYPE,
                (&usage_page as *const i32).cast(),
            )
        };
        let usage_number = unsafe {
            CFNumberCreate(
                kCFAllocatorDefault,
                K_CF_NUMBER_SINT32_TYPE,
                (&usage as *const i32).cast(),
            )
        };

        if usage_page_number.is_null() || usage_number.is_null() {
            unsafe {
                if !usage_page_number.is_null() {
                    CFRelease(usage_page_number.cast());
                }
                if !usage_number.is_null() {
                    CFRelease(usage_number.cast());
                }
                CFRelease(dictionary.cast_const());
            }
            return Err("CFNumberCreate returned null".to_string());
        }

        let usage_page_key = cf_string("DeviceUsagePage\0")?;
        let usage_key = cf_string("DeviceUsage\0")?;

        unsafe {
            CFDictionarySetValue(dictionary, usage_page_key.cast(), usage_page_number.cast());
            CFDictionarySetValue(dictionary, usage_key.cast(), usage_number.cast());
            CFRelease(usage_page_key.cast());
            CFRelease(usage_key.cast());
            CFRelease(usage_page_number.cast());
            CFRelease(usage_number.cast());
        }

        Ok(dictionary)
    }

    fn cf_string(value: &'static str) -> Result<CFStringRef, String> {
        let cf_value = unsafe {
            CFStringCreateWithCString(
                kCFAllocatorDefault,
                value.as_ptr().cast(),
                K_CF_STRING_ENCODING_UTF8,
            )
        };
        if cf_value.is_null() {
            Err(format!("CFStringCreateWithCString failed for {value:?}"))
        } else {
            Ok(cf_value)
        }
    }

    unsafe extern "C" fn input_report_callback(
        context: *mut c_void,
        result: IOReturn,
        _sender: *mut c_void,
        _report_type: IOHIDReportType,
        _report_id: u32,
        _report: *mut u8,
        _report_length: CFIndex,
        timestamp: u64,
    ) {
        if context.is_null()
            || result != K_IO_RETURN_SUCCESS
            || !SAMPLER.emitting.load(std::sync::atomic::Ordering::SeqCst)
        {
            return;
        }

        let app = &*(context.cast::<AppHandle>());
        let interval_ms = if timestamp > 0 {
            let mut last = match SAMPLER.last_hid_timestamp.lock() {
                Ok(last) => last,
                Err(_) => return,
            };
            let interval = last.and_then(|previous| timestamp_delta_ms(previous, timestamp));
            *last = Some(timestamp);
            interval
        } else {
            let now = Instant::now();
            let mut last = match SAMPLER.last_event_at.lock() {
                Ok(last) => last,
                Err(_) => return,
            };
            let interval = last.map(|value| now.duration_since(value).as_secs_f64() * 1000.0);
            *last = Some(now);
            interval
        };

        if let Some(interval_ms) = interval_ms {
            emit_interval(app, "native-iohid-report", interval_ms, 1.0);
        }
    }

    fn timestamp_delta_ms(previous: u64, current: u64) -> Option<f64> {
        if current <= previous {
            return None;
        }

        let (numer, denom) = *TIMEBASE.get_or_init(|| {
            let mut info = MachTimebaseInfo { numer: 1, denom: 1 };
            let result = unsafe { mach_timebase_info(&mut info) };
            if result == 0 && info.denom != 0 {
                (f64::from(info.numer), f64::from(info.denom))
            } else {
                (1.0, 1.0)
            }
        });

        let nanos = (current - previous) as f64 * numer / denom;
        Some(nanos / 1_000_000.0)
    }
}

#[tauri::command]
fn start_native_sampling(app: AppHandle) -> Result<NativeStatus, String> {
    SAMPLER.start(app)
}

#[tauri::command]
fn stop_native_sampling() -> NativeStatus {
    SAMPLER.stop()
}

#[tauri::command]
fn native_sampler_info() -> NativeStatus {
    NativeStatus {
        source: SAMPLER.current_source(),
        running: SAMPLER.emitting.load(Ordering::SeqCst),
        message: "Rust native sampler is available. macOS uses IOHID input report callbacks when possible; other platforms currently use the rdev fallback.".to_string(),
    }
}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            native_sampler_info,
            start_native_sampling,
            stop_native_sampling
        ])
        .run(tauri::generate_context!())
        .expect("error while running MouseX");
}
