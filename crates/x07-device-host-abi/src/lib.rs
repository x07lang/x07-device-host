use serde::Serialize;
use sha2::Digest as _;

pub const ABI_NAME: &str = "webview_host_v1";
pub const ABI_VERSION: &str = "0.1.0";
pub const BRIDGE_PROTOCOL_VERSION: &str = "web_ui_bridge_v1";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssetDigest {
    pub path: &'static str,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize)]
struct AbiAssetDigest<'a> {
    path: &'a str,
    sha256: &'a str,
}

#[derive(Debug, Clone, Serialize)]
struct HostAbi<'a> {
    abi_name: &'a str,
    abi_version: &'a str,
    assets: Vec<AbiAssetDigest<'a>>,
    bridge_protocol_version: &'a str,
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

pub fn assets_digests() -> Vec<AssetDigest> {
    let mut out = Vec::new();
    for (path, bytes) in x07_device_host_assets::ASSETS {
        out.push(AssetDigest {
            path,
            sha256: sha256_hex(bytes),
        });
    }
    out
}

pub fn abi_json_bytes_compact() -> Vec<u8> {
    let asset_digests = assets_digests();
    let mut assets = Vec::with_capacity(asset_digests.len());
    for a in &asset_digests {
        assets.push(AbiAssetDigest {
            path: a.path,
            sha256: a.sha256.as_str(),
        });
    }

    let abi = HostAbi {
        abi_name: ABI_NAME,
        abi_version: ABI_VERSION,
        assets,
        bridge_protocol_version: BRIDGE_PROTOCOL_VERSION,
    };

    serde_json::to_vec(&abi).expect("serialize host abi JSON")
}

pub fn host_abi_hash_hex() -> String {
    sha256_hex(&abi_json_bytes_compact())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_abi_hash_is_stable() {
        assert_eq!(host_abi_hash_hex(), host_abi_hash_hex());
    }

    #[test]
    fn abi_json_is_compact_and_parseable() {
        let bytes = abi_json_bytes_compact();
        assert!(!bytes.is_empty());
        assert!(!bytes.ends_with(b"\n"));
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["abi_name"], ABI_NAME);
        assert_eq!(v["abi_version"], ABI_VERSION);
        assert_eq!(v["bridge_protocol_version"], BRIDGE_PROTOCOL_VERSION);
        assert!(v["assets"].is_array());
    }
}
