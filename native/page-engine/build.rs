use std::env;
use std::fs;
use std::path::PathBuf;

const KEY: &[u8] = &[
    0x91, 0x2f, 0xc4, 0x6a, 0x5d, 0xe3, 0x18, 0xb7, 0x42, 0x0d, 0xfa,
];

fn main() {
    println!("cargo:rerun-if-changed=src/xhs-page-probe.js");
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
}
