use crate::cdp::CdpSession;
use std::f64::consts::TAU;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const SHIFT_MODIFIER: u8 = 8;
const CAPTCHA_TEXT_MAX_CHARS: usize = 24;
static KEYBOARD_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum TextInputFailure {
    Cancelled,
    Deadline,
    Engine,
}

pub(crate) async fn type_text_humanized(
    cdp: &mut CdpSession,
    value: &str,
    cancellation: Option<&AtomicBool>,
    deadline_unix_ms: u64,
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
}
