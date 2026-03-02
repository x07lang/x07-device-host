pub static ASSETS: &[(&str, &[u8])] = &[
    ("index.html", include_bytes!("../assets/index.html")),
    ("bootstrap.js", include_bytes!("../assets/bootstrap.js")),
    ("app-host.mjs", include_bytes!("../assets/app-host.mjs")),
];

pub fn asset_bytes(path: &str) -> Option<&'static [u8]> {
    for (p, bytes) in ASSETS {
        if *p == path {
            return Some(bytes);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_assets_are_present_and_non_empty() {
        for (path, bytes) in ASSETS {
            assert!(!path.trim().is_empty());
            assert!(!bytes.is_empty(), "asset must not be empty: {path}");
        }
    }

    #[test]
    fn asset_bytes_lookup_works() {
        for (path, bytes) in ASSETS {
            assert_eq!(asset_bytes(path), Some(*bytes));
        }
        assert_eq!(asset_bytes("missing"), None);
    }
}
