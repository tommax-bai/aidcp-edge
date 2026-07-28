use sha2::{Digest, Sha256};
use std::env;
use std::fs;
use std::path::Path;
use std::path::PathBuf;

const KEY: &[u8] = &[
    0x91, 0x2f, 0xc4, 0x6a, 0x5d, 0xe3, 0x18, 0xb7, 0x42, 0x0d, 0xfa,
];

fn main() {
    println!("cargo:rerun-if-changed=src/xhs-page-probe.js");
    println!("cargo:rerun-if-changed=src/xhs-command-router.js");
    println!("cargo:rerun-if-changed=src/xhs-file-input-selector.txt");
    println!("cargo:rerun-if-changed=src/xhs-search-input-geometry.js");
    println!("cargo:rerun-if-changed=src/facebook-router/manifest.txt");
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

    let facebook_router_source = read_ordered_sources("src/facebook-router/manifest.txt");
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

fn read_ordered_sources(manifest_path: &str) -> Vec<u8> {
    let manifest_file_name = Path::new(manifest_path)
        .file_name()
        .expect("source manifest file name")
        .to_owned();
    let manifest = fs::read_to_string(manifest_path).expect("read ordered source manifest");
    let directory = Path::new(manifest_path)
        .parent()
        .expect("source manifest directory");
    // 目录本身也要 rerun：否则新增一个未登记的分片不会触发 build.rs 重跑，
    // 下面的反向对账就永远看不到它。
    println!("cargo:rerun-if-changed={}", directory.display());
    let mut source = Vec::new();
    let mut entries = std::collections::HashSet::new();
    let mut previous: Option<&str> = None;
    for entry in manifest
        .lines()
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
    {
        assert!(
            !entry.contains('/') && !entry.contains('\\') && entries.insert(entry),
            "ordered source manifest entries must be unique local file names"
        );
        assert!(
            previous.is_none_or(|value| value < entry),
            "ordered source manifest entries must remain in lexical assembly order"
        );
        previous = Some(entry);
        let path = directory.join(entry);
        println!("cargo:rerun-if-changed={}", path.display());
        let fragment = fs::read(&path).unwrap_or_else(|_| {
            panic!("ordered source manifest names a missing fragment: {entry}")
        });
        // 拼接不变量：每片必须以换行结尾。
        // 选「断言尾随换行」而不是「片间插显式分隔字节」，理由是后者会改变已编入
        // 二进制的字节序列（属行为变更，本 change 明确不改分片内容与产物语义）；
        // 断言式在当前 11 片（末字节实测均为 0x0a）下零行为差异。
        // 不做这条断言时，某片丢掉尾随换行且末行是行注释，会把下一片首行注释掉 ——
        // 结果仍是合法脚本，只是某个函数凭空消失，跑到那条路径才报未定义。
        assert!(
            fragment.last() == Some(&b'\n'),
            "ordered source fragment must end with a newline before concatenation: {entry}"
        );
        source.extend(fragment);
    }
    assert!(
        !entries.is_empty(),
        "ordered source manifest cannot be empty"
    );
    // 反向对账：目录里出现未登记的分片即失败并指名它。
    // 只做正向断言时，新增分片却忘记登记会构建照过、二进制里没有它、
    // 运行时静默走缺失逻辑 —— 本地全绿、只有真跑页面命令才现形。
    for item in fs::read_dir(directory).expect("read ordered source directory") {
        let item = item.expect("read ordered source directory entry");
        if !item
            .file_type()
            .expect("ordered source entry type")
            .is_file()
        {
            continue;
        }
        let name = item.file_name();
        if name == manifest_file_name {
            continue;
        }
        let name = name.to_string_lossy().into_owned();
        assert!(
            entries.contains(name.as_str()),
            "page-rule fragment is not registered in the ordered source manifest: {name}"
        );
    }
    source
}
