use crate::cdp::CdpSession;
use crate::error::EngineError;
use std::f64::consts::{PI, TAU};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const SHIFT_MODIFIER: u8 = 8;
const CAPTCHA_TEXT_MAX_CHARS: usize = 24;
const WHEEL_FRAME_COUNT_MIN: usize = 8;
const WHEEL_FRAME_COUNT_MAX: usize = 15;
const WHEEL_FRAME_DELAY_MIN_MS: u64 = 16;
const WHEEL_FRAME_DELAY_MAX_MS: u64 = 60;
static KEYBOARD_SEQUENCE: AtomicU64 = AtomicU64::new(1);
static WHEEL_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum TextInputFailure {
    Cancelled,
    Deadline,
    Engine,
    TargetLost,
}

#[derive(Debug)]
pub(crate) enum WheelInputFailure {
    Cancelled,
    Deadline,
    Cdp(EngineError),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct WheelFrame {
    delta_y: i64,
    delay_ms: u64,
}

#[derive(Debug, Eq, PartialEq)]
struct WheelGesture {
    target_distance_px: i64,
    frames: Vec<WheelFrame>,
}

pub(crate) async fn dispatch_wheel_humanized(
    cdp: &mut CdpSession,
    x: f64,
    y: f64,
    baseline_distance_px: f64,
    cancellation: Option<&AtomicBool>,
    deadline_unix_ms: u64,
) -> Result<(), WheelInputFailure> {
    ensure_wheel_input_active(cancellation, deadline_unix_ms)?;
    let mut rhythm = WheelRhythm::new();
    let gesture = generate_wheel_gesture(baseline_distance_px, &mut rhythm);
    cdp.dispatch_mouse("mouseMoved", x, y, "none", 0)
        .await
        .map_err(WheelInputFailure::Cdp)?;
    for frame in gesture.frames {
        ensure_wheel_input_active(cancellation, deadline_unix_ms)?;
        cdp.dispatch_wheel(x, y, frame.delta_y as f64)
            .await
            .map_err(WheelInputFailure::Cdp)?;
        wait_before_next_wheel_frame(frame.delay_ms, cancellation, deadline_unix_ms).await?;
    }
    Ok(())
}

pub(crate) async fn type_text_humanized(
    cdp: &mut CdpSession,
    value: &str,
    cancellation: Option<&AtomicBool>,
    deadline_unix_ms: u64,
) -> Result<usize, TextInputFailure> {
    type_text_humanized_inner(cdp, value, cancellation, deadline_unix_ms, None).await
}

pub(crate) async fn type_text_humanized_guarded(
    cdp: &mut CdpSession,
    value: &str,
    cancellation: Option<&AtomicBool>,
    deadline_unix_ms: u64,
    target_guard_expression: &str,
) -> Result<usize, TextInputFailure> {
    type_text_humanized_inner(
        cdp,
        value,
        cancellation,
        deadline_unix_ms,
        Some(target_guard_expression),
    )
    .await
}

async fn type_text_humanized_inner(
    cdp: &mut CdpSession,
    value: &str,
    cancellation: Option<&AtomicBool>,
    deadline_unix_ms: u64,
    target_guard_expression: Option<&str>,
) -> Result<usize, TextInputFailure> {
    let mut rhythm = KeyboardRhythm::new();
    let mut typed = 0;
    for character in value.chars() {
        wait_before_character(
            rhythm.flight_delay_ms(character),
            cancellation,
            deadline_unix_ms,
        )
        .await?;
        if let Some(expression) = target_guard_expression {
            let result = cdp
                .evaluate(expression, true)
                .await
                .map_err(|_| TextInputFailure::Engine)?;
            let target_current = result
                .pointer("/result/value/output")
                .is_some_and(|output| {
                    output.get("kind").and_then(serde_json::Value::as_str) == Some("text_target")
                        && output
                            .pointer("/value/ok")
                            .and_then(serde_json::Value::as_bool)
                            == Some(true)
                        && output
                            .pointer("/value/focused")
                            .and_then(serde_json::Value::as_bool)
                            == Some(true)
                });
            if !target_current {
                return Err(TextInputFailure::TargetLost);
            }
        }
        cdp.insert_text(&character.to_string())
            .await
            .map_err(|_| TextInputFailure::Engine)?;
        typed += 1;
    }
    Ok(typed)
}

pub(crate) async fn type_captcha_with_key_events(
    cdp: &mut CdpSession,
    value: &str,
    cancellation: Option<&AtomicBool>,
    deadline_unix_ms: u64,
) -> Result<usize, TextInputFailure> {
    let mut rhythm = KeyboardRhythm::new();
    let mut typed = 0;
    let mut last_rtt_ms = 0_u64;
    for character in value.chars() {
        let wait_ms = rhythm
            .flight_delay_ms(character)
            .saturating_sub(last_rtt_ms);
        wait_before_character(wait_ms, cancellation, deadline_unix_ms).await?;
        let spec = captcha_key_spec(character).ok_or(TextInputFailure::Engine)?;
        let dwell_ms = rhythm.dwell_delay_ms();
        let started = Instant::now();
        commit_captcha_key_stroke(cdp, &spec, dwell_ms).await?;
        typed += 1;
        let elapsed_ms = started.elapsed().as_millis().try_into().unwrap_or(u64::MAX);
        last_rtt_ms = elapsed_ms.saturating_sub(dwell_ms);
    }
    Ok(typed)
}

pub(crate) fn valid_captcha_text(value: &str) -> bool {
    let count = value.chars().count();
    count > 0
        && count <= CAPTCHA_TEXT_MAX_CHARS
        && value
            .chars()
            .all(|character| captcha_key_spec(character).is_some())
}

async fn wait_before_character(
    delay_ms: u64,
    cancellation: Option<&AtomicBool>,
    deadline_unix_ms: u64,
) -> Result<(), TextInputFailure> {
    let delay = Duration::from_millis(delay_ms);
    if let Some(cancellation) = cancellation {
        tokio::select! {
            _ = wait_for_cancellation(cancellation) => {
                return Err(TextInputFailure::Cancelled);
            }
            _ = tokio::time::sleep(delay) => {}
        }
    } else {
        tokio::time::sleep(delay).await;
    }
    if cancellation.is_some_and(|value| value.load(Ordering::Acquire)) {
        return Err(TextInputFailure::Cancelled);
    }
    if unix_time_ms() >= deadline_unix_ms {
        return Err(TextInputFailure::Deadline);
    }
    Ok(())
}

async fn wait_for_cancellation(cancellation: &AtomicBool) {
    while !cancellation.load(Ordering::Acquire) {
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

fn ensure_wheel_input_active(
    cancellation: Option<&AtomicBool>,
    deadline_unix_ms: u64,
) -> Result<(), WheelInputFailure> {
    if cancellation.is_some_and(|value| value.load(Ordering::Acquire)) {
        return Err(WheelInputFailure::Cancelled);
    }
    if unix_time_ms() >= deadline_unix_ms {
        return Err(WheelInputFailure::Deadline);
    }
    Ok(())
}

async fn wait_before_next_wheel_frame(
    delay_ms: u64,
    cancellation: Option<&AtomicBool>,
    deadline_unix_ms: u64,
) -> Result<(), WheelInputFailure> {
    let delay = Duration::from_millis(delay_ms);
    if let Some(cancellation) = cancellation {
        tokio::select! {
            _ = wait_for_cancellation(cancellation) => {
                return Err(WheelInputFailure::Cancelled);
            }
            _ = tokio::time::sleep(delay) => {}
        }
    } else {
        tokio::time::sleep(delay).await;
    }
    ensure_wheel_input_active(cancellation, deadline_unix_ms)
}

struct WheelRhythm {
    state: u64,
}

impl WheelRhythm {
    fn new() -> Self {
        Self::from_seed(
            unix_time_ms()
                ^ WHEEL_SEQUENCE
                    .fetch_add(1, Ordering::Relaxed)
                    .wrapping_mul(0xD1B5_4A32_D192_ED03),
        )
    }

    fn from_seed(seed: u64) -> Self {
        Self { state: seed | 1 }
    }

    fn random(&mut self) -> f64 {
        let mut value = self.state;
        value ^= value >> 12;
        value ^= value << 25;
        value ^= value >> 27;
        self.state = value;
        let bits = value.wrapping_mul(0x2545_F491_4F6C_DD1D) >> 11;
        bits as f64 / (1_u64 << 53) as f64
    }

    fn random_inclusive(&mut self, min: usize, max: usize) -> usize {
        min + (self.random() * (max - min + 1) as f64).floor() as usize
    }
}

fn generate_wheel_gesture(baseline_distance_px: f64, rhythm: &mut WheelRhythm) -> WheelGesture {
    let direction = if baseline_distance_px < 0.0 { -1 } else { 1 };
    let baseline = baseline_distance_px.abs().round().max(1.0);
    let target_distance_px =
        (baseline * (1.0 + (rhythm.random() - 0.5) * 0.4)).round() as i64 * direction;
    let frame_count = rhythm.random_inclusive(WHEEL_FRAME_COUNT_MIN, WHEEL_FRAME_COUNT_MAX);
    let mut weights = Vec::with_capacity(frame_count);
    let mut total_weight = 0.0;
    for index in 0..frame_count {
        let position = index as f64 / (frame_count - 1) as f64;
        let envelope = (PI * position).sin() * 0.85 + 0.15;
        let weight = envelope * (0.85 + rhythm.random() * 0.3);
        weights.push(weight);
        total_weight += weight;
    }
    let mut allocated = 0_i64;
    let magnitude = target_distance_px.abs();
    let frames = weights
        .into_iter()
        .enumerate()
        .map(|(index, weight)| {
            let delta = if index + 1 == frame_count {
                magnitude - allocated
            } else {
                let value = (weight / total_weight * magnitude as f64).round() as i64;
                allocated += value;
                value
            };
            WheelFrame {
                delta_y: delta * direction,
                delay_ms: rhythm.random_inclusive(
                    WHEEL_FRAME_DELAY_MIN_MS as usize,
                    WHEEL_FRAME_DELAY_MAX_MS as usize,
                ) as u64,
            }
        })
        .collect();
    WheelGesture {
        target_distance_px,
        frames,
    }
}

struct KeyboardRhythm {
    state: u64,
}

impl KeyboardRhythm {
    fn new() -> Self {
        Self {
            state: (unix_time_ms()
                ^ KEYBOARD_SEQUENCE
                    .fetch_add(1, Ordering::Relaxed)
                    .wrapping_mul(0x9E37_79B9_7F4A_7C15))
                | 1,
        }
    }

    fn random(&mut self) -> f64 {
        let mut value = self.state;
        value ^= value >> 12;
        value ^= value << 25;
        value ^= value >> 27;
        self.state = value;
        let bits = value.wrapping_mul(0x2545_F491_4F6C_DD1D) >> 11;
        bits as f64 / (1_u64 << 53) as f64
    }

    fn gaussian(&mut self) -> f64 {
        let first = self.random().max(f64::MIN_POSITIVE);
        let second = self.random();
        (-2.0 * first.ln()).sqrt() * (TAU * second).cos()
    }

    fn flight_delay_ms(&mut self, character: char) -> u64 {
        let gaussian = self.gaussian();
        let mut delay = (110_f64.ln() + 0.35 * gaussian).exp();
        if character.is_whitespace()
            || matches!(
                character,
                '.' | ','
                    | '!'
                    | '?'
                    | ';'
                    | ':'
                    | '，'
                    | '。'
                    | '！'
                    | '？'
                    | '；'
                    | '：'
                    | '、'
                    | '…'
                    | '—'
            )
        {
            delay *= 1.4;
        }
        delay = delay.clamp(40.0, 400.0);
        if self.random() < 0.08 {
            delay += 300.0 + self.random() * 300.0;
        }
        delay.round() as u64
    }

    fn dwell_delay_ms(&mut self) -> u64 {
        (75_f64.ln() + 0.3 * self.gaussian())
            .exp()
            .clamp(30.0, 180.0)
            .round() as u64
    }
}

struct CaptchaKeySpec {
    key: String,
    code: &'static str,
    virtual_key_code: u32,
    needs_shift: bool,
}

fn captcha_key_spec(character: char) -> Option<CaptchaKeySpec> {
    if character.is_ascii_alphabetic() {
        let upper = character.to_ascii_uppercase();
        let code = match upper {
            'A' => "KeyA",
            'B' => "KeyB",
            'C' => "KeyC",
            'D' => "KeyD",
            'E' => "KeyE",
            'F' => "KeyF",
            'G' => "KeyG",
            'H' => "KeyH",
            'I' => "KeyI",
            'J' => "KeyJ",
            'K' => "KeyK",
            'L' => "KeyL",
            'M' => "KeyM",
            'N' => "KeyN",
            'O' => "KeyO",
            'P' => "KeyP",
            'Q' => "KeyQ",
            'R' => "KeyR",
            'S' => "KeyS",
            'T' => "KeyT",
            'U' => "KeyU",
            'V' => "KeyV",
            'W' => "KeyW",
            'X' => "KeyX",
            'Y' => "KeyY",
            'Z' => "KeyZ",
            _ => return None,
        };
        return Some(CaptchaKeySpec {
            key: character.to_string(),
            code,
            virtual_key_code: upper as u32,
            needs_shift: character.is_ascii_uppercase(),
        });
    }
    if character.is_ascii_digit() {
        let code = match character {
            '0' => "Digit0",
            '1' => "Digit1",
            '2' => "Digit2",
            '3' => "Digit3",
            '4' => "Digit4",
            '5' => "Digit5",
            '6' => "Digit6",
            '7' => "Digit7",
            '8' => "Digit8",
            '9' => "Digit9",
            _ => return None,
        };
        return Some(CaptchaKeySpec {
            key: character.to_string(),
            code,
            virtual_key_code: character as u32,
            needs_shift: false,
        });
    }
    let (code, virtual_key_code, needs_shift) = match character {
        ' ' => ("Space", 0x20, false),
        '-' => ("Minus", 0xbd, false),
        '=' => ("Equal", 0xbb, false),
        '[' => ("BracketLeft", 0xdb, false),
        ']' => ("BracketRight", 0xdd, false),
        '\\' => ("Backslash", 0xdc, false),
        ';' => ("Semicolon", 0xba, false),
        '\'' => ("Quote", 0xde, false),
        ',' => ("Comma", 0xbc, false),
        '.' => ("Period", 0xbe, false),
        '/' => ("Slash", 0xbf, false),
        '`' => ("Backquote", 0xc0, false),
        '!' => ("Digit1", 0x31, true),
        '@' => ("Digit2", 0x32, true),
        '#' => ("Digit3", 0x33, true),
        '$' => ("Digit4", 0x34, true),
        '%' => ("Digit5", 0x35, true),
        '^' => ("Digit6", 0x36, true),
        '&' => ("Digit7", 0x37, true),
        '*' => ("Digit8", 0x38, true),
        '(' => ("Digit9", 0x39, true),
        ')' => ("Digit0", 0x30, true),
        '_' => ("Minus", 0xbd, true),
        '+' => ("Equal", 0xbb, true),
        '{' => ("BracketLeft", 0xdb, true),
        '}' => ("BracketRight", 0xdd, true),
        '|' => ("Backslash", 0xdc, true),
        ':' => ("Semicolon", 0xba, true),
        '"' => ("Quote", 0xde, true),
        '<' => ("Comma", 0xbc, true),
        '>' => ("Period", 0xbe, true),
        '?' => ("Slash", 0xbf, true),
        '~' => ("Backquote", 0xc0, true),
        _ => return None,
    };
    Some(CaptchaKeySpec {
        key: character.to_string(),
        code,
        virtual_key_code,
        needs_shift,
    })
}

async fn commit_captcha_key_stroke(
    cdp: &mut CdpSession,
    spec: &CaptchaKeySpec,
    dwell_ms: u64,
) -> Result<(), TextInputFailure> {
    if spec.needs_shift {
        cdp.dispatch_key_with_modifiers("rawKeyDown", "Shift", "ShiftLeft", 0x10, SHIFT_MODIFIER)
            .await
            .map_err(|_| TextInputFailure::Engine)?;
    }
    let character_result = async {
        let key_down = cdp
            .dispatch_key_with_text_and_modifiers(
                "keyDown",
                &spec.key,
                spec.code,
                spec.virtual_key_code,
                &spec.key,
                if spec.needs_shift { SHIFT_MODIFIER } else { 0 },
            )
            .await;
        if key_down.is_ok() {
            tokio::time::sleep(Duration::from_millis(dwell_ms)).await;
        }
        let key_up = cdp
            .dispatch_key_with_modifiers(
                "keyUp",
                &spec.key,
                spec.code,
                spec.virtual_key_code,
                if spec.needs_shift { SHIFT_MODIFIER } else { 0 },
            )
            .await;
        key_down.and(key_up).map_err(|_| TextInputFailure::Engine)
    }
    .await;
    let shift_up_result = if spec.needs_shift {
        cdp.dispatch_key_with_modifiers("keyUp", "Shift", "ShiftLeft", 0x10, 0)
            .await
            .map_err(|_| TextInputFailure::Engine)
    } else {
        Ok(serde_json::Value::Null)
    };
    character_result?;
    shift_up_result?;
    Ok(())
}

fn unix_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn captcha_key_map_covers_visible_ascii_and_rejects_everything_else() {
        assert!((0x20_u8..=0x7e).all(|value| captcha_key_spec(value as char).is_some()));
        assert!(captcha_key_spec('\n').is_none());
        assert!(captcha_key_spec('中').is_none());
    }

    #[test]
    fn captcha_text_validation_enforces_the_contract_boundary() {
        assert!(valid_captcha_text("3n7K!?"));
        assert!(!valid_captcha_text(""));
        assert!(!valid_captcha_text(&"x".repeat(CAPTCHA_TEXT_MAX_CHARS + 1)));
        assert!(!valid_captcha_text("验证码"));
    }

    #[test]
    fn wheel_gesture_preserves_humanized_shape_and_exact_distance() {
        for seed in 1..=64 {
            let mut rhythm = WheelRhythm::from_seed(seed);
            let gesture = generate_wheel_gesture(650.0, &mut rhythm);
            assert!((520..=780).contains(&gesture.target_distance_px));
            assert!(
                (WHEEL_FRAME_COUNT_MIN..=WHEEL_FRAME_COUNT_MAX).contains(&gesture.frames.len())
            );
            assert_eq!(
                gesture
                    .frames
                    .iter()
                    .map(|frame| frame.delta_y)
                    .sum::<i64>(),
                gesture.target_distance_px
            );
            assert!(gesture.frames.iter().all(|frame| {
                (WHEEL_FRAME_DELAY_MIN_MS..=WHEEL_FRAME_DELAY_MAX_MS).contains(&frame.delay_ms)
            }));
            let peak = gesture
                .frames
                .iter()
                .enumerate()
                .max_by_key(|(_, frame)| frame.delta_y.abs())
                .map(|(index, _)| index)
                .expect("wheel frame");
            assert!(peak > 0 && peak + 1 < gesture.frames.len());
        }
    }

    #[test]
    fn wheel_gesture_preserves_upward_direction() {
        let mut rhythm = WheelRhythm::from_seed(7);
        let gesture = generate_wheel_gesture(-650.0, &mut rhythm);
        assert!(gesture.target_distance_px < 0);
        assert!(gesture.frames.iter().all(|frame| frame.delta_y <= 0));
        assert_eq!(
            gesture
                .frames
                .iter()
                .map(|frame| frame.delta_y)
                .sum::<i64>(),
            gesture.target_distance_px
        );
    }
}
