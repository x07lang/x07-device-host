use std::borrow::Cow;
use std::cell::RefCell;
use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use arboard::Clipboard;
use clap::{Args, Parser, Subcommand};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::Digest as _;
use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoop, EventLoopBuilder, EventLoopProxy};
use tao::window::WindowBuilder;
use wry::http::{Method, Request, Response, StatusCode};
use wry::WebViewBuilder;

mod telemetry;

const BUNDLE_MANIFEST_FILE: &str = "bundle.manifest.json";
const APP_MANIFEST_FILE: &str = "app.manifest.json";
const RUN_REPORT_SCHEMA_VERSION: &str = "x07.wasm.device.run.report@0.1.0";
const RUN_REPORT_COMMAND: &str = "x07-wasm.device.run";
const EXPECTED_BUNDLE_SCHEMA_VERSION: &str = "x07.device.bundle.manifest@0.1.0";
const EXPECTED_UI_WASM_PATH: &str = "ui/reducer.wasm";
const JSON_CONTENT_TYPE: &str = "application/json; charset=utf-8";

#[derive(Debug, Clone, Parser)]
#[command(name = "x07-device-host-desktop")]
#[command(version)]
#[command(about = "System-WebView desktop host for x07 device bundles.")]
struct Cli {
    /// Print the current host ABI hash (hex) and exit 0.
    #[arg(long, global = true)]
    host_abi_hash: bool,

    #[command(subcommand)]
    cmd: Option<Command>,
}

#[derive(Debug, Clone, Subcommand)]
enum Command {
    Run(RunArgs),
}

#[derive(Debug, Clone, Args)]
struct RunArgs {
    /// Directory containing the device bundle (bundle.manifest.json, ui/reducer.wasm, ...).
    #[arg(long, value_name = "DIR")]
    bundle: Option<PathBuf>,

    /// Launch the webview, wait briefly, then exit with a machine report.
    #[arg(long)]
    headless_smoke: bool,

    /// Emit a single JSON report to stdout.
    #[arg(long)]
    json: bool,
}

#[derive(Debug, Clone, Deserialize)]
struct BundleManifestDoc {
    schema_version: String,
    #[serde(default)]
    profile: Option<BundleProfileRef>,
    #[serde(default)]
    capabilities: Option<BundleManifestFile>,
    #[serde(default)]
    telemetry_profile: Option<BundleManifestFile>,
    host: BundleHostDoc,
    ui_wasm: BundleManifestFile,
}

#[derive(Debug, Clone, Deserialize)]
struct BundleHostDoc {
    host_abi_hash: String,
}

#[derive(Debug, Clone, Deserialize)]
#[allow(dead_code)]
struct BundleProfileRef {
    id: String,
    v: u64,
    file: BundleManifestFile,
}

#[derive(Debug, Clone, Deserialize)]
struct BundleManifestFile {
    path: String,
    sha256: String,
    bytes_len: u64,
}

#[derive(Debug, Clone)]
enum UserEvent {
    UiReady,
    UiError,
    Timeout,
    DispatchScript(String),
    FlushDroppedFiles(u64),
}

#[derive(Debug, Clone, Serialize)]
struct ToolMeta {
    name: &'static str,
    version: &'static str,
}

#[derive(Debug, Clone, Serialize)]
struct FileDigest {
    path: String,
    sha256: String,
    bytes_len: u64,
}

#[derive(Debug, Clone, Serialize)]
struct Nondeterminism {
    uses_os_time: bool,
    uses_network: bool,
    uses_process: bool,
}

#[derive(Debug, Clone, Serialize)]
struct Meta {
    tool: ToolMeta,
    elapsed_ms: u64,
    cwd: String,
    argv: Vec<String>,
    inputs: Vec<FileDigest>,
    outputs: Vec<FileDigest>,
    nondeterminism: Nondeterminism,
}

#[derive(Debug, Clone, Serialize)]
struct Diagnostic {
    code: String,
    severity: String,
    stage: String,
    message: String,

    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<BTreeMap<String, Value>>,
}

#[derive(Debug, Clone, Serialize)]
struct RunResult {
    bundle_dir: String,
    host_tool: String,
    ui_ready: bool,
}

#[derive(Debug, Clone, Serialize)]
struct RunReport {
    schema_version: &'static str,
    command: &'static str,
    ok: bool,
    exit_code: u8,
    diagnostics: Vec<Diagnostic>,
    meta: Meta,
    result: RunResult,
}

#[derive(Debug)]
struct HostState {
    bundle_files: BTreeMap<String, ServedFile>,
}

#[derive(Debug, Clone)]
struct ServedFile {
    content_type: &'static str,
    bytes: Vec<u8>,
}

#[derive(Debug)]
struct RunState {
    ui_ready: bool,
    ui_error: Option<String>,
    timeout: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct BlobManifestDoc {
    handle: String,
    sha256: String,
    mime: String,
    byte_size: u64,
    created_at_ms: u64,
    source: String,
    local_state: String,
}

#[derive(Debug)]
struct BlobSandbox {
    root: PathBuf,
    max_total_bytes: u64,
    max_item_bytes: u64,
}

#[derive(Debug)]
struct BlobSandboxError {
    code: &'static str,
    message: String,
}

#[derive(Debug, Default)]
struct PendingDropBatch {
    seq: u64,
    paths: Vec<PathBuf>,
}

struct DesktopNativeRuntime {
    capabilities: Value,
    blob_sandbox: BlobSandbox,
    notifications: Mutex<BTreeMap<String, Arc<AtomicBool>>>,
    drop_batch: Mutex<PendingDropBatch>,
    proxy: EventLoopProxy<UserEvent>,
    telemetry: Arc<telemetry::TelemetryCoordinator>,
}

impl DesktopNativeRuntime {
    fn new(
        bundle_dir: &Path,
        capabilities: Value,
        proxy: EventLoopProxy<UserEvent>,
        telemetry: Arc<telemetry::TelemetryCoordinator>,
    ) -> Result<Self> {
        let blob_sandbox = BlobSandbox::new(bundle_dir, &capabilities)?;
        Ok(Self {
            capabilities,
            blob_sandbox,
            notifications: Mutex::new(BTreeMap::new()),
            drop_batch: Mutex::new(PendingDropBatch::default()),
            proxy,
            telemetry,
        })
    }

    fn handle_request(&self, request: &Value) -> Value {
        let started = Instant::now();
        let family = request
            .get("family")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let capability = request
            .get("capability")
            .and_then(Value::as_str)
            .unwrap_or("");
        if !desktop_capability_allowed(&self.capabilities, capability) {
            let reply = json!({
                "family": family,
                "result": desktop_result_doc(request, "unsupported", json!({}), json!({
                    "platform": "desktop",
                    "provider": "desktop_native",
                })),
            });
            self.telemetry.emit_native_event(
                "policy.violation",
                "device.capability.denied",
                "warn",
                desktop_device_telemetry_attrs(
                    request,
                    "unsupported",
                    started.elapsed().as_millis() as u64,
                    [],
                ),
            );
            return reply;
        }

        let reply = match family.as_str() {
            "audio" => self.handle_audio_request(request),
            "permissions" => self.handle_permissions_request(request),
            "clipboard" => self.handle_clipboard_request(request),
            "files" => self.handle_files_request(request),
            "blobs" => self.handle_blobs_request(request),
            "haptics" => self.handle_haptics_request(request),
            "notifications" => self.handle_notifications_request(request),
            "share" => self.handle_share_request(request),
            _ => json!({
                "family": family,
                "result": desktop_result_doc(request, "unsupported", json!({}), desktop_host_meta()),
            }),
        };
        let status = reply
            .pointer("/result/status")
            .and_then(Value::as_str)
            .unwrap_or("error");
        self.telemetry.emit_native_event(
            if status == "error" {
                "runtime.error"
            } else {
                "bridge.timing"
            },
            desktop_device_telemetry_name(request, status),
            if status == "error" { "error" } else { "info" },
            desktop_device_telemetry_attrs(
                request,
                status,
                started.elapsed().as_millis() as u64,
                [],
            ),
        );
        reply
    }

    fn handle_audio_request(&self, request: &Value) -> Value {
        desktop_unsupported_device_reply(request, "audio", "shared_host_audio")
    }

    fn handle_clipboard_request(&self, request: &Value) -> Value {
        let mut clipboard = match Clipboard::new() {
            Ok(value) => value,
            Err(err) => {
                return json!({
                    "family": "clipboard",
                    "result": desktop_result_doc(
                        request,
                        "unsupported",
                        json!({
                            "reason": "clipboard_unavailable",
                            "message": err.to_string(),
                        }),
                        desktop_host_meta(),
                    ),
                });
            }
        };

        if request.get("op").and_then(Value::as_str) == Some("clipboard.read_text") {
            return match clipboard.get_text() {
                Ok(text) => json!({
                    "family": "clipboard",
                    "result": desktop_result_doc(
                        request,
                        "ok",
                        json!({ "text": text }),
                        desktop_host_meta(),
                    ),
                }),
                Err(err) => json!({
                    "family": "clipboard",
                    "result": desktop_result_doc(
                        request,
                        "error",
                        json!({ "message": err.to_string() }),
                        desktop_host_meta(),
                    ),
                }),
            };
        }

        let text = request
            .pointer("/payload/text")
            .and_then(Value::as_str)
            .or_else(|| request.pointer("/payload/value").and_then(Value::as_str))
            .or_else(|| {
                request
                    .pointer("/payload/body/text")
                    .and_then(Value::as_str)
            })
            .unwrap_or("")
            .to_string();

        match clipboard.set_text(text.clone()) {
            Ok(()) => json!({
                "family": "clipboard",
                "result": desktop_result_doc(
                    request,
                    "ok",
                    json!({ "text_bytes_len": text.len() }),
                    desktop_host_meta(),
                ),
            }),
            Err(err) => json!({
                "family": "clipboard",
                "result": desktop_result_doc(
                    request,
                    "error",
                    json!({ "message": err.to_string() }),
                    desktop_host_meta(),
                ),
            }),
        }
    }

