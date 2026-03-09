use std::collections::{BTreeMap, BTreeSet};
use std::sync::Mutex;
use std::time::Duration;

use anyhow::{Context, Result};
use opentelemetry_proto::tonic::collector::logs::v1::ExportLogsServiceRequest;
use opentelemetry_proto::tonic::common::v1::{any_value, AnyValue, InstrumentationScope, KeyValue};
use opentelemetry_proto::tonic::logs::v1::{LogRecord, ResourceLogs, ScopeLogs, SeverityNumber};
use opentelemetry_proto::tonic::resource::v1::Resource;
use prost::Message as _;
use reqwest::blocking::Client;
use serde::Deserialize;
use serde_json::Value;

const TELEMETRY_SCOPE_NAME: &str = "x07.device.host";
const TELEMETRY_SCOPE_VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Debug, Clone, Deserialize)]
struct TelemetryKind {
    kind: String,
}

#[derive(Debug, Clone, Deserialize)]
struct TelemetryConfigure {
    transport: TelemetryTransport,
    #[serde(default)]
    resource: BTreeMap<String, Value>,
    #[serde(default)]
    event_classes: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct TelemetryEnvelope {
    transport: TelemetryTransport,
    #[serde(default)]
    resource: BTreeMap<String, Value>,
    event: TelemetryEvent,
}

#[derive(Debug, Clone, Deserialize)]
struct TelemetryEvent {
    #[serde(rename = "class")]
    event_class: String,
    name: String,
    #[serde(default = "default_time_unix_ms")]
    time_unix_ms: u64,
    #[serde(default = "default_severity")]
    severity: String,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    attributes: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Deserialize)]
struct TelemetryTransport {
    protocol: String,
    endpoint: String,
}

#[derive(Debug, Clone)]
struct TelemetryRuntimeConfig {
    transport: TelemetryTransport,
    resource: BTreeMap<String, Value>,
    event_classes: BTreeSet<String>,
}

pub(crate) struct TelemetryCoordinator {
    client: Client,
    runtime: Mutex<Option<TelemetryRuntimeConfig>>,
}

impl TelemetryCoordinator {
    pub(crate) fn new() -> Result<Self> {
        let client = Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .context("build OTLP HTTP client")?;
        Ok(Self {
            client,
            runtime: Mutex::new(None),
        })
    }

    pub(crate) fn try_handle_ipc(&self, msg: &str) -> bool {
        let Ok(kind) = serde_json::from_str::<TelemetryKind>(msg) else {
            return false;
        };
        match kind.kind.as_str() {
            "x07.device.telemetry.configure" => {
                let Ok(configure) = serde_json::from_str::<TelemetryConfigure>(msg) else {
                    return true;
                };
                self.configure(configure);
                true
            }
            "x07.device.telemetry.event" => {
                let Ok(envelope) = serde_json::from_str::<TelemetryEnvelope>(msg) else {
                    return true;
                };
                self.export_envelope(envelope);
                true
            }
            _ => false,
        }
    }

    pub(crate) fn emit_native_event(
        &self,
        event_class: &str,
        name: &str,
        severity: &str,
        attributes: BTreeMap<String, Value>,
    ) {
        let runtime = {
            let guard = self.runtime.lock().expect("lock telemetry runtime");
            guard.clone()
        };
        let Some(runtime) = runtime else {
            return;
        };
        if !runtime.event_classes.contains(event_class) {
            return;
        }
        self.export_envelope(TelemetryEnvelope {
            transport: runtime.transport,
            resource: runtime.resource,
            event: TelemetryEvent {
                event_class: event_class.to_string(),
                name: name.to_string(),
                time_unix_ms: default_time_unix_ms(),
                severity: severity.to_string(),
                body: None,
                attributes,
            },
        });
    }

    fn configure(&self, configure: TelemetryConfigure) {
        if !transport_supported(&configure.transport) {
            return;
        }
        let runtime = TelemetryRuntimeConfig {
            transport: TelemetryTransport {
                protocol: configure.transport.protocol,
                endpoint: configure.transport.endpoint,
            },
            resource: filter_null_values(configure.resource),
            event_classes: configure
                .event_classes
                .into_iter()
                .filter(|name| !name.trim().is_empty())
                .collect(),
        };
        if let Ok(mut guard) = self.runtime.lock() {
            *guard = Some(runtime);
        }
    }

