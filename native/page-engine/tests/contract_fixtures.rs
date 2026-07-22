use aidcp_page_engine::probe::{RawPageSignals, build_result};
use serde::Deserialize;
use serde_json::Value;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FixtureFile {
    schema_version: u32,
    source_contract: String,
    cases: Vec<FixtureCase>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FixtureCase {
    name: String,
    command: FixtureCommand,
    target_id: String,
    signals: RawPageSignals,
    expected: Value,
}

#[derive(Debug, Deserialize)]
struct FixtureCommand {
    kind: String,
    params: Value,
}

#[test]
fn replays_selector_free_page_contract_fixtures() {
    let fixtures: FixtureFile =
        serde_json::from_str(include_str!("fixtures/page-probe-contracts.json"))
            .expect("valid page contract fixtures");
    assert_eq!(fixtures.schema_version, 1);
    assert_eq!(
        fixtures.source_contract,
        "src/native-page-engine/client.ts#NativePageProbeResult"
    );
    assert!(!fixtures.cases.is_empty());

    for fixture in fixtures.cases {
        assert_eq!(fixture.command.kind, "page_probe", "{}", fixture.name);
        assert_eq!(
            fixture.command.params,
            serde_json::json!({}),
            "{}",
            fixture.name
        );
        let actual = build_result(fixture.target_id, fixture.signals)
            .unwrap_or_else(|error| panic!("{}: {}", fixture.name, error));
        let normalized = serde_json::to_value(actual).expect("serialize normalized result");
        assert_eq!(normalized, fixture.expected, "{}", fixture.name);
    }
}