    fn handle_files_request(&self, request: &Value) -> Value {
        let multiple = request
            .pointer("/payload/multiple")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        match request
            .get("op")
            .and_then(Value::as_str)
            .unwrap_or("files.pick")
        {
            "files.save" => self.handle_files_save_request(request),
            "files.pick_multiple" => self.handle_files_pick_request(request, true),
            _ => self.handle_files_pick_request(request, multiple),
        }
    }

    fn handle_files_pick_request(&self, request: &Value, multiple: bool) -> Value {
        if !desktop_capability_allowed(&self.capabilities, "blob_store") {
            return json!({
                "family": "files",
                "result": desktop_result_doc(
                    request,
                    "unsupported",
                    json!({ "reason": "blob_store_disabled" }),
                    desktop_host_meta(),
                ),
            });
        }

        let accepts = desktop_request_accepts(request, &self.capabilities);
        let paths = if multiple {
            let Some(paths) = desktop_pick_files(&accepts) else {
                return json!({
                    "family": "files",
                    "result": desktop_result_doc(request, "cancelled", json!({}), desktop_host_meta()),
                });
            };
            paths
        } else {
            let Some(path) = desktop_pick_file(&accepts) else {
                return json!({
                    "family": "files",
                    "result": desktop_result_doc(request, "cancelled", json!({}), desktop_host_meta()),
                });
            };
            vec![path]
        };

        let (payload, status) = self.import_file_paths(&paths, "files.pick");
        json!({
            "family": "files",
            "result": desktop_result_doc(request, status, payload, desktop_host_meta()),
        })
    }

    fn import_file_paths(&self, paths: &[PathBuf], source: &str) -> (Value, &'static str) {
        let mut files = Vec::new();
        let mut blobs = Vec::new();
        let mut errors = Vec::new();

        for path in paths {
            match fs::read(path) {
                Ok(bytes) => {
                    match self
                        .blob_sandbox
                        .put(&bytes, &desktop_mime_type_for_path(path), source)
                    {
                        Ok(manifest) => {
                            blobs.push(manifest_value(&manifest));
                            files.push(desktop_file_value(&manifest, Some(path), source));
                        }
                        Err(err) => errors.push(json!({
                            "code": err.code,
                            "message": err.message,
                            "path": path.display().to_string(),
                        })),
                    }
                }
                Err(err) => errors.push(json!({
                    "code": "file_read_failed",
                    "message": format!("failed to read file {}: {err}", path.display()),
                    "path": path.display().to_string(),
                })),
            }
        }

        let mut payload = json!({
            "blobs": blobs,
            "files": files,
            "accepted_count": files.len(),
            "rejected_count": errors.len(),
        });
        if let Some(obj) = payload.as_object_mut() {
            if paths.len() == 1 {
                obj.insert(
                    "path".to_string(),
                    Value::String(paths[0].display().to_string()),
                );
            }
            if !errors.is_empty() {
                obj.insert("errors".to_string(), Value::Array(errors));
                if !files.is_empty() {
                    obj.insert("partial".to_string(), Value::Bool(true));
                }
            }
        }
        let status = if files.is_empty() { "error" } else { "ok" };
        (payload, status)
    }

    fn handle_files_save_request(&self, request: &Value) -> Value {
        let request_kind = request.get("kind").and_then(Value::as_str).unwrap_or("");
        let default_filename = if request_kind == "x07.web_ui.effect.device.files.save_json" {
            "export.json"
        } else {
            "export.txt"
        };
        let default_mime = if request_kind == "x07.web_ui.effect.device.files.save_json" {
            "application/json"
        } else {
            "text/plain;charset=utf-8"
        };
        let filename = request
            .pointer("/payload/filename")
            .and_then(Value::as_str)
            .or_else(|| request.pointer("/payload/name").and_then(Value::as_str))
            .or_else(|| {
                request
                    .pointer("/payload/suggested_name")
                    .and_then(Value::as_str)
            })
            .filter(|value| !value.is_empty())
            .unwrap_or(default_filename);
        let mime = request
            .pointer("/payload/mime")
            .and_then(Value::as_str)
            .or_else(|| {
                request
                    .pointer("/payload/content_type")
                    .and_then(Value::as_str)
            })
            .filter(|value| !value.is_empty())
            .unwrap_or(default_mime);
        let bytes = if let Some(handle) = request
            .pointer("/payload/blob_handle")
            .and_then(Value::as_str)
            .or_else(|| request.pointer("/payload/handle").and_then(Value::as_str))
            .filter(|value| !value.is_empty())
        {
            match self.blob_sandbox.read(handle) {
                Ok((manifest, bytes)) => (manifest.mime, bytes),
                Err(err) => {
                    return json!({
                        "family": "files",
                        "result": desktop_result_doc(
                            request,
                            "error",
                            json!({ "message": format!("{err:#}") }),
                            desktop_host_meta(),
                        ),
                    });
                }
            }
        } else if request_kind == "x07.web_ui.effect.device.files.save_json" {
            let value = request
                .pointer("/payload/value")
                .cloned()
                .or_else(|| request.pointer("/payload/json").cloned())
                .unwrap_or(Value::Null);
            let mut text =
                serde_json::to_string_pretty(&value).unwrap_or_else(|_| "null".to_string());
            text.push('\n');
            (mime.to_string(), text.into_bytes())
        } else if let Some(text) = request
            .pointer("/payload/text")
            .and_then(Value::as_str)
            .or_else(|| request.pointer("/payload/value").and_then(Value::as_str))
            .or_else(|| {
                request
                    .pointer("/payload/body/text")
                    .and_then(Value::as_str)
            })
            .or_else(|| request.pointer("/payload/url").and_then(Value::as_str))
            .or_else(|| request.pointer("/payload/href").and_then(Value::as_str))
        {
            (mime.to_string(), text.as_bytes().to_vec())
        } else {
            return json!({
                "family": "files",
                "result": desktop_result_doc(
                    request,
                    "error",
                    json!({ "reason": "invalid_request", "message": "request payload missing text/url/blob_handle" }),
                    desktop_host_meta(),
                ),
            });
        };

        let Some(path) = desktop_save_file(filename) else {
            return json!({
                "family": "files",
                "result": desktop_result_doc(request, "cancelled", json!({}), desktop_host_meta()),
            });
        };

        match fs::write(&path, &bytes.1) {
            Ok(()) => json!({
                "family": "files",
                "result": desktop_result_doc(
                    request,
                    "ok",
                    json!({
                        "filename": filename,
                        "mime": bytes.0,
                        "bytes_len": bytes.1.len(),
                        "path": path.display().to_string(),
                    }),
                    desktop_host_meta(),
                ),
            }),
            Err(err) => json!({
                "family": "files",
                "result": desktop_result_doc(
                    request,
                    "error",
                    json!({
                        "message": format!("failed to write file {}: {err}", path.display()),
                    }),
                    desktop_host_meta(),
                ),
            }),
        }
    }

    fn handle_blobs_request(&self, request: &Value) -> Value {
        let handle = request
            .pointer("/payload/handle")
            .and_then(Value::as_str)
            .unwrap_or("");
        let result = if request.get("op").and_then(Value::as_str) == Some("blobs.delete") {
            self.blob_sandbox.delete(handle)
        } else {
            self.blob_sandbox.stat(handle)
        };
        match result {
            Ok(blob) => json!({
                "family": "blobs",
                "result": desktop_result_doc(
                    request,
                    "ok",
                    json!({ "blob": manifest_value(&blob) }),
                    json!({
                        "platform": "desktop",
                        "provider": "desktop_native",
                    }),
                ),
            }),
            Err(err) => json!({
                "family": "blobs",
                "result": desktop_result_doc(
                    request,
                    "error",
                    json!({ "message": format!("{err:#}") }),
                    json!({
                        "platform": "desktop",
                        "provider": "desktop_native",
                    }),
                ),
            }),
        }
    }

    fn handle_permissions_request(&self, request: &Value) -> Value {
        let permission = request
            .pointer("/payload/permission")
            .and_then(Value::as_str)
            .unwrap_or("");
        let (status, state) = match permission {
            "notifications" => ("ok", "granted"),
            "camera" | "location_foreground" => ("unsupported", "unsupported"),
            _ => ("unsupported", "unsupported"),
        };
        json!({
            "family": "permissions",
            "result": desktop_result_doc(
                request,
                status,
                json!({
                    "permission": permission,
                    "state": state,
                }),
                json!({
                    "platform": "desktop",
                    "provider": "desktop_native",
                }),
            ),
        })
    }

    fn handle_haptics_request(&self, request: &Value) -> Value {
        desktop_unsupported_device_reply(request, "haptics", "unsupported_platform")
    }

