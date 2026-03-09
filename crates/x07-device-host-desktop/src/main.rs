use std::borrow::Cow;
use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use clap::{Args, Parser, Subcommand};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::Digest as _;
use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoop, EventLoopBuilder, EventLoopProxy};
use tao::window::WindowBuilder;
use wry::http::{Method, Request, Response, StatusCode};
use wry::WebViewBuilder;

mod telemetry;

const BUNDLE_MANIFEST_FILE: &str = "bundle.manifest.json";
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
        bundle_files.insert(
            serve_path_for(&file_ref.path),
            ServedFile {
                content_type: JSON_CONTENT_TYPE,
                bytes,
            },
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

    if args.headless_smoke {
        spawn_timeout(proxy.clone(), Duration::from_secs(2));
    }

    let window = WindowBuilder::new()
        .with_title("x07 device")
        .build(&event_loop)
        .context("create tao window")?;

    let url = "x07://localhost/index.html";

    let protocol_state = state.clone();
    let ipc_proxy = proxy.clone();
    let ipc_run_state = run_state.clone();
    let ipc_telemetry = telemetry.clone();
    let _webview = WebViewBuilder::new()
        .with_custom_protocol("x07".to_string(), move |_id, request| {
            handle_custom_protocol(protocol_state.clone(), request)
        })
        .with_navigation_handler(|nav_url| navigation_allowed(&nav_url))
        .with_ipc_handler(move |request| {
            handle_ipc(
                &ipc_proxy,
                &ipc_run_state,
                &ipc_telemetry,
                request.body().to_string(),
            );
        })
        .with_url(url)
        .build(&window)
        .context("build webview")?;

    run_event_loop(event_loop, run_state.clone(), args.headless_smoke);

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
            _ => {}
        }
    });
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
fn run_event_loop(
    _event_loop: EventLoop<UserEvent>,
    _run_state: Arc<Mutex<RunState>>,
    _headless_smoke: bool,
) {
    unreachable!("unsupported platform for x07-device-host-desktop");
}

fn handle_ipc(
    proxy: &EventLoopProxy<UserEvent>,
    run_state: &Arc<Mutex<RunState>>,
    telemetry: &Arc<telemetry::TelemetryCoordinator>,
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
}
