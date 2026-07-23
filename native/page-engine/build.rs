use sha2::{Digest, Sha256};
use std::env;
use std::fs;
use std::path::PathBuf;

const KEY: &[u8] = &[
    0x91, 0x2f, 0xc4, 0x6a, 0x5d, 0xe3, 0x18, 0xb7, 0x42, 0x0d, 0xfa,
];

fn main() {
    println!("cargo:rerun-if-changed=src/xhs-page-probe.js");
    println!("cargo:rerun-if-changed=src/xhs-command-router.js");
    println!("cargo:rerun-if-changed=src/xhs-file-input-selector.txt");
    println!("cargo:rerun-if-changed=src/xhs-search-input-geometry.js");
    println!("cargo:rerun-if-changed=src/facebook-command-router.js");
    println!("cargo:rerun-if-changed=src/facebook-file-input-selector.txt");
    println!("cargo:rerun-if-changed=command-manifest.json");
    let command_manifest = fs::read("command-manifest.json").expect("read command manifest");
    let capability_digest = format!("{:x}", Sha256::digest(&command_manifest));
    println!("cargo:rustc-env=AIDCP_PAGE_ENGINE_CAPABILITY_DIGEST={capability_digest}");
    let source = fs::read("src/xhs-page-probe.js").expect("read native page probe source");
    let encoded: Vec<u8> = source
        .iter()
        .enumerate()
        .map(|(index, byte)| byte ^ KEY[index % KEY.len()])
        .collect();
    let bytes = encoded
        .iter()
        .map(|byte| format!("0x{byte:02x}"))
        .collect::<Vec<_>>()
        .join(",");
    let output = format!("pub const XHS_PAGE_PROBE_BYTES: &[u8] = &[{bytes}];\n");
    let output_path =
        PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR")).join("xhs_page_probe_bytes.rs");
    fs::write(output_path, output).expect("write encoded native page probe");

    let router_source =
        fs::read("src/xhs-command-router.js").expect("read native command router source");
    let router_encoded: Vec<u8> = router_source
        .iter()
        .enumerate()
        .map(|(index, byte)| byte ^ KEY[index % KEY.len()])
        .collect();
    let router_bytes = router_encoded
        .iter()
        .map(|byte| format!("0x{byte:02x}"))
        .collect::<Vec<_>>()
        .join(",");
    let router_output = format!("pub const XHS_COMMAND_ROUTER_BYTES: &[u8] = &[{router_bytes}];\n");
    let router_output_path =
        PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR")).join("xhs_command_router_bytes.rs");
    fs::write(router_output_path, router_output).expect("write encoded native command router");

    let selector_source =
        fs::read("src/xhs-file-input-selector.txt").expect("read native file selector");
    let selector_encoded: Vec<u8> = selector_source
        .iter()
        .enumerate()
        .map(|(index, byte)| byte ^ KEY[index % KEY.len()])
        .collect();
    let selector_bytes = selector_encoded
        .iter()
        .map(|byte| format!("0x{byte:02x}"))
        .collect::<Vec<_>>()
        .join(",");
    let selector_output =
        format!("pub const XHS_FILE_INPUT_SELECTOR_BYTES: &[u8] = &[{selector_bytes}];\n");
    let selector_output_path = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR"))
        .join("xhs_file_input_selector_bytes.rs");
    fs::write(selector_output_path, selector_output).expect("write encoded native file selector");

    let search_geometry_source = fs::read("src/xhs-search-input-geometry.js")
        .expect("read native search input geometry source");
    let search_geometry_encoded: Vec<u8> = search_geometry_source
        .iter()
        .enumerate()
        .map(|(index, byte)| byte ^ KEY[index % KEY.len()])
        .collect();
    let search_geometry_bytes = search_geometry_encoded
        .iter()
        .map(|byte| format!("0x{byte:02x}"))
        .collect::<Vec<_>>()
        .join(",");
    let search_geometry_output =
        format!("pub const XHS_SEARCH_INPUT_GEOMETRY_BYTES: &[u8] = &[{search_geometry_bytes}];\n");
    let search_geometry_output_path = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR"))
        .join("xhs_search_input_geometry_bytes.rs");
    fs::write(search_geometry_output_path, search_geometry_output)
        .expect("write encoded native search input geometry");

    let facebook_router_source =
        fs::read("src/facebook-command-router.js").expect("read Facebook command router source");
    let facebook_router_encoded: Vec<u8> = facebook_router_source
        .iter()
        .enumerate()
        .map(|(index, byte)| byte ^ KEY[index % KEY.len()])
        .collect();
    let facebook_router_bytes = facebook_router_encoded
        .iter()
        .map(|byte| format!("0x{byte:02x}"))
        .collect::<Vec<_>>()
        .join(",");
    let facebook_router_output =
        format!("pub const FACEBOOK_COMMAND_ROUTER_BYTES: &[u8] = &[{facebook_router_bytes}];\n");
    let facebook_router_output_path = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR"))
        .join("facebook_command_router_bytes.rs");
    fs::write(facebook_router_output_path, facebook_router_output)
        .expect("write encoded Facebook command router");

    let facebook_selector_source = fs::read("src/facebook-file-input-selector.txt")
        .expect("read Facebook file input selector");
    let facebook_selector_encoded: Vec<u8> = facebook_selector_source
        .iter()
        .enumerate()
        .map(|(index, byte)| byte ^ KEY[index % KEY.len()])
        .collect();
    let facebook_selector_bytes = facebook_selector_encoded
        .iter()
        .map(|byte| format!("0x{byte:02x}"))
        .collect::<Vec<_>>()
        .join(",");
    let facebook_selector_output = format!(
        "pub const FACEBOOK_FILE_INPUT_SELECTOR_BYTES: &[u8] = &[{facebook_selector_bytes}];\n"
    );
    let facebook_selector_output_path = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR"))
        .join("facebook_file_input_selector_bytes.rs");
    fs::write(facebook_selector_output_path, facebook_selector_output)
        .expect("write encoded Facebook file input selector");
}