    fn export_envelope(&self, envelope: TelemetryEnvelope) {
        if !transport_supported(&envelope.transport) {
            return;
        }
        let request = build_logs_request(&envelope);
        let endpoint = normalize_logs_endpoint(&envelope.transport.endpoint);
        let protocol = envelope.transport.protocol.clone();
        let client = self.client.clone();
        std::thread::spawn(move || {
            let res = match protocol.as_str() {
                "http/json" => {
                    let body = serde_json::to_vec(&request).context("serialize OTLP JSON");
                    match body {
                        Ok(body) => client
                            .post(endpoint)
                            .header("Content-Type", "application/json")
                            .body(body)
                            .send()
                            .context("send OTLP JSON"),
                        Err(err) => Err(err),
                    }
                }
                "http/protobuf" => {
                    let body = request.encode_to_vec();
                    client
                        .post(endpoint)
                        .header("Content-Type", "application/x-protobuf")
                        .body(body)
                        .send()
                        .context("send OTLP protobuf")
                }
                _ => return,
            };
            if let Err(err) = res {
                eprintln!("x07-device-host-desktop telemetry export failed: {err:#}");
            }
        });
    }
}

fn default_time_unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

fn default_severity() -> String {
    "info".to_string()
}

fn transport_supported(transport: &TelemetryTransport) -> bool {
    matches!(transport.protocol.as_str(), "http/json" | "http/protobuf")
        && (transport.endpoint.starts_with("http://") || transport.endpoint.starts_with("https://"))
}

fn normalize_logs_endpoint(endpoint: &str) -> String {
    let trimmed = endpoint.trim();
    if trimmed.ends_with("/v1/logs") {
        return trimmed.to_string();
    }
    if trimmed.ends_with('/') {
        return format!("{trimmed}v1/logs");
    }
    format!("{trimmed}/v1/logs")
}

fn filter_null_values(values: BTreeMap<String, Value>) -> BTreeMap<String, Value> {
    values
        .into_iter()
        .filter(|(_, value)| !value.is_null())
        .collect()
}

fn build_logs_request(envelope: &TelemetryEnvelope) -> ExportLogsServiceRequest {
    let mut attributes = filter_null_values(envelope.event.attributes.clone());
    attributes.insert(
        "x07.event.class".to_string(),
        Value::String(envelope.event.event_class.clone()),
    );
    let resource = Resource {
        attributes: key_values_from_map(&envelope.resource),
        dropped_attributes_count: 0,
        entity_refs: Vec::new(),
    };
    let log_record = LogRecord {
        time_unix_nano: envelope.event.time_unix_ms.saturating_mul(1_000_000),
        observed_time_unix_nano: default_time_unix_ms().saturating_mul(1_000_000),
        severity_number: severity_number(&envelope.event.severity) as i32,
        severity_text: envelope.event.severity.to_ascii_uppercase(),
        body: Some(string_any_value(
            envelope
                .event
                .body
                .clone()
                .unwrap_or_else(|| envelope.event.name.clone()),
        )),
        attributes: key_values_from_map(&attributes),
        dropped_attributes_count: 0,
        flags: 0,
        trace_id: Vec::new(),
        span_id: Vec::new(),
        event_name: envelope.event.name.clone(),
    };
    ExportLogsServiceRequest {
        resource_logs: vec![ResourceLogs {
            resource: Some(resource),
            scope_logs: vec![ScopeLogs {
                scope: Some(InstrumentationScope {
                    name: TELEMETRY_SCOPE_NAME.to_string(),
                    version: TELEMETRY_SCOPE_VERSION.to_string(),
                    attributes: Vec::new(),
                    dropped_attributes_count: 0,
                }),
                log_records: vec![log_record],
                schema_url: String::new(),
            }],
            schema_url: String::new(),
        }],
    }
}

