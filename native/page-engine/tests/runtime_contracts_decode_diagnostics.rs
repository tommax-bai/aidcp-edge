//! 非 Facebook 平台的结果解码诊断（`harden-native-engine-runtime-contracts` 7.3 / 7.5③）。
//!
//! 迁移后小红书与页面探测的解码入口只回一句「结果无效」：真机上无从分辨是页面规则改版、
//! 字段漂移，还是页面根本没跑起来——而这条链路没有对照组可比，只能靠诊断说话。
//! 这组用例锁两件事：① 三种失败形态（页面抛异常 / 包装层缺字段 / 类型层字段不合）都带诊断，
//! 且能说出阶段、字段路径与异常位置；② 诊断**有界**，不含页面正文、地址与凭据。

use aidcp_page_engine::error::ErrorCode;
use serde_json::{Value, json};

fn diagnostic_of(error: &aidcp_page_engine::error::EngineError) -> Value {
    let raw = error
        .bounded_diagnostic_json()
        .expect("decode failures must carry a bounded diagnostic");
    serde_json::from_str(&raw).expect("diagnostic json")
}

#[test]
fn xiaohongshu_decode_failures_carry_a_bounded_diagnostic() {
    // ① 页面里抛了异常：记类别 / 原因 / 触发标识符 / 行列。
    let exception = json!({
        "exceptionDetails": {
            "lineNumber": 13,
            "columnNumber": 55,
            "exception": {
                "className": "TypeError",
                "description": "TypeError: Cannot read properties of null (reading 'querySelectorAll')\n    at <anonymous>:13:55"
            }
        }
    });
    let error = aidcp_page_engine::xhs::result_from_cdp(&exception).expect_err("exception");
    assert_eq!(error.code, ErrorCode::CdpError);
    let diagnostic = diagnostic_of(&error);
    assert_eq!(diagnostic["decodeStage"], "cdp_exception");
    assert_eq!(diagnostic["exceptionClass"], "type_error");
    assert_eq!(diagnostic["exceptionReason"], "cannot_read_property");
    assert_eq!(diagnostic["exceptionToken"], "querySelectorAll");
    assert_eq!(diagnostic["lineNumber"], 13);
    assert_eq!(diagnostic["columnNumber"], 55);

    // ② 包装层缺字段：说得出缺的是哪个路径。
    let missing = json!({ "result": {} });
    let error = aidcp_page_engine::xhs::result_from_cdp(&missing).expect_err("missing value");
    let diagnostic = diagnostic_of(&error);
    assert_eq!(diagnostic["decodeStage"], "cdp_wrapper");
    assert_eq!(diagnostic["fieldPath"], "result.value");
    assert_eq!(diagnostic["actualType"], "missing");

    // ③ 类型层字段不合：说得出是哪个字段。
    let wrong_shape = json!({ "result": { "value": { "output": { "kind": "page_cards" } } } });
    let error = aidcp_page_engine::xhs::result_from_cdp(&wrong_shape).expect_err("typed value");
    let diagnostic = diagnostic_of(&error);
    assert_eq!(diagnostic["decodeStage"], "cdp_wrapper");
    assert_eq!(diagnostic["fieldPath"], "effectPhase");
}

#[test]
fn page_probe_decode_failures_carry_a_bounded_diagnostic() {
    let exception = json!({
        "exceptionDetails": {
            "lineNumber": 7,
            "exception": {
                "className": "ReferenceError",
                "description": "ReferenceError: leafTabs is not defined"
            }
        }
    });
    let error = aidcp_page_engine::probe::result_from_cdp("t1".to_owned(), &exception)
        .expect_err("exception");
    assert_eq!(error.code, ErrorCode::ProbeFailed);
    let diagnostic = diagnostic_of(&error);
    assert_eq!(diagnostic["decodeStage"], "cdp_exception");
    assert_eq!(diagnostic["exceptionClass"], "reference_error");
    assert_eq!(diagnostic["exceptionReason"], "reference_not_defined");
    assert_eq!(diagnostic["exceptionToken"], "leafTabs");

    let missing_field = json!({
        "result": { "value": { "href": "https://www.xiaohongshu.com/explore" } }
    });
    let error = aidcp_page_engine::probe::result_from_cdp("t1".to_owned(), &missing_field)
        .expect_err("missing field");
    let diagnostic = diagnostic_of(&error);
    assert_eq!(diagnostic["decodeStage"], "typed_value");
    assert_eq!(diagnostic["expectedKind"], "page_probe");
    assert_eq!(diagnostic["actualType"], "missing");
    assert!(
        diagnostic["fieldPath"]
            .as_str()
            .is_some_and(|path| path.contains("readyState")),
        "{diagnostic}"
    );
}

/// 诊断绝不能把页面正文或凭据带出去：异常描述只用于分类，落进诊断的只有受限标识符。
#[test]
fn diagnostics_never_carry_page_text_or_credentials() {
    let leaky = json!({
        "exceptionDetails": {
            "exception": {
                "className": "Error",
                "description": "Error: session cookie c_user=61591824155856 while reading 用户正文内容"
            }
        }
    });
    let error = aidcp_page_engine::xhs::result_from_cdp(&leaky).expect_err("exception");
    let raw = error.bounded_diagnostic_json().expect("diagnostic");
    assert!(!raw.contains("c_user"), "{raw}");
    assert!(!raw.contains("61591824155856"), "{raw}");
    assert!(!raw.contains("用户正文内容"), "{raw}");
    assert!(raw.len() <= 512, "{raw}");

    // 标识符本身也要过白名单：带引号 / 空格的「标识符」一律不落盘。
    let odd_token = json!({
        "exceptionDetails": {
            "exception": {
                "className": "TypeError",
                "description": "TypeError: Cannot read properties of null (reading 'a b c')"
            }
        }
    });
    let error = aidcp_page_engine::xhs::result_from_cdp(&odd_token).expect_err("exception");
    let diagnostic = diagnostic_of(&error);
    assert!(diagnostic.get("exceptionToken").is_none(), "{diagnostic}");
}