    fn handle_notifications_request(&self, request: &Value) -> Value {
        let notification_id = request
            .pointer("/payload/notification_id")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .or_else(|| {
                request
                    .pointer("/payload/id")
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
            })
            .unwrap_or_else(|| {
                request
                    .get("request_id")
                    .and_then(Value::as_str)
                    .unwrap_or("")
            })
            .to_string();

        if request.get("op").and_then(Value::as_str) == Some("notifications.cancel") {
            self.cancel_notification(&notification_id);
            return json!({
                "family": "notifications",
                "result": desktop_result_doc(
                    request,
                    "ok",
                    json!({ "notification_id": notification_id }),
                    json!({
                        "platform": "desktop",
                        "provider": "desktop_native",
                    }),
                ),
            });
        }

        let delay_ms = request
            .pointer("/payload/delay_ms")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        self.schedule_notification(notification_id.clone(), delay_ms);
        json!({
            "family": "notifications",
            "result": desktop_result_doc(
                request,
                "ok",
                json!({ "notification_id": notification_id }),
                json!({
                    "platform": "desktop",
                    "provider": "desktop_native",
                }),
            ),
        })
    }

    fn cancel_notification(&self, notification_id: &str) {
        let mut guard = self
            .notifications
            .lock()
            .expect("lock desktop notification registry");
        if let Some(cancelled) = guard.remove(notification_id) {
            cancelled.store(true, Ordering::Relaxed);
        }
    }

    fn schedule_notification(&self, notification_id: String, delay_ms: u64) {
        self.cancel_notification(&notification_id);
        let cancelled = Arc::new(AtomicBool::new(false));
        self.notifications
            .lock()
            .expect("lock desktop notification registry")
            .insert(notification_id.clone(), cancelled.clone());
        let proxy = self.proxy.clone();
        let telemetry = self.telemetry.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(delay_ms));
            if cancelled.load(Ordering::Relaxed) {
                return;
            }
            telemetry.emit_native_event(
                "app.lifecycle",
                "notification.opened",
                "info",
                btreemap1("notification_id", Value::String(notification_id.clone())),
            );
            let doc = json!({
                "type": "notification.opened",
                "notification_id": notification_id,
            });
            let _ = proxy.send_event(UserEvent::DispatchScript(bridge_event_script(&doc)));
        });
    }

    fn handle_share_request(&self, request: &Value) -> Value {
        json!({
            "family": "share",
            "result": desktop_result_doc(
                request,
                "unsupported",
                json!({ "reason": "share_not_supported_on_desktop" }),
                desktop_host_meta(),
            ),
        })
    }

    fn queue_dropped_file(&self, path: PathBuf) {
        if !desktop_capability_allowed(&self.capabilities, "files.drop")
            || !desktop_capability_allowed(&self.capabilities, "blob_store")
        {
            return;
        }
        let seq = {
            let mut batch = self.drop_batch.lock().expect("lock desktop drop batch");
            batch.seq = batch.seq.saturating_add(1);
            batch.paths.push(path);
            batch.seq
        };
        let proxy = self.proxy.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(75));
            let _ = proxy.send_event(UserEvent::FlushDroppedFiles(seq));
        });
    }

    fn flush_dropped_files(&self, seq: u64) -> Option<Value> {
        let paths = {
            let mut batch = self.drop_batch.lock().expect("lock desktop drop batch");
            if batch.seq != seq || batch.paths.is_empty() {
                return None;
            }
            std::mem::take(&mut batch.paths)
        };
        let started = Instant::now();
        let (payload, status) = self.import_file_paths(&paths, "files.drop");
        let accepted_count = payload
            .get("accepted_count")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let rejected_count = payload
            .get("rejected_count")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        self.telemetry.emit_native_event(
            "bridge.timing",
            "device.files.drop",
            if status == "error" { "error" } else { "info" },
            desktop_device_telemetry_attrs(
                &json!({
                    "op": "files.drop",
                    "request_id": "",
                    "capability": "files.drop",
                }),
                status,
                started.elapsed().as_millis() as u64,
                [
                    (
                        "x07.device.accepted_count",
                        Value::Number(accepted_count.into()),
                    ),
                    (
                        "x07.device.rejected_count",
                        Value::Number(rejected_count.into()),
                    ),
                ],
            ),
        );
        Some(json!({
            "type": "files.drop",
            "status": status,
            "source": "desktop",
            "accepted_count": accepted_count,
            "rejected_count": rejected_count,
            "files": payload.get("files").cloned().unwrap_or_else(|| json!([])),
            "blobs": payload.get("blobs").cloned().unwrap_or_else(|| json!([])),
            "errors": payload.get("errors").cloned().unwrap_or_else(|| json!([])),
            "partial": payload.get("partial").cloned().unwrap_or(Value::Bool(false)),
        }))
    }
}

impl BlobSandbox {
    fn new(bundle_dir: &Path, capabilities: &Value) -> Result<Self> {
        let root = bundle_dir.join(".x07-device-host").join("blob_store");
        fs::create_dir_all(root.join("data")).context("create blob_store/data")?;
        fs::create_dir_all(root.join("meta")).context("create blob_store/meta")?;
        Ok(Self {
            root,
            max_total_bytes: capabilities
                .pointer("/device/blob_store/max_total_bytes")
                .and_then(Value::as_u64)
                .unwrap_or(64 * 1024 * 1024),
            max_item_bytes: capabilities
                .pointer("/device/blob_store/max_item_bytes")
                .and_then(Value::as_u64)
                .unwrap_or(16 * 1024 * 1024),
        })
    }

    fn put(
        &self,
        bytes: &[u8],
        mime: &str,
        source: &str,
    ) -> std::result::Result<BlobManifestDoc, BlobSandboxError> {
        if bytes.len() as u64 > self.max_item_bytes {
            return Err(BlobSandboxError {
                code: "blob_item_too_large",
                message: "blob item exceeds max_item_bytes".to_string(),
            });
        }
        let sha256 = {
            let mut hasher = sha2::Sha256::new();
            hasher.update(bytes);
            format!("{:x}", hasher.finalize())
        };
        if let Some(existing) = self
            .read_manifest(&sha256)
            .map_err(|err| BlobSandboxError {
                code: "blob_manifest_read_failed",
                message: format!("{err:#}"),
            })?
        {
            if self.blob_path(&sha256).is_file() && existing.local_state == "present" {
                return Ok(existing);
            }
        }
        if self.total_present_bytes().map_err(|err| BlobSandboxError {
            code: "blob_total_bytes_failed",
            message: format!("{err:#}"),
        })? + bytes.len() as u64
            > self.max_total_bytes
        {
            return Err(BlobSandboxError {
                code: "blob_total_too_large",
                message: "blob store exceeds max_total_bytes".to_string(),
            });
        }

        let manifest = BlobManifestDoc {
            handle: format!("blob:sha256:{sha256}"),
            sha256: sha256.clone(),
            mime: mime.to_string(),
            byte_size: bytes.len() as u64,
            created_at_ms: unix_time_ms(),
            source: source.to_string(),
            local_state: "present".to_string(),
        };
        let blob_path = self.blob_path(&sha256);
        let temp_path = blob_path.with_extension(format!("tmp-{}", std::process::id()));
        fs::write(&temp_path, bytes).map_err(|err| BlobSandboxError {
            code: "blob_write_failed",
            message: format!("write {}: {err}", temp_path.display()),
        })?;
        fs::rename(&temp_path, &blob_path)
            .or_else(|_| {
                fs::copy(&temp_path, &blob_path)?;
                fs::remove_file(&temp_path)
            })
            .map_err(|err| BlobSandboxError {
                code: "blob_write_failed",
                message: format!(
                    "move {} -> {}: {err}",
                    temp_path.display(),
                    blob_path.display()
                ),
            })?;
        self.write_manifest(&manifest)
            .map_err(|err| BlobSandboxError {
                code: "blob_manifest_write_failed",
                message: format!("{err:#}"),
            })?;
        Ok(manifest)
    }

    fn stat(&self, handle: &str) -> Result<BlobManifestDoc> {
        let Some(sha256) = blob_sha_from_handle(handle) else {
            return Ok(missing_blob_manifest(handle, "blob_store"));
        };
        let Some(mut manifest) = self.read_manifest(sha256)? else {
            return Ok(missing_blob_manifest(handle, "blob_store"));
        };
        if manifest.local_state != "deleted" && !self.blob_path(sha256).is_file() {
            manifest.local_state = "missing".to_string();
        }
        Ok(manifest)
    }

    fn read(&self, handle: &str) -> Result<(BlobManifestDoc, Vec<u8>)> {
        let Some(sha256) = blob_sha_from_handle(handle) else {
            anyhow::bail!("invalid blob handle: {handle}");
        };
        let Some(manifest) = self.read_manifest(sha256)? else {
            anyhow::bail!("missing blob manifest: {handle}");
        };
        let path = self.blob_path(sha256);
        let bytes = fs::read(&path).with_context(|| format!("read {}", path.display()))?;
        Ok((manifest, bytes))
    }

    fn delete(&self, handle: &str) -> Result<BlobManifestDoc> {
        let Some(sha256) = blob_sha_from_handle(handle) else {
            return Ok(missing_blob_manifest(handle, "blob_store"));
        };
        let Some(mut manifest) = self.read_manifest(sha256)? else {
            return Ok(missing_blob_manifest(handle, "blob_store"));
        };
        let blob_path = self.blob_path(sha256);
        if blob_path.is_file() {
            fs::remove_file(&blob_path)
                .with_context(|| format!("remove {}", blob_path.display()))?;
        }
        manifest.local_state = "deleted".to_string();
        self.write_manifest(&manifest)?;
        Ok(manifest)
    }

