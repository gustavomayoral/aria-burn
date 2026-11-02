// SPDX-License-Identifier: GPL-3.0-or-later
//! Conformance: every fixture in aria-burn-core's `src/contract/fixtures/`
//! parses into the generated types and writes back to the same JSON (or bytes,
//! for `sample-batch.bin`). Mirrors the fixture table in the core's
//! contract.test.ts, so a fixture added there must be added here too.

use std::{fs, path::PathBuf};

use aria_burn_contract::{
    CONTRACT_DIR, ChannelEvent, Command, JobModel, MachineProfile, MaterialProfile,
    sample_batch::{self, MotionSample, SampleBatchHeader},
};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::Value;

fn fixture_path(name: &str) -> PathBuf {
    PathBuf::from(CONTRACT_DIR).join("fixtures").join(name)
}

fn read_json(name: &str) -> Value {
    serde_json::from_str(&fs::read_to_string(fixture_path(name)).unwrap()).unwrap_or_else(|e| panic!("{name}: {e}"))
}

/// JSON equality with numbers compared by value: Rust writes an f64 `1` as
/// `1.0`, which is the same JSON number.
fn same_json(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Array(x), Value::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(a, b)| same_json(a, b)),
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| same_json(v, w)))
        }
        _ => a == b,
    }
}

fn round_trip<T: DeserializeOwned + Serialize>(name: &str) {
    let original = read_json(name);
    let typed: T = serde_json::from_value(original.clone()).unwrap_or_else(|e| panic!("{name} does not parse: {e}"));
    let written = serde_json::to_value(&typed).unwrap();
    assert!(
        same_json(&original, &written),
        "{name} changed on round trip\n--- fixture\n{original:#}\n--- written\n{written:#}"
    );
    // And the re-written text parses again.
    let text = serde_json::to_string_pretty(&typed).unwrap();
    let _: T = serde_json::from_str(&text).unwrap();
}

#[test]
fn every_fixture_is_covered() {
    let mut names: Vec<_> = fs::read_dir(PathBuf::from(CONTRACT_DIR).join("fixtures"))
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .collect();
    names.sort();
    let covered = [
        "command-plan-start.json",
        "job-loaded-event.json",
        "job-model.json",
        "machine-profile.json",
        "material-bleach.json",
        "material-char.json",
        "material-melt.json",
        "plan-done-event.json",
        "sample-batch.bin",
        "sample-batch.json",
        "status-event.json",
    ];
    assert_eq!(names, covered, "fixture set changed: add the new fixture to this test");
}

#[test]
fn json_fixtures_round_trip() {
    round_trip::<JobModel>("job-model.json");
    round_trip::<MachineProfile>("machine-profile.json");
    round_trip::<MaterialProfile>("material-char.json");
    round_trip::<MaterialProfile>("material-melt.json");
    round_trip::<MaterialProfile>("material-bleach.json");
    round_trip::<ChannelEvent>("status-event.json");
    round_trip::<ChannelEvent>("job-loaded-event.json");
    round_trip::<ChannelEvent>("plan-done-event.json");
    round_trip::<Command>("command-plan-start.json");
}

#[test]
fn unknown_fields_are_rejected() {
    let mut machine = read_json("machine-profile.json");
    machine.as_object_mut().unwrap().insert("extra".into(), 1.into());
    assert!(serde_json::from_value::<MachineProfile>(machine).is_err());
}

#[test]
fn union_tags_are_checked() {
    let mut done = read_json("plan-done-event.json");
    done["event"]["type"] = "plan.started".into();
    assert!(serde_json::from_value::<ChannelEvent>(done).is_err());
    let mut wood = read_json("material-char.json");
    wood["response"]["kind"] = "melt".into();
    assert!(serde_json::from_value::<MaterialProfile>(wood).is_err());
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct SampleBatchJson {
    header: Value,
    samples: Vec<MotionSample>,
}

#[test]
fn sample_batch_bin_matches_json_and_round_trips() {
    let bin = fs::read(fixture_path("sample-batch.bin")).unwrap();
    let json: SampleBatchJson = serde_json::from_value(read_json("sample-batch.json")).unwrap();
    let header: SampleBatchHeader = serde_json::from_value(json.header).unwrap();

    let (decoded_header, decoded) = sample_batch::decode_sample_batch(&bin).unwrap();
    assert_eq!(decoded_header, header);
    assert_eq!(decoded, json.samples);

    let encoded = sample_batch::encode_sample_batch(&header, &json.samples);
    assert_eq!(encoded, bin, "re-encoded sample-batch.bin differs from the core's bytes");
    assert_eq!(bin.len(), sample_batch::encoded_len(json.samples.len()));
}

#[test]
fn sample_batch_decoder_rejects_bad_input() {
    use sample_batch::SampleBatchError as E;
    let bin = fs::read(fixture_path("sample-batch.bin")).unwrap();
    assert_eq!(sample_batch::decode_sample_batch(&bin[..10]), Err(E::TooShort));
    let mut bad = bin.clone();
    bad[0] ^= 0xff;
    assert!(matches!(sample_batch::decode_sample_batch(&bad), Err(E::BadMagic(_))));
    assert!(matches!(sample_batch::decode_sample_batch(&bin[..bin.len() - 1]), Err(E::LengthMismatch { .. })));
}
