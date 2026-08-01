//! 嵌入资产的**解码内容断言**（`enforce-native-engine-artifact-gates` 7.2）。
//!
//! 为什么需要它：页面规则在构建期被异或编码进二进制、运行时再异或回来。编码端与解码端
//! 各自读一个密钥常量，两者**没有任何机械关系** —— 收敛到单一定义（7.1）之前是四份手抄副本，
//! 收敛之后也仍可能被人重新拆开（再写一个本地 const 就够了）。
//!
//! 密钥不一致的后果不是编译失败，而是：编译照过、`cargo test` 里其它用例照绿、
//! 打包照出、签名照过 —— 只有真跑一条页面命令时，浏览器侧才会拿到一段乱码，
//! 表现为「结果无效」，与「页面改版了」在现场完全无法区分。这正是本仓的红线形态
//! （静默假成功），所以必须有一条**会真正执行解码**的断言把它拦在自动流程里。
//!
//! 判据取最强的一种：**解码结果必须逐字包含磁盘上的明文源**。
//! 密钥一旦对不上，异或出来的既不是那段源码、多半连合法 UTF-8 都不是，断言当场红。
//! 另配一组具名明文特征，防「磁盘源本身被换成空 / 垃圾但仍能自洽往返」。
//!
//! 覆盖面 = build.rs 编码的全部 7 份嵌入资产。新增嵌入资产时必须同时在这里登记一条，
//! 否则新资产的编解码一致性不在任何自动流程里。

use aidcp_page_engine::protocol::{NativeCommand, PageProbeParams};
use aidcp_page_engine::{facebook, probe, xhs};
use serde_json::json;
use std::fs;
use std::path::PathBuf;

fn crate_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

/// 读一份磁盘上的明文资产。空文件直接判失败：`contains("")` 恒真，
/// 用空串做「包含」判据等于把断言关掉。
fn read_source(relative: &str) -> String {
    let path = crate_dir().join(relative);
    let contents = fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("read embedded asset source {relative}: {error}"));
    assert!(
        contents.len() > 16,
        "embedded asset source is empty or implausibly short, so `contains` would prove nothing: {relative}"
    );
    contents
}

/// Facebook 路由的明文源是分片按有序清单拼出来的。
/// 拼接不变量（尾随换行、词典序、未登记分片）由 `build.rs::read_ordered_sources` 拥有并断言；
/// 这里只复刻「按清单顺序、无分隔字节地拼接」，用来与解码结果比对。
fn facebook_router_source() -> String {
    let directory = crate_dir().join("src/facebook-router");
    let manifest =
        fs::read_to_string(directory.join("manifest.txt")).expect("read router manifest");
    let mut source = String::new();
    let mut count = 0usize;
    for entry in manifest
        .lines()
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
    {
        let fragment = fs::read_to_string(directory.join(entry))
            .unwrap_or_else(|error| panic!("read router fragment {entry}: {error}"));
        source.push_str(&fragment);
        count += 1;
    }
    assert!(count > 1, "the ordered router manifest names no fragments");
    source
}

/// 断言一份解码结果确实还原成了它的明文源，并带着具名明文特征。
fn assert_decoded_asset(label: &str, decoded: &str, source: &str, features: &[&str]) {
    assert!(
        decoded.contains(source.trim_end()),
        "{label}: decoded embedded asset does not contain its on-disk cleartext source. \
         The encoding key used at build time and the key used at runtime have diverged \
         (or the artifact is stale relative to the source). Decoded prefix: {:?}",
        decoded.chars().take(120).collect::<String>()
    );
    for feature in features {
        assert!(
            decoded.contains(feature),
            "{label}: decoded embedded asset is missing its cleartext feature {feature:?}"
        );
    }
}

#[test]
fn decodes_every_embedded_asset_back_to_its_cleartext_source() {
    // 1. 小红书页面探针。
    let probe_expression = probe::xhs_page_probe_expression().expect("decode xhs page probe");
    assert_decoded_asset(
        "xhs-page-probe.js",
        &probe_expression,
        &read_source("src/xhs-page-probe.js"),
        &["getBoundingClientRect"],
    );

    // 2. 小红书命令路由。
    let router_expression =
        xhs::command_expression(&NativeCommand::PageProbe(PageProbeParams::default()))
            .expect("decode xhs command router");
    assert_decoded_asset(
        "xhs-command-router.js",
        &router_expression,
        &read_source("src/xhs-command-router.js"),
        &["'use strict'"],
    );

    // 3. 小红书文件输入选择器。
    let selector = xhs::file_input_selector().expect("decode xhs file input selector");
    assert_decoded_asset(
        "xhs-file-input-selector.txt",
        &selector,
        &read_source("src/xhs-file-input-selector.txt"),
        &["input[type="],
    );

    // 4. 小红书搜索框几何。
    let geometry = xhs::search_input_expression("probe").expect("decode xhs search geometry");
    assert_decoded_asset(
        "xhs-search-input-geometry.js",
        &geometry,
        &read_source("src/xhs-search-input-geometry.js"),
        &["getComputedStyle"],
    );

    // 5. 小红书写动作判据。
    let targets = xhs::input_targets_expression(&json!({ "kind": "publish", "op": "probe" }))
        .expect("decode xhs input targets");
    assert_decoded_asset(
        "xhs-input-targets.js",
        &targets,
        &read_source("src/xhs-input-targets.js"),
        &["getBoundingClientRect"],
    );

    // 6. Facebook 命令路由（12 片按有序清单拼接后整体编码）。
    let facebook_router = facebook::page_probe_expression().expect("decode facebook router");
    assert_decoded_asset(
        "facebook-router/*.js",
        &facebook_router,
        &facebook_router_source(),
        &["'use strict'"],
    );

    // 7. Facebook 文件输入选择器。
    let facebook_selector =
        facebook::file_input_selector().expect("decode facebook file input selector");
    assert_decoded_asset(
        "facebook-file-input-selector.txt",
        &facebook_selector,
        &read_source("src/facebook-file-input-selector.txt"),
        &["data-aidcp-publish-file-input"],
    );
}