    fn total_present_bytes(&self) -> Result<u64> {
        let mut total = 0_u64;
        for entry in fs::read_dir(self.root.join("meta")).context("read blob meta dir")? {
            let entry = entry?;
            if !entry.file_type()?.is_file() {
                continue;
            }
            let bytes = fs::read(entry.path())
                .with_context(|| format!("read {}", entry.path().display()))?;
            let manifest: BlobManifestDoc = serde_json::from_slice(&bytes)
                .with_context(|| format!("parse {}", entry.path().display()))?;
            if manifest.local_state == "present" {
                total = total.saturating_add(manifest.byte_size);
            }
        }
        Ok(total)
    }

    fn read_manifest(&self, sha256: &str) -> Result<Option<BlobManifestDoc>> {
        let path = self.manifest_path(sha256);
        if !path.is_file() {
            return Ok(None);
        }
        let bytes = fs::read(&path).with_context(|| format!("read {}", path.display()))?;
        let manifest =
            serde_json::from_slice(&bytes).with_context(|| format!("parse {}", path.display()))?;
        Ok(Some(manifest))
    }

    fn write_manifest(&self, manifest: &BlobManifestDoc) -> Result<()> {
        let path = self.manifest_path(&manifest.sha256);
        let bytes = serde_json::to_vec_pretty(manifest).context("serialize blob manifest")?;
        fs::write(&path, bytes).with_context(|| format!("write {}", path.display()))?;
        Ok(())
    }

    fn blob_path(&self, sha256: &str) -> PathBuf {
        self.root.join("data").join(format!("{sha256}.bin"))
    }

    fn manifest_path(&self, sha256: &str) -> PathBuf {
        self.root.join("meta").join(format!("{sha256}.json"))
    }
}

fn main() -> std::process::ExitCode {
    match run() {
        Ok(code) => std::process::ExitCode::from(code),
        Err(err) => {
            eprintln!("{err:#}");
            std::process::ExitCode::from(2)
        }
    }
}

fn run() -> Result<u8> {
    let started = Instant::now();
    let argv: Vec<OsString> = std::env::args_os().collect();
    let cli = Cli::parse_from(&argv);

    if cli.host_abi_hash {
        println!("{}", x07_device_host_abi::host_abi_hash_hex());
        return Ok(0);
    }

    let cmd = match cli.cmd {
        Some(c) => c,
        None => Command::Run(RunArgs {
            bundle: None,
            headless_smoke: false,
            json: false,
        }),
    };

    match cmd {
        Command::Run(args) => cmd_run(&argv, started, args),
    }
}