fn key_values_from_map(values: &BTreeMap<String, Value>) -> Vec<KeyValue> {
    values
        .iter()
        .filter_map(|(key, value)| {
            json_value_to_any_value(value).map(|value| KeyValue {
                key: key.clone(),
                value: Some(value),
            })
        })
        .collect()
}

fn json_value_to_any_value(value: &Value) -> Option<AnyValue> {
    match value {
        Value::Null => None,
        Value::Bool(v) => Some(AnyValue {
            value: Some(any_value::Value::BoolValue(*v)),
        }),
        Value::Number(v) => {
            if let Some(i) = v.as_i64() {
                return Some(AnyValue {
                    value: Some(any_value::Value::IntValue(i)),
                });
            }
            if let Some(u) = v.as_u64() {
                return Some(AnyValue {
                    value: Some(any_value::Value::IntValue(
                        i64::try_from(u).unwrap_or(i64::MAX),
                    )),
                });
            }
            v.as_f64().map(|f| AnyValue {
                value: Some(any_value::Value::DoubleValue(f)),
            })
        }
        Value::String(v) => Some(string_any_value(v.clone())),
        Value::Array(_) | Value::Object(_) => Some(string_any_value(value.to_string())),
    }
}

fn string_any_value(value: String) -> AnyValue {
    AnyValue {
        value: Some(any_value::Value::StringValue(value)),
    }
}

fn severity_number(severity: &str) -> SeverityNumber {
    match severity.to_ascii_lowercase().as_str() {
        "trace" => SeverityNumber::Trace,
        "debug" => SeverityNumber::Debug,
        "warn" | "warning" => SeverityNumber::Warn,
        "error" => SeverityNumber::Error,
        "fatal" => SeverityNumber::Fatal,
        _ => SeverityNumber::Info,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_logs_endpoint_appends_logs_path() {
        assert_eq!(
            normalize_logs_endpoint("https://otel.example.invalid:4318"),
            "https://otel.example.invalid:4318/v1/logs"
        );
        assert_eq!(
            normalize_logs_endpoint("https://otel.example.invalid:4318/"),
            "https://otel.example.invalid:4318/v1/logs"
        );
        assert_eq!(
            normalize_logs_endpoint("https://otel.example.invalid:4318/v1/logs"),
            "https://otel.example.invalid:4318/v1/logs"
        );
    }

    #[test]
    fn build_logs_request_keeps_resource_and_event_attributes() {
        let envelope = TelemetryEnvelope {
            transport: TelemetryTransport {
                protocol: "http/json".to_string(),
                endpoint: "https://otel.example.invalid:4318".to_string(),
            },
            resource: BTreeMap::from([
                (
                    "x07.app_id".to_string(),
                    Value::String("demo.app".to_string()),
                ),
                ("x07.target".to_string(), Value::String("ios".to_string())),
            ]),
            event: TelemetryEvent {
                event_class: "app.lifecycle".to_string(),
                name: "app.start".to_string(),
                time_unix_ms: 42,
                severity: "info".to_string(),
                body: None,
                attributes: BTreeMap::from([(
                    "screen".to_string(),
                    Value::String("launch".to_string()),
                )]),
            },
        };
        let request = build_logs_request(&envelope);
        let doc = serde_json::to_value(&request).expect("serialize request");
        let resource_attrs = doc
            .pointer("/resourceLogs/0/resource/attributes")
            .and_then(Value::as_array)
            .expect("resource attributes");
        assert!(resource_attrs
            .iter()
            .any(|item| item.get("key").and_then(Value::as_str) == Some("x07.app_id")));
        let event_attrs = doc
            .pointer("/resourceLogs/0/scopeLogs/0/logRecords/0/attributes")
            .and_then(Value::as_array)
            .expect("event attributes");
        assert!(event_attrs
            .iter()
            .any(|item| item.get("key").and_then(Value::as_str) == Some("x07.event.class")));
        assert_eq!(
            doc.pointer("/resourceLogs/0/scopeLogs/0/logRecords/0/eventName")
                .and_then(Value::as_str),
            Some("app.start")
        );
    }
}