fn cmd_run(raw_argv: &[OsString], started: Instant, args: RunArgs) -> Result<u8> {
    let bundle_dir = args.bundle.unwrap_or_else(default_bundle_dir);

    let mut diagnostics: Vec<Diagnostic> = Vec::new();
    let mut inputs: Vec<FileDigest> = Vec::new();
    let outputs: Vec<FileDigest> = Vec::new();

    let manifest_path = bundle_dir.join(BUNDLE_MANIFEST_FILE);

    let manifest_bytes = match std::fs::read(&manifest_path) {
        Ok(v) => v,
        Err(err) => {
            diagnostics.push(diag(
                "X07DEVHOST_BUNDLE_MANIFEST_READ_FAILED",
                "error",
                "run",
                format!(
                    "failed to read bundle manifest {}: {err}",
                    manifest_path.display()
                ),
                None,
            ));
            return emit_and_exit(
                raw_argv,
                started,
                &bundle_dir,
                false,
                false,
                diagnostics,
                inputs,
                outputs,
                false,
                args.json,
            );
        }
    };

    inputs.push(file_digest_bytes(&manifest_path, &manifest_bytes));

    let manifest_json: Value = match serde_json::from_slice(&manifest_bytes) {
        Ok(v) => v,
        Err(err) => {
            diagnostics.push(diag(
                "X07DEVHOST_BUNDLE_MANIFEST_PARSE_FAILED",
                "error",
                "parse",
                format!(
                    "failed to parse JSON bundle manifest {}: {err}",
                    manifest_path.display()
                ),
                None,
            ));
            return emit_and_exit(
                raw_argv,
                started,
                &bundle_dir,
                false,
                false,
                diagnostics,
                inputs,
                outputs,
                false,
                args.json,
            );
        }
    };

    let manifest: BundleManifestDoc = match serde_json::from_value(manifest_json) {
        Ok(v) => v,
        Err(err) => {
            diagnostics.push(diag(
                "X07DEVHOST_BUNDLE_MANIFEST_PARSE_FAILED",
                "error",
                "parse",
                format!(
                    "failed to parse bundle manifest shape {}: {err}",
                    manifest_path.display()
                ),
                None,
            ));
            return emit_and_exit(
                raw_argv,
                started,
                &bundle_dir,
                false,
                false,
                diagnostics,
                inputs,
                outputs,
                false,
                args.json,
            );
        }
    };

    if manifest.schema_version != EXPECTED_BUNDLE_SCHEMA_VERSION {
        let mut data = BTreeMap::new();
        data.insert(
            "schema_version".to_string(),
            Value::String(manifest.schema_version.clone()),
        );
        diagnostics.push(diag(
            "X07DEVHOST_BUNDLE_SCHEMA_VERSION_UNSUPPORTED",
            "error",
            "parse",
            "unsupported bundle manifest schema_version".to_string(),
            Some(data),
        ));
        return emit_and_exit(
            raw_argv,
            started,
            &bundle_dir,
            false,
            false,
            diagnostics,
            inputs,
            outputs,
            manifest.telemetry_profile.is_some(),
            args.json,
        );
    }

    if manifest.ui_wasm.path != EXPECTED_UI_WASM_PATH {
        let mut data = BTreeMap::new();
        data.insert(
            "ui_wasm_path".to_string(),
            Value::String(manifest.ui_wasm.path.clone()),
        );
        diagnostics.push(diag(
            "X07DEVHOST_BUNDLE_SCHEMA_VERSION_UNSUPPORTED",
            "error",
            "parse",
            "unsupported bundle ui_wasm.path".to_string(),
            Some(data),
        ));
        return emit_and_exit(
            raw_argv,
            started,
            &bundle_dir,
            false,
            false,
            diagnostics,
            inputs,
            outputs,
            manifest.telemetry_profile.is_some(),
            args.json,
        );
    }

    let expected_abi_hash = x07_device_host_abi::host_abi_hash_hex();
    if manifest.host.host_abi_hash != expected_abi_hash {
        let mut data = BTreeMap::new();
        data.insert(
            "expected_host_abi_hash".to_string(),
            Value::String(expected_abi_hash),
        );
        data.insert(
            "bundle_host_abi_hash".to_string(),
            Value::String(manifest.host.host_abi_hash.clone()),
        );
        diagnostics.push(diag(
            "X07DEVHOST_BUNDLE_HOST_ABI_HASH_MISMATCH",
            "error",
            "run",
            "bundle host ABI hash does not match this host".to_string(),
            Some(data),
        ));
        return emit_and_exit(
            raw_argv,
            started,
            &bundle_dir,
            false,
            false,
            diagnostics,
            inputs,
            outputs,
            manifest.telemetry_profile.is_some(),
            args.json,
        );
    }

    let mut bundle_files = BTreeMap::new();
    bundle_files.insert(
        format!("/{BUNDLE_MANIFEST_FILE}"),
        ServedFile {
            content_type: JSON_CONTENT_TYPE,
            bytes: manifest_bytes,
        },
    );

    let app_manifest_path = bundle_dir.join(APP_MANIFEST_FILE);
    match std::fs::read(&app_manifest_path) {
        Ok(bytes) => {
            inputs.push(file_digest_bytes(&app_manifest_path, &bytes));
            bundle_files.insert(
                format!("/{APP_MANIFEST_FILE}"),
                ServedFile {
                    content_type: JSON_CONTENT_TYPE,
                    bytes,
                },
            );
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => {
            diagnostics.push(diag(
                "X07DEVHOST_APP_MANIFEST_READ_FAILED",
                "error",
                "run",
                format!(
                    "failed to read app manifest {}: {err}",
                    app_manifest_path.display()
                ),
                None,
            ));
            return emit_and_exit(
                raw_argv,
                started,
                &bundle_dir,
                false,
                false,
                diagnostics,
                inputs,
                outputs,
                manifest.telemetry_profile.is_some(),
                args.json,
            );
        }
    }

    let (reducer_wasm_path, reducer_wasm) = match load_bundle_file(
        &bundle_dir,
        "ui_wasm",
        &manifest.ui_wasm,
        false,
        "X07DEVHOST_UI_WASM_READ_FAILED",
        "failed to read reducer wasm",
    ) {
        Ok(v) => v,
        Err(diagnostic) => {
            diagnostics.push(*diagnostic);
            return emit_and_exit(
                raw_argv,
                started,
                &bundle_dir,
                false,
                false,
                diagnostics,
                inputs,
                outputs,
                manifest.telemetry_profile.is_some(),
                args.json,
            );
        }
    };
    inputs.push(file_digest_bytes(&reducer_wasm_path, &reducer_wasm));
    bundle_files.insert(
        serve_path_for(&manifest.ui_wasm.path),
        ServedFile {
            content_type: "application/wasm",
            bytes: reducer_wasm,
        },
    );

    let mut capabilities_doc = Value::Null;

    for (role, file_ref) in [
        (
            "profile",
            manifest.profile.as_ref().map(|profile| &profile.file),
        ),
        ("capabilities", manifest.capabilities.as_ref()),
        ("telemetry_profile", manifest.telemetry_profile.as_ref()),
    ] {
        let Some(file_ref) = file_ref else {
            continue;
        };
        let (path, bytes) = match load_bundle_file(
            &bundle_dir,
            role,
            file_ref,
            true,
            "X07DEVHOST_BUNDLE_JSON_READ_FAILED",
            "failed to read bundle JSON sidecar",
        ) {
            Ok(v) => v,
            Err(diagnostic) => {
                diagnostics.push(*diagnostic);
                return emit_and_exit(
                    raw_argv,
                    started,
                    &bundle_dir,
                    false,
                    false,
                    diagnostics,
                    inputs,
                    outputs,
                    manifest.telemetry_profile.is_some(),
                    args.json,
                );
            }
        };
        inputs.push(file_digest_bytes(&path, &bytes));
        if role == "capabilities" {
            capabilities_doc = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        }
        bundle_files.insert(
            serve_path_for(&file_ref.path),
            ServedFile {
                content_type: JSON_CONTENT_TYPE,
                bytes,
            },
        );
    }

    if let Err(err) = register_extra_bundle_files(&bundle_dir, &mut bundle_files, &mut inputs) {
        diagnostics.push(diag(
            "X07DEVHOST_BUNDLE_EXTRA_FILES_READ_FAILED",
            "error",
            "run",
            format!("failed to read extra bundle files: {err}"),
            None,
        ));
        return emit_and_exit(
            raw_argv,
            started,
            &bundle_dir,
            false,
            false,
            diagnostics,
            inputs,
            outputs,
            manifest.telemetry_profile.is_some(),
            args.json,
        );
    }

    let state = Arc::new(HostState { bundle_files });
    let run_state = Arc::new(Mutex::new(RunState {
        ui_ready: false,
        ui_error: None,
        timeout: false,
    }));
    let telemetry = Arc::new(telemetry::TelemetryCoordinator::new()?);

    let event_loop: EventLoop<UserEvent> = EventLoopBuilder::with_user_event().build();
    let proxy = event_loop.create_proxy();
    let native_runtime = match DesktopNativeRuntime::new(
        &bundle_dir,
        capabilities_doc,
        proxy.clone(),
        telemetry.clone(),
    ) {
        Ok(runtime) => Arc::new(runtime),
        Err(err) => {
            diagnostics.push(diag(
                "X07DEVHOST_BLOB_SANDBOX_INIT_FAILED",
                "error",
                "run",
                format!("failed to initialize blob sandbox: {err:#}"),
                None,
            ));
            return emit_and_exit(
                raw_argv,
                started,
                &bundle_dir,
                false,
                false,
                diagnostics,
                inputs,
                outputs,
                manifest.telemetry_profile.is_some(),
                args.json,
            );
        }
    };

    if args.headless_smoke {
        spawn_timeout(proxy.clone(), Duration::from_secs(2));
    }

    let window = WindowBuilder::new()
        .with_title("x07 device")
        .build(&event_loop)
        .context("create tao window")?;

    let url = "x07://localhost/index.html";
    let webview_slot: Rc<RefCell<Option<wry::WebView>>> = Rc::new(RefCell::new(None));

    let protocol_state = state.clone();
    let ipc_proxy = proxy.clone();
    let ipc_run_state = run_state.clone();
    let ipc_telemetry = telemetry.clone();
    let ipc_native_runtime = native_runtime.clone();
    let event_loop_native_runtime = native_runtime.clone();
    let webview = WebViewBuilder::new()
        .with_custom_protocol("x07".to_string(), move |_id, request| {
            handle_custom_protocol(protocol_state.clone(), request)
        })
        .with_navigation_handler(|nav_url| navigation_allowed(&nav_url))
        .with_initialization_script(r#"globalThis.__x07DeviceNativeBridge = "m0";"#)
        .with_ipc_handler(move |request| {
            handle_ipc(
                &ipc_proxy,
                &ipc_run_state,
                &ipc_telemetry,
                &ipc_native_runtime,
                request.body().to_string(),
            );
        })
        .with_url(url)
        .build(&window)
        .context("build webview")?;
    *webview_slot.borrow_mut() = Some(webview);

    run_event_loop(
        event_loop,
        run_state.clone(),
        args.headless_smoke,
        webview_slot,
        event_loop_native_runtime,
    );

    let final_state = run_state.lock().expect("lock run_state");
    let ui_ready = final_state.ui_ready;
    if let Some(err) = final_state.ui_error.clone() {
        telemetry.emit_native_event(
            "host.webview_crash",
            "host.webview_crash",
            "error",
            btreemap1("message", Value::String(err.clone())),
        );
        diagnostics.push(diag(
            "X07DEVHOST_ASSET_LOAD_FAILED",
            "error",
            "run",
            "ui reported an error during bootstrap".to_string(),
            Some(btreemap1("message", Value::String(err))),
        ));
    }
    if args.headless_smoke && final_state.ui_error.is_none() && !final_state.ui_ready {
        diagnostics.push(diag(
            "X07DEVHOST_INTERNAL_ERROR",
            "error",
            "run",
            "ui did not become ready".to_string(),
            Some(btreemap1("timeout", Value::Bool(final_state.timeout))),
        ));
    }

    let ok =
        diagnostics.iter().all(|d| d.severity != "error") && (!args.headless_smoke || ui_ready);
    emit_and_exit(
        raw_argv,
        started,
        &bundle_dir,
        ok,
        ui_ready,
        diagnostics,
        inputs,
        outputs,
        manifest.telemetry_profile.is_some(),
        args.json,
    )
}

#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
fn run_event_loop(
    event_loop: EventLoop<UserEvent>,
    run_state: Arc<Mutex<RunState>>,
    headless_smoke: bool,
    webview: Rc<RefCell<Option<wry::WebView>>>,
    native_runtime: Arc<DesktopNativeRuntime>,
) {
    use tao::platform::run_return::EventLoopExtRunReturn as _;

    let mut event_loop = event_loop;
    event_loop.run_return(|event, _target, control_flow| {
        *control_flow = ControlFlow::Wait;

        match event {
            Event::WindowEvent {
                event: WindowEvent::CloseRequested,
                ..
            } => *control_flow = ControlFlow::Exit,
            Event::WindowEvent {
                event: WindowEvent::DroppedFile(path),
                ..
            } => native_runtime.queue_dropped_file(path),
            Event::UserEvent(UserEvent::UiReady) if headless_smoke => {
                *control_flow = ControlFlow::Exit
            }
            Event::UserEvent(UserEvent::UiError) if headless_smoke => {
                *control_flow = ControlFlow::Exit
            }
            Event::UserEvent(UserEvent::Timeout) if headless_smoke => {
                if let Ok(mut st) = run_state.lock() {
                    st.timeout = true;
                }
                *control_flow = ControlFlow::Exit;
            }
            Event::UserEvent(UserEvent::DispatchScript(script)) => {
                if let Some(webview) = webview.borrow().as_ref() {
                    let _ = webview.evaluate_script(&script);
                }
            }
            Event::UserEvent(UserEvent::FlushDroppedFiles(seq)) => {
                if let Some(doc) = native_runtime.flush_dropped_files(seq) {
                    if let Some(webview) = webview.borrow().as_ref() {
                        let _ = webview.evaluate_script(&bridge_event_script(&doc));
                    }
                }
            }
            _ => {}
        }
    });
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
fn run_event_loop(
    _event_loop: EventLoop<UserEvent>,
    _run_state: Arc<Mutex<RunState>>,
    _headless_smoke: bool,
    _webview: Rc<RefCell<Option<wry::WebView>>>,
    _native_runtime: Arc<DesktopNativeRuntime>,
) {
    unreachable!("unsupported platform for x07-device-host-desktop");
}

fn handle_ipc(
    proxy: &EventLoopProxy<UserEvent>,
    run_state: &Arc<Mutex<RunState>>,
    telemetry: &Arc<telemetry::TelemetryCoordinator>,
    native_runtime: &Arc<DesktopNativeRuntime>,
    msg: String,
) {
    if msg.len() > 128 * 1024 {
        if let Ok(mut st) = run_state.lock() {
            st.ui_error = Some("ipc message too large".to_string());
        }
        let _ = proxy.send_event(UserEvent::UiError);
        return;
    }

    if telemetry.try_handle_ipc(&msg) {
        return;
    }

    let doc: Value = match serde_json::from_str(&msg) {
        Ok(v) => v,
        Err(_) => return,
    };
    let kind = doc.get("kind").and_then(|v| v.as_str()).unwrap_or("");
    match kind {
        "x07.device.native.request" => {
            let bridge_request_id = doc
                .get("bridge_request_id")
                .and_then(Value::as_str)
                .unwrap_or("");
            if bridge_request_id.is_empty() {
                return;
            }
            let request = doc.get("request").cloned().unwrap_or(Value::Null);
            let result = native_runtime.handle_request(&request);
            let reply = json!({
                "bridge_request_id": bridge_request_id,
                "result": result,
            });
            let _ = proxy.send_event(UserEvent::DispatchScript(bridge_reply_script(&reply)));
        }
        "x07.device.ui.ready" => {
            if let Ok(mut st) = run_state.lock() {
                st.ui_ready = true;
            }
            let _ = proxy.send_event(UserEvent::UiReady);
        }
        "x07.device.ui.error" => {
            let message = doc
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("ui error")
                .to_string();
            if let Ok(mut st) = run_state.lock() {
                st.ui_error = Some(message.clone());
            }
            let _ = proxy.send_event(UserEvent::UiError);
        }
        _ => {}
    }
}

fn navigation_allowed(url: &str) -> bool {
    if url == "about:blank" {
        return true;
    }

    let Ok(uri) = url.parse::<wry::http::Uri>() else {
        return false;
    };

    matches!(
        (uri.scheme_str(), uri.host()),
        (Some("x07"), _) | (Some("http" | "https"), Some("x07.localhost"))
    )
}

fn handle_custom_protocol(
    state: Arc<HostState>,
    request: Request<Vec<u8>>,
) -> Response<Cow<'static, [u8]>> {
    if request.method() != Method::GET {
        return response_bytes(
            StatusCode::METHOD_NOT_ALLOWED,
            "text/plain; charset=utf-8",
            Cow::Borrowed(b"method not allowed"),
        );
    }

    let path = request.uri().path();
    let path = if path == "/" { "/index.html" } else { path };

    match path {
        "/index.html" => {
            let Some(bytes) = x07_device_host_assets::asset_bytes("index.html") else {
                return response_bytes(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "text/plain; charset=utf-8",
                    Cow::Borrowed(b"missing embedded asset: index.html"),
                );
            };
            response_bytes(
                StatusCode::OK,
                "text/html; charset=utf-8",
                Cow::Borrowed(bytes),
            )
        }
        "/bootstrap.js" => {
            let Some(bytes) = x07_device_host_assets::asset_bytes("bootstrap.js") else {
                return response_bytes(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "text/plain; charset=utf-8",
                    Cow::Borrowed(b"missing embedded asset: bootstrap.js"),
                );
            };
            response_bytes(
                StatusCode::OK,
                "text/javascript; charset=utf-8",
                Cow::Borrowed(bytes),
            )
        }
        "/app-host.mjs" => {
            let Some(bytes) = x07_device_host_assets::asset_bytes("app-host.mjs") else {
                return response_bytes(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "text/plain; charset=utf-8",
                    Cow::Borrowed(b"missing embedded asset: app-host.mjs"),
                );
            };
            response_bytes(
                StatusCode::OK,
                "text/javascript; charset=utf-8",
                Cow::Borrowed(bytes),
            )
        }
        _ => {
            if let Some(file) = state.bundle_files.get(path) {
                response_bytes(
                    StatusCode::OK,
                    file.content_type,
                    Cow::Owned(file.bytes.clone()),
                )
            } else {
                response_bytes(
                    StatusCode::NOT_FOUND,
                    "text/plain; charset=utf-8",
                    Cow::Borrowed(b"not found"),
                )
            }
        }
    }
}

fn load_bundle_file(
    bundle_dir: &Path,
    role: &str,
    file_ref: &BundleManifestFile,
    expect_json: bool,
    read_error_code: &str,
    read_error_message: &str,
) -> std::result::Result<(PathBuf, Vec<u8>), Box<Diagnostic>> {
    let path = resolve_bundle_path(bundle_dir, &file_ref.path).map_err(|message| {
        Box::new(diag(
            "X07DEVHOST_BUNDLE_FILE_PATH_INVALID",
            "error",
            "parse",
            message,
            Some(btreemap1("role", Value::String(role.to_string()))),
        ))
    })?;
    let bytes = std::fs::read(&path).map_err(|err| {
        Box::new(diag(
            read_error_code,
            "error",
            "run",
            format!("{read_error_message} {}: {err}", path.display()),
            Some(btreemap1("role", Value::String(role.to_string()))),
        ))
    })?;
    if bytes.len() as u64 != file_ref.bytes_len {
        let mut data = BTreeMap::new();
        data.insert("role".to_string(), Value::String(role.to_string()));
        data.insert(
            "expected_bytes_len".to_string(),
            Value::Number(file_ref.bytes_len.into()),
        );
        data.insert(
            "actual_bytes_len".to_string(),
            Value::Number((bytes.len() as u64).into()),
        );
        return Err(Box::new(diag(
            "X07DEVHOST_BUNDLE_FILE_SIZE_MISMATCH",
            "error",
            "parse",
            format!("bundle file size mismatch for {}", path.display()),
            Some(data),
        )));
    }
    let actual_sha256 = sha256_hex(&bytes);
    if actual_sha256 != file_ref.sha256 {
        let mut data = BTreeMap::new();
        data.insert("role".to_string(), Value::String(role.to_string()));
        data.insert(
            "expected_sha256".to_string(),
            Value::String(file_ref.sha256.clone()),
        );
        data.insert("actual_sha256".to_string(), Value::String(actual_sha256));
        return Err(Box::new(diag(
            "X07DEVHOST_BUNDLE_FILE_DIGEST_MISMATCH",
            "error",
            "parse",
            format!("bundle file digest mismatch for {}", path.display()),
            Some(data),
        )));
    }
    if expect_json {
        serde_json::from_slice::<Value>(&bytes).map_err(|err| {
            let mut data = BTreeMap::new();
            data.insert("role".to_string(), Value::String(role.to_string()));
            data.insert(
                "path".to_string(),
                Value::String(path.display().to_string()),
            );
            Box::new(diag(
                "X07DEVHOST_BUNDLE_JSON_PARSE_FAILED",
                "error",
                "parse",
                format!(
                    "failed to parse bundle JSON sidecar {}: {err}",
                    path.display()
                ),
                Some(data),
            ))
        })?;
    }
    Ok((path, bytes))
}

fn resolve_bundle_path(bundle_dir: &Path, rel_path: &str) -> std::result::Result<PathBuf, String> {
    let rel = Path::new(rel_path);
    if rel.as_os_str().is_empty() {
        return Err("bundle file path is empty".to_string());
    }
    if rel.is_absolute() {
        return Err(format!("bundle file path must be relative: {rel_path}"));
    }
    if rel.components().any(|component| {
        matches!(
            component,
            Component::Prefix(_) | Component::RootDir | Component::ParentDir
        )
    }) {
        return Err(format!(
            "bundle file path must stay within the bundle root: {rel_path}"
        ));
    }
    Ok(bundle_dir.join(rel))
}

fn serve_path_for(rel_path: &str) -> String {
    format!("/{}", rel_path.trim_start_matches('/'))
}

fn register_extra_bundle_files(
    bundle_dir: &Path,
    bundle_files: &mut BTreeMap<String, ServedFile>,
    inputs: &mut Vec<FileDigest>,
) -> Result<()> {
    register_extra_bundle_files_inner(bundle_dir, bundle_dir, bundle_files, inputs)
}

fn register_extra_bundle_files_inner(
    bundle_dir: &Path,
    dir: &Path,
    bundle_files: &mut BTreeMap<String, ServedFile>,
    inputs: &mut Vec<FileDigest>,
) -> Result<()> {
    let mut entries = fs::read_dir(dir)
        .with_context(|| format!("read bundle dir {}", dir.display()))?
        .collect::<std::io::Result<Vec<_>>>()
        .with_context(|| format!("enumerate bundle dir {}", dir.display()))?;
    entries.sort_by_key(|entry| entry.path());

    for entry in entries {
        let path = entry.path();
        let file_type = entry
            .file_type()
            .with_context(|| format!("stat bundle path {}", path.display()))?;
        if file_type.is_dir() {
            register_extra_bundle_files_inner(bundle_dir, &path, bundle_files, inputs)?;
            continue;
        }
        if !file_type.is_file() {
            continue;
        }

        let rel_path = path
            .strip_prefix(bundle_dir)
            .with_context(|| format!("strip bundle prefix for {}", path.display()))?;
        let rel_path = rel_path.to_string_lossy().replace('\\', "/");
        let serve_path = serve_path_for(&rel_path);
        if bundle_files.contains_key(&serve_path) {
            continue;
        }

        let bytes = fs::read(&path)
            .with_context(|| format!("read extra bundle file {}", path.display()))?;
        inputs.push(file_digest_bytes(&path, &bytes));
        bundle_files.insert(
            serve_path,
            ServedFile {
                content_type: desktop_static_mime_type_for_path(&path),
                bytes,
            },
        );
    }

    Ok(())
}

fn response_bytes(
    status: StatusCode,
    content_type: &str,
    body: Cow<'static, [u8]>,
) -> Response<Cow<'static, [u8]>> {
    let mut b = Response::builder().status(status);
    b = b.header("Content-Type", content_type);
    b.body(body).expect("build response")
}

fn spawn_timeout(proxy: EventLoopProxy<UserEvent>, duration: Duration) {
    std::thread::spawn(move || {
        std::thread::sleep(duration);
        let _ = proxy.send_event(UserEvent::Timeout);
    });
}

fn desktop_capability_allowed(capabilities: &Value, capability: &str) -> bool {
    let device = capabilities.get("device");
    match capability {
        "audio.playback" => device
            .and_then(|value| value.get("audio"))
            .and_then(|value| value.get("playback"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        "camera.photo" => device
            .and_then(|value| value.get("camera"))
            .and_then(|value| value.get("photo"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        "clipboard.read_text" => device
            .and_then(|value| value.get("clipboard"))
            .and_then(|value| value.get("read_text"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        "clipboard.write_text" => device
            .and_then(|value| value.get("clipboard"))
            .and_then(|value| value.get("write_text"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        "files.pick" => {
            device
                .and_then(|value| value.get("files"))
                .and_then(|value| value.get("pick"))
                .and_then(Value::as_bool)
                .unwrap_or(false)
                || device
                    .and_then(|value| value.get("files"))
                    .and_then(|value| value.get("pick_multiple"))
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
        }
        "files.pick_multiple" => {
            device
                .and_then(|value| value.get("files"))
                .and_then(|value| value.get("pick_multiple"))
                .and_then(Value::as_bool)
                .unwrap_or(false)
                || device
                    .and_then(|value| value.get("files"))
                    .and_then(|value| value.get("pick"))
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
        }
        "files.save" => device
            .and_then(|value| value.get("files"))
            .and_then(|value| value.get("save"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        "files.drop" => device
            .and_then(|value| value.get("files"))
            .and_then(|value| value.get("drop"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        "blob_store" => device
            .and_then(|value| value.get("blob_store"))
            .and_then(|value| value.get("enabled"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        "haptics.present" => device
            .and_then(|value| value.get("haptics"))
            .and_then(|value| value.get("present"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        "location.foreground" => device
            .and_then(|value| value.get("location"))
            .and_then(|value| value.get("foreground"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        "notifications.local" => device
            .and_then(|value| value.get("notifications"))
            .and_then(|value| value.get("local"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        "share.present" => device
            .and_then(|value| value.get("share"))
            .and_then(|value| value.get("present"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        _ => false,
    }
}

fn desktop_result_doc(request: &Value, status: &str, payload: Value, host_meta: Value) -> Value {
    json!({
        "request_id": request.get("request_id").and_then(Value::as_str).unwrap_or(""),
        "op": request.get("op").and_then(Value::as_str).unwrap_or(""),
        "capability": request.get("capability").and_then(Value::as_str).unwrap_or(""),
        "status": status,
        "payload": payload,
        "host_meta": host_meta,
    })
}

fn desktop_host_meta() -> Value {
    json!({
        "platform": "desktop",
        "provider": "desktop_native",
    })
}

fn desktop_unsupported_device_reply(request: &Value, family: &str, reason: &str) -> Value {
    json!({
        "family": family,
        "result": desktop_result_doc(
            request,
            "unsupported",
            json!({ "reason": reason }),
            desktop_host_meta(),
        ),
    })
}

fn bridge_reply_script(doc: &Value) -> String {
    format!(
        "globalThis.__x07ReceiveDeviceReply?.({});",
        serde_json::to_string(doc).unwrap_or_else(|_| "null".to_string())
    )
}

fn bridge_event_script(doc: &Value) -> String {
    format!(
        "globalThis.__x07DispatchDeviceEvent?.({});",
        serde_json::to_string(doc).unwrap_or_else(|_| "null".to_string())
    )
}

fn unix_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_else(|_| Duration::from_millis(0))
        .as_millis() as u64
}

fn blob_sha_from_handle(handle: &str) -> Option<&str> {
    handle
        .strip_prefix("blob:sha256:")
        .filter(|value| !value.is_empty())
}

fn missing_blob_manifest(handle: &str, source: &str) -> BlobManifestDoc {
    BlobManifestDoc {
        handle: handle.to_string(),
        sha256: blob_sha_from_handle(handle).unwrap_or_default().to_string(),
        mime: "application/octet-stream".to_string(),
        byte_size: 0,
        created_at_ms: 0,
        source: source.to_string(),
        local_state: "missing".to_string(),
    }
}

fn manifest_value(manifest: &BlobManifestDoc) -> Value {
    serde_json::to_value(manifest).unwrap_or_else(|_| json!({}))
}

fn desktop_file_value(manifest: &BlobManifestDoc, path: Option<&Path>, source: &str) -> Value {
    json!({
        "name": path
            .and_then(|value| value.file_name())
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or_default(),
        "path": path.map(|value| value.display().to_string()).unwrap_or_default(),
        "mime": manifest.mime,
        "byte_size": manifest.byte_size,
        "last_modified_ms": 0_u64,
        "source": source,
        "blob": manifest_value(manifest),
    })
}

fn desktop_request_accepts(request: &Value, capabilities: &Value) -> Vec<String> {
    let payload_accepts = request
        .pointer("/payload/accept")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(ToString::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if !payload_accepts.is_empty() {
        return payload_accepts;
    }
    capabilities
        .pointer("/device/files/accept_defaults")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(ToString::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn desktop_pick_file(accepts: &[String]) -> Option<PathBuf> {
    let mut dialog = rfd::FileDialog::new().set_title("Pick a file for x07");
    let mut has_filter = false;
    if accepts
        .iter()
        .any(|item| item.eq_ignore_ascii_case("image/*"))
    {
        dialog = dialog.add_filter(
            "Images",
            &["png", "jpg", "jpeg", "gif", "webp", "bmp", "heic", "heif"],
        );
        has_filter = true;
    }
    if accepts
        .iter()
        .any(|item| item.eq_ignore_ascii_case("application/pdf"))
    {
        dialog = dialog.add_filter("PDF", &["pdf"]);
        has_filter = true;
    }
    let ext_filters = accepts
        .iter()
        .filter_map(|item| item.strip_prefix('.'))
        .map(|item| item.to_string())
        .collect::<Vec<_>>();
    if !ext_filters.is_empty() {
        let ext_slices = ext_filters.iter().map(String::as_str).collect::<Vec<_>>();
        dialog = dialog.add_filter("Files", &ext_slices);
        has_filter = true;
    }
    let _ = has_filter;
    dialog.pick_file()
}

fn desktop_pick_files(accepts: &[String]) -> Option<Vec<PathBuf>> {
    let mut dialog = rfd::FileDialog::new().set_title("Pick files for x07");
    let mut has_filter = false;
    if accepts
        .iter()
        .any(|item| item.eq_ignore_ascii_case("image/*"))
    {
        dialog = dialog.add_filter(
            "Images",
            &["png", "jpg", "jpeg", "gif", "webp", "bmp", "heic", "heif"],
        );
        has_filter = true;
    }
    if accepts
        .iter()
        .any(|item| item.eq_ignore_ascii_case("application/pdf"))
    {
        dialog = dialog.add_filter("PDF", &["pdf"]);
        has_filter = true;
    }
    let ext_filters = accepts
        .iter()
        .filter_map(|item| item.strip_prefix('.'))
        .map(|item| item.to_string())
        .collect::<Vec<_>>();
    if !ext_filters.is_empty() {
        let ext_slices = ext_filters.iter().map(String::as_str).collect::<Vec<_>>();
        dialog = dialog.add_filter("Files", &ext_slices);
        has_filter = true;
    }
    let _ = has_filter;
    dialog.pick_files()
}

fn desktop_save_file(filename: &str) -> Option<PathBuf> {
    let dialog = rfd::FileDialog::new()
        .set_title("Save file for x07")
        .set_file_name(filename);
    dialog.save_file()
}

fn desktop_mime_type_for_path(path: &Path) -> String {
    desktop_static_mime_type_for_path(path).to_string()
}

fn desktop_static_mime_type_for_path(path: &Path) -> &'static str {
    mime_guess::from_path(path)
        .first_raw()
        .unwrap_or("application/octet-stream")
}

fn desktop_device_telemetry_attrs(
    request: &Value,
    status: &str,
    duration_ms: u64,
    extra: impl IntoIterator<Item = (&'static str, Value)>,
) -> BTreeMap<String, Value> {
    let mut attrs = BTreeMap::new();
    attrs.insert(
        "x07.device.op".to_string(),
        Value::String(
            request
                .get("op")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
        ),
    );
    attrs.insert(
        "x07.device.request_id".to_string(),
        Value::String(
            request
                .get("request_id")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
        ),
    );
    attrs.insert(
        "x07.device.status".to_string(),
        Value::String(status.to_string()),
    );
    attrs.insert(
        "x07.device.capability".to_string(),
        Value::String(
            request
                .get("capability")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
        ),
    );
    attrs.insert(
        "x07.device.platform".to_string(),
        Value::String("desktop".to_string()),
    );
    attrs.insert(
        "x07.device.duration_ms".to_string(),
        Value::Number(duration_ms.into()),
    );
    for (key, value) in extra {
        attrs.insert(key.to_string(), value);
    }
    attrs
}

fn desktop_device_telemetry_name(request: &Value, status: &str) -> &'static str {
    match request.get("op").and_then(Value::as_str).unwrap_or("") {
        "audio.play" => "device.audio.play",
        "audio.stop" => "device.audio.stop",
        "haptics.trigger" => "device.haptics.trigger",
        _ if status == "error" => "device.op.error",
        _ => "device.op.result",
    }
}

fn default_bundle_dir() -> PathBuf {
    let exe = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("."));
    if let Some(dir) = infer_bundle_dir_from_exe(&exe) {
        return dir;
    }
    PathBuf::from("bundle")
}

fn infer_bundle_dir_from_exe(exe: &Path) -> Option<PathBuf> {
    // macOS .app layout: MyApp.app/Contents/MacOS/<bin>
    let macos_dir = exe.parent()?;
    if macos_dir.file_name()?.to_string_lossy() != "MacOS" {
        return None;
    }
    let contents_dir = macos_dir.parent()?;
    if contents_dir.file_name()?.to_string_lossy() != "Contents" {
        return None;
    }
    Some(contents_dir.join("Resources").join("bundle"))
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut h = sha2::Sha256::new();
    h.update(bytes);
    let digest = h.finalize();
    let mut out = String::with_capacity(digest.len() * 2);
    for b in digest {
        out.push(nibble_to_hex((b >> 4) & 0xF));
        out.push(nibble_to_hex(b & 0xF));
    }
    out
}

fn nibble_to_hex(n: u8) -> char {
    match n {
        0..=9 => (b'0' + n) as char,
        10..=15 => (b'a' + (n - 10)) as char,
        _ => '?',
    }
}

fn file_digest_bytes(path: &Path, bytes: &[u8]) -> FileDigest {
    FileDigest {
        path: path.display().to_string(),
        sha256: sha256_hex(bytes),
        bytes_len: bytes.len() as u64,
    }
}

fn diag(
    code: &str,
    severity: &str,
    stage: &str,
    message: String,
    data: Option<BTreeMap<String, Value>>,
) -> Diagnostic {
    Diagnostic {
        code: code.to_string(),
        severity: severity.to_string(),
        stage: stage.to_string(),
        message,
        data,
    }
}

fn btreemap1(k: &str, v: Value) -> BTreeMap<String, Value> {
    let mut out = BTreeMap::new();
    out.insert(k.to_string(), v);
    out
}

#[allow(clippy::too_many_arguments)]
fn emit_and_exit(
    raw_argv: &[OsString],
    started: Instant,
    bundle_dir: &Path,
    ok: bool,
    ui_ready: bool,
    diagnostics: Vec<Diagnostic>,
    inputs: Vec<FileDigest>,
    outputs: Vec<FileDigest>,
    telemetry_enabled: bool,
    json: bool,
) -> Result<u8> {
    let exit_code = if ok { 0 } else { 2 };

    let cwd = std::env::current_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .display()
        .to_string();

    let argv = raw_argv
        .iter()
        .map(|s| s.to_string_lossy().to_string())
        .collect::<Vec<_>>();

    let meta = Meta {
        tool: ToolMeta {
            name: "x07-device-host-desktop",
            version: env!("CARGO_PKG_VERSION"),
        },
        elapsed_ms: started.elapsed().as_millis().min(u64::MAX as u128) as u64,
        cwd,
        argv,
        inputs,
        outputs,
        nondeterminism: Nondeterminism {
            uses_os_time: false,
            uses_network: telemetry_enabled,
            uses_process: true,
        },
    };

    let report = RunReport {
        schema_version: RUN_REPORT_SCHEMA_VERSION,
        command: RUN_REPORT_COMMAND,
        ok,
        exit_code,
        diagnostics,
        meta,
        result: RunResult {
            bundle_dir: bundle_dir.display().to_string(),
            host_tool: format!("x07-device-host-desktop@{}", env!("CARGO_PKG_VERSION")),
            ui_ready,
        },
    };

    if json {
        let bytes = serde_json::to_vec(&report).context("serialize run report")?;
        std::io::Write::write_all(&mut std::io::stdout(), &bytes).ok();
    }

    Ok(exit_code)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_bundle_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "x07-device-host-desktop-{name}-{}-{}",
            std::process::id(),
            unix_time_ms()
        ));
        fs::create_dir_all(&dir).expect("create temp bundle dir");
        dir
    }

    #[test]
    fn bundle_manifest_sidecars_deserialize() {
        let doc = serde_json::from_value::<BundleManifestDoc>(serde_json::json!({
            "schema_version": "x07.device.bundle.manifest@0.1.0",
            "kind": "device_bundle",
            "target": "desktop",
            "profile": {
                "id": "device_desktop_dev",
                "v": 1,
                "file": {
                    "path": "profile/device.profile.json",
                    "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    "bytes_len": 123
                }
            },
            "capabilities": {
                "path": "profile/device.capabilities.json",
                "sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                "bytes_len": 456
            },
            "telemetry_profile": {
                "path": "profile/device.telemetry.profile.json",
                "sha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
                "bytes_len": 789
            },
            "ui_wasm": {
                "path": "ui/reducer.wasm",
                "sha256": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
                "bytes_len": 42
            },
            "host": {
                "kind": "webview_v1",
                "abi_name": "webview_host_v1",
                "abi_version": "0.1.0",
                "host_abi_hash": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
            },
            "bundle_digest": "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
        }))
        .expect("bundle manifest should deserialize");

        assert_eq!(
            doc.profile
                .as_ref()
                .map(|profile| profile.file.path.as_str()),
            Some("profile/device.profile.json")
        );
        assert_eq!(
            doc.capabilities.as_ref().map(|file| file.path.as_str()),
            Some("profile/device.capabilities.json")
        );
        assert_eq!(
            doc.telemetry_profile
                .as_ref()
                .map(|file| file.path.as_str()),
            Some("profile/device.telemetry.profile.json")
        );
    }

    #[test]
    fn resolve_bundle_path_rejects_parent_escape() {
        let err = resolve_bundle_path(Path::new("bundle"), "../secrets.json")
            .expect_err("path traversal should be rejected");
        assert!(err.contains("bundle root"));
    }

    #[test]
    fn blob_sandbox_put_stat_delete_roundtrip() {
        let bundle_dir = temp_bundle_dir("blob-roundtrip");
        let sandbox = BlobSandbox::new(
            &bundle_dir,
            &json!({
                "device": {
                    "blob_store": {
                        "enabled": true,
                        "max_total_bytes": 1024,
                        "max_item_bytes": 512
                    }
                }
            }),
        )
        .expect("create blob sandbox");

        let manifest = sandbox
            .put(b"hello", "text/plain", "files")
            .expect("store blob");
        let stat = sandbox.stat(&manifest.handle).expect("stat blob");
        assert_eq!(stat.handle, manifest.handle);
        assert_eq!(stat.local_state, "present");

        let (read_manifest, read_bytes) = sandbox.read(&manifest.handle).expect("read blob");
        assert_eq!(read_manifest.handle, manifest.handle);
        assert_eq!(read_bytes, b"hello");

        let deleted = sandbox.delete(&manifest.handle).expect("delete blob");
        assert_eq!(deleted.local_state, "deleted");

        let after_delete = sandbox.stat(&manifest.handle).expect("stat after delete");
        assert_eq!(after_delete.local_state, "deleted");

        let _ = fs::remove_dir_all(bundle_dir);
    }

    #[test]
    fn blob_sandbox_enforces_item_quota() {
        let bundle_dir = temp_bundle_dir("blob-quota");
        let sandbox = BlobSandbox::new(
            &bundle_dir,
            &json!({
                "device": {
                    "blob_store": {
                        "enabled": true,
                        "max_total_bytes": 1024,
                        "max_item_bytes": 4
                    }
                }
            }),
        )
        .expect("create blob sandbox");

        let err = sandbox
            .put(b"hello", "text/plain", "files")
            .expect_err("quota should reject oversized blob");
        assert_eq!(err.code, "blob_item_too_large");

        let _ = fs::remove_dir_all(bundle_dir);
    }

    #[test]
    fn blob_sandbox_enforces_total_quota() {
        let bundle_dir = temp_bundle_dir("blob-total-quota");
        let sandbox = BlobSandbox::new(
            &bundle_dir,
            &json!({
                "device": {
                    "blob_store": {
                        "enabled": true,
                        "max_total_bytes": 8,
                        "max_item_bytes": 8
                    }
                }
            }),
        )
        .expect("create blob sandbox");

        sandbox
            .put(b"rust", "text/plain", "files")
            .expect("store first blob");

        let err = sandbox
            .put(b"tools", "text/plain", "files")
            .expect_err("quota should reject total blob size overflow");
        assert_eq!(err.code, "blob_total_too_large");

        let _ = fs::remove_dir_all(bundle_dir);
    }

    #[test]
    fn desktop_capability_allowed_recognizes_builder_io_flags() {
        let capabilities = json!({
            "device": {
                "audio": {
                    "playback": true
                },
                "clipboard": {
                    "read_text": true,
                    "write_text": true
                },
                "files": {
                    "pick": true,
                    "pick_multiple": true,
                    "save": true,
                    "drop": true
                },
                "haptics": {
                    "present": true
                },
                "share": {
                    "present": true
                }
            }
        });

        assert!(desktop_capability_allowed(&capabilities, "audio.playback"));
        assert!(desktop_capability_allowed(
            &capabilities,
            "clipboard.read_text"
        ));
        assert!(desktop_capability_allowed(
            &capabilities,
            "clipboard.write_text"
        ));
        assert!(desktop_capability_allowed(
            &capabilities,
            "files.pick_multiple"
        ));
        assert!(desktop_capability_allowed(&capabilities, "files.save"));
        assert!(desktop_capability_allowed(&capabilities, "files.drop"));
        assert!(desktop_capability_allowed(&capabilities, "haptics.present"));
        assert!(desktop_capability_allowed(&capabilities, "share.present"));
    }

    #[test]
    fn desktop_device_telemetry_name_prefers_explicit_ops() {
        assert_eq!(
            desktop_device_telemetry_name(&json!({ "op": "audio.play" }), "ok"),
            "device.audio.play"
        );
        assert_eq!(
            desktop_device_telemetry_name(&json!({ "op": "haptics.trigger" }), "ok"),
            "device.haptics.trigger"
        );
        assert_eq!(
            desktop_device_telemetry_name(&json!({}), "error"),
            "device.op.error"
        );
    }

    #[test]
    fn register_extra_bundle_files_serves_component_assets() {
        let bundle_dir = temp_bundle_dir("extra-bundle-files");
        let transpiled_dir = bundle_dir.join("transpiled");
        fs::create_dir_all(&transpiled_dir).expect("create transpiled dir");
        fs::write(
            transpiled_dir.join("app.mjs"),
            br#"export * from "./app.js";"#,
        )
        .expect("write app.mjs");
        fs::write(transpiled_dir.join("app.js"), b"console.log('ok');").expect("write app.js");

        let mut bundle_files = BTreeMap::new();
        let mut inputs = Vec::new();
        register_extra_bundle_files(&bundle_dir, &mut bundle_files, &mut inputs)
            .expect("register extra bundle files");

        assert!(bundle_files.contains_key("/transpiled/app.mjs"));
        assert!(bundle_files.contains_key("/transpiled/app.js"));
        assert!(inputs
            .iter()
            .any(|digest| digest.path.ends_with("transpiled/app.mjs")));

        let _ = fs::remove_dir_all(bundle_dir);
    }
}
