use crate::cdp::CdpSession;
use crate::error::EngineError;
use std::f64::consts::{PI, TAU};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const SHIFT_MODIFIER: u8 = 8;
const CAPTCHA_TEXT_MAX_CHARS: usize = 24;
const WHEEL_FRAME_COUNT_MIN: usize = 8;
const WHEEL_FRAME_COUNT_MAX: usize = 15;
const WHEEL_FRAME_DELAY_MIN_MS: u64 = 16;
const WHEEL_FRAME_DELAY_MAX_MS: u64 = 60;
/// 手势之后的重探间隔：围绕中心值的对数正态分散度。固定间隔本身是机器特征。
const PAUSE_SIGMA: f64 = 0.25;
const PAUSE_MIN_RATIO: f64 = 0.55;
const PAUSE_MAX_RATIO: f64 = 1.8;
/// 指针轨迹：点数 ∝ 距离（距离 / 8），裁进 [15, 60]。
const POINTER_FRAME_COUNT_MIN: usize = 15;
const POINTER_FRAME_COUNT_MAX: usize = 60;
const POINTER_FRAME_DISTANCE_DIVISOR: f64 = 8.0;
/// 逐帧移动间的延迟中心值（约 120fps），每帧叠对数正态抖动打散「帧间隔方差为 0」这一机器特征。
const POINTER_FRAME_DELAY_CENTER_MS: f64 = 8.0;
const POINTER_FRAME_DELAY_SIGMA: f64 = 0.35;
const POINTER_FRAME_DELAY_MIN_MS: u64 = 3;
const POINTER_FRAME_DELAY_MAX_MS: u64 = 26;
/// 落点抖动（像素）：真实落点 = 目标 ± 抖动，绝不每次都精确命中几何中心。
const POINTER_LANDING_JITTER_PX: f64 = 3.0;
/// 两个控制点的法向偏移幅度 = U(0.1, 0.3) × 起终距离，左右随机 —— 产生自然弧线而非直线。
const POINTER_CONTROL_OFFSET_MIN_RATIO: f64 = 0.1;
const POINTER_CONTROL_OFFSET_MAX_RATIO: f64 = 0.3;
/// 过冲：15% 概率在抵达后沿运动方向多走 5~15px 再回拉到落点。
const POINTER_OVERSHOOT_PROBABILITY: f64 = 0.15;
const POINTER_OVERSHOOT_MIN_PX: f64 = 5.0;
const POINTER_OVERSHOOT_MAX_PX: f64 = 15.0;
/// 无历史落点时的默认起步点：目标左上方一段随机距离（模拟光标本来在别处）。
const POINTER_ORIGIN_OFFSET_MIN_PX: f64 = 40.0;
const POINTER_ORIGIN_OFFSET_MAX_PX: f64 = 160.0;
/// 移动到位后、按下之前的瞄准停顿。
const POINTER_AIM_DWELL_CENTER_MS: f64 = 70.0;
const POINTER_AIM_DWELL_MIN_MS: f64 = 35.0;
const POINTER_AIM_DWELL_MAX_MS: f64 = 180.0;
/// 极近距离不生成无意义曲线，直接一帧到位。
const POINTER_DEGENERATE_DISTANCE_PX: f64 = 2.0;
/// 轨迹最多吃掉剩余预算的这一份额；超预算时缩帧，**绝不**因此跳过按下 / 抬起配平。
const POINTER_FRAME_BUDGET_SHARE: u64 = 4;
static KEYBOARD_SEQUENCE: AtomicU64 = AtomicU64::new(1);
static WHEEL_SEQUENCE: AtomicU64 = AtomicU64::new(1);
static POINTER_SEQUENCE: AtomicU64 = AtomicU64::new(1);
/// 会话内最近一次的**真实落点**。引擎进程同一时刻只服务一个会话，故按进程持有即会话级；
/// 下一次点击默认从这里起步，使同一次互动内的连续点击形成连续光标轨迹
/// （两步点赞的第二步必须留在「控件 → 浮层」走廊内，见 D3）。
static LAST_POINTER_LANDING: Mutex<Option<PointerPoint>> = Mutex::new(None);

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

/// 一个可继承的落点。返回给调用方，供多点循环把上一落点当作下一点的起步点。
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct PointerPoint {
    pub(crate) x: f64,
    pub(crate) y: f64,
}

/// 指针点击的可选形状。默认值等价于「从最近一次落点起步、允许过冲」。
#[derive(Clone, Copy, Debug)]
pub(crate) struct PointerClickOptions {
    /// 显式起步点。None = 取会话内最近一次真实落点；再无历史才回落到目标左上方随机偏移。
    pub(crate) from: Option<PointerPoint>,
    /// 是否允许过冲回拉。贴着「控件 → 浮层」走廊走的提交必须禁用——过冲会甩出浮层 hover 区致其收起。
    pub(crate) allow_overshoot: bool,
}

impl Default for PointerClickOptions {
    fn default() -> Self {
        Self {
            from: None,
            allow_overshoot: true,
        }
    }
}

impl PointerClickOptions {
    pub(crate) fn from_corridor(from: PointerPoint) -> Self {
        Self {
            from: Some(from),
            allow_overshoot: false,
        }
    }
}

#[derive(Debug)]
pub(crate) enum PointerInputFailure {
    /// 按下之前被取消：一次提交都没派发，上游可安全重投。
    CancelledBeforePress,
    /// 按下之前超预算：同上，未开始。
    DeadlineBeforePress,
    /// 移动阶段的 CDP 失败：按下尚未派发。
    MoveFailed(EngineError),
    /// **按下已经派发出去**（点击可能已生效）之后才失败。诚实红线：MUST NOT 被上游当成
    /// 「压根没点」重投——那会双发。
    SubmitDispatched(EngineError),
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct PointerFrame {
    x: f64,
    y: f64,
    delay_ms: u64,
}

#[derive(Debug, PartialEq)]
struct PointerPath {
    frames: Vec<PointerFrame>,
    landing: PointerPoint,
}

/// 拟人化左键点击：沿三阶贝塞尔轨迹逐帧移动 → 瞄准停顿 → 提交式左键（按下 / 抬起配平）。
///
/// 取消与截止检查**全部前置到按下之前**；按下到抬起之间是原子区，即使取消信号已置位也必须
/// 先补发抬起——按下发了、抬起没发 = 左键按住不放，此后所有移动都变成拖拽 / 框选，页面被
/// 不可见地污染，而调用方只看到一个普通异常（见 design D4）。
pub(crate) async fn dispatch_pointer_click(
    cdp: &mut CdpSession,
    x: f64,
    y: f64,
    options: PointerClickOptions,
    cancellation: Option<&AtomicBool>,
    deadline_unix_ms: u64,
) -> Result<PointerPoint, PointerInputFailure> {
    let target = PointerPoint { x, y };
    let mut rhythm = PointerRhythm::new();
    let from = options
        .from
        .or_else(last_pointer_landing)
        .unwrap_or_else(|| default_pointer_origin(target, &mut rhythm));
    // 拟人化只许花掉剩余预算的一小份额：超预算时**缩帧、缩停顿**，绝不因为自己加的节奏
    // 把一次本可成功的点击拖成超时失败（那等于用拟人化制造新的失败路径）。
    let allowance_ms = pointer_time_allowance_ms(deadline_unix_ms);
    let path = generate_pointer_path(
        from,
        target,
        options.allow_overshoot,
        pointer_frame_budget(allowance_ms),
        &mut rhythm,
    );
    let spent_ms: u64 = path.frames.iter().map(|frame| frame.delay_ms).sum();
    for frame in &path.frames {
        ensure_pointer_input_active(cancellation, deadline_unix_ms)?;
        cdp.dispatch_mouse("mouseMoved", frame.x, frame.y, "none", 0)
            .await
            .map_err(PointerInputFailure::MoveFailed)?;
        wait_before_next_pointer_frame(frame.delay_ms, cancellation, deadline_unix_ms).await?;
    }
    // 移动到位后、按下之前的瞄准停顿，同样受预算裁剪。
    let aim_dwell_ms = rhythm
        .aim_dwell_ms()
        .min(allowance_ms.saturating_sub(spent_ms));
    wait_before_next_pointer_frame(aim_dwell_ms, cancellation, deadline_unix_ms).await?;
    // 按下之前是点击路径的**最后一个安全边界**：过了这一行，点击必须原子完成。
    ensure_pointer_input_active(cancellation, deadline_unix_ms)?;
    remember_pointer_landing(path.landing);
    let pressed = cdp
        .dispatch_mouse("mousePressed", path.landing.x, path.landing.y, "left", 1)
        .await;
    // 无条件补发抬起（等价于退役实现的 try/finally）。补发自身的失败被吞掉，不覆盖原始错误。
    let released = cdp
        .dispatch_mouse("mouseReleased", path.landing.x, path.landing.y, "left", 1)
        .await;
    if let Err(error) = pressed {
        return Err(PointerInputFailure::SubmitDispatched(error));
    }
    released.map_err(PointerInputFailure::SubmitDispatched)?;
    Ok(path.landing)
}

/// 围绕中心值的对数正态停顿采样。用来取代散落在动作之间的固定间隔。
pub(crate) fn sample_pause_ms(center_ms: f64) -> u64 {
    let center = center_ms.max(1.0);
    let mut rhythm = PointerRhythm::new();
    (center.ln() + PAUSE_SIGMA * rhythm.gaussian())
        .exp()
        .clamp(center * PAUSE_MIN_RATIO, center * PAUSE_MAX_RATIO)
        .round() as u64
}

fn last_pointer_landing() -> Option<PointerPoint> {
    LAST_POINTER_LANDING
        .lock()
        .ok()
        .and_then(|landing| *landing)
}

fn remember_pointer_landing(landing: PointerPoint) {
    if let Ok(mut slot) = LAST_POINTER_LANDING.lock() {
        *slot = Some(landing);
    }
}

fn default_pointer_origin(target: PointerPoint, rhythm: &mut PointerRhythm) -> PointerPoint {
    let span = POINTER_ORIGIN_OFFSET_MAX_PX - POINTER_ORIGIN_OFFSET_MIN_PX;
    PointerPoint {
        x: (target.x - (POINTER_ORIGIN_OFFSET_MIN_PX + rhythm.random() * span)).max(0.0),
        y: (target.y - (POINTER_ORIGIN_OFFSET_MIN_PX + rhythm.random() * span)).max(0.0),
    }
}

/// 本次点击允许花在拟人化上的墙钟预算（剩余预算的一份额）。
fn pointer_time_allowance_ms(deadline_unix_ms: u64) -> u64 {
    let now = unix_time_ms();
    if deadline_unix_ms <= now {
        return 0;
    }
    (deadline_unix_ms - now) / POINTER_FRAME_BUDGET_SHARE
}

/// 帧预算：按帧间中心值把墙钟预算折算成帧数，超预算就**缩帧**——绝不因此跳过配平。
fn pointer_frame_budget(allowance_ms: u64) -> usize {
    let frames = allowance_ms / POINTER_FRAME_DELAY_CENTER_MS.round() as u64;
    (frames.max(1) as usize).min(POINTER_FRAME_COUNT_MAX)
}

fn ensure_pointer_input_active(
    cancellation: Option<&AtomicBool>,
    deadline_unix_ms: u64,
) -> Result<(), PointerInputFailure> {
    if cancellation.is_some_and(|value| value.load(Ordering::Acquire)) {
        return Err(PointerInputFailure::CancelledBeforePress);
    }
    if unix_time_ms() >= deadline_unix_ms {
        return Err(PointerInputFailure::DeadlineBeforePress);
    }
    Ok(())
}

async fn wait_before_next_pointer_frame(
    delay_ms: u64,
    cancellation: Option<&AtomicBool>,
    deadline_unix_ms: u64,
) -> Result<(), PointerInputFailure> {
    let delay = Duration::from_millis(delay_ms);
    if let Some(cancellation) = cancellation {
        tokio::select! {
            _ = wait_for_cancellation(cancellation) => {
                return Err(PointerInputFailure::CancelledBeforePress);
            }
            _ = tokio::time::sleep(delay) => {}
        }
    } else {
        tokio::time::sleep(delay).await;
    }
    ensure_pointer_input_active(cancellation, deadline_unix_ms)
}

/// 生成一条三阶贝塞尔轨迹：控制点落在起终连线的 1/3、2/3 处并各叠一个方向随机的法向偏移，
/// 时间参数走 ease-in-out（两端密、中段疏 = 起步慢 / 中段快 / 逼近再慢）。
fn generate_pointer_path(
    from: PointerPoint,
    to: PointerPoint,
    allow_overshoot: bool,
    frame_budget: usize,
    rhythm: &mut PointerRhythm,
) -> PointerPath {
    let landing = PointerPoint {
        x: (to.x + rhythm.symmetric(POINTER_LANDING_JITTER_PX)).round(),
        y: (to.y + rhythm.symmetric(POINTER_LANDING_JITTER_PX)).round(),
    };
    let delta_x = landing.x - from.x;
    let delta_y = landing.y - from.y;
    let distance = delta_x.hypot(delta_y);
    let budget = frame_budget.max(1);
    if distance <= POINTER_DEGENERATE_DISTANCE_PX || budget == 1 {
        return PointerPath {
            frames: vec![PointerFrame {
                x: landing.x,
                y: landing.y,
                delay_ms: rhythm.frame_delay_ms(),
            }],
            landing,
        };
    }
    let count = ((distance / POINTER_FRAME_DISTANCE_DIVISOR).round() as usize)
        .clamp(POINTER_FRAME_COUNT_MIN, POINTER_FRAME_COUNT_MAX)
        .min(budget);
    let normal_x = -delta_y / distance;
    let normal_y = delta_x / distance;
    let first_offset = rhythm.control_offset(distance);
    let second_offset = rhythm.control_offset(distance);
    let first_control = PointerPoint {
        x: from.x + delta_x / 3.0 + normal_x * first_offset,
        y: from.y + delta_y / 3.0 + normal_y * first_offset,
    };
    let second_control = PointerPoint {
        x: from.x + delta_x * 2.0 / 3.0 + normal_x * second_offset,
        y: from.y + delta_y * 2.0 / 3.0 + normal_y * second_offset,
    };
    let mut frames = Vec::with_capacity(count + 1);
    for step in 1..=count {
        let progress = ease_in_out(step as f64 / count as f64);
        let point = cubic_bezier(from, first_control, second_control, landing, progress);
        frames.push(PointerFrame {
            x: point.x.round(),
            y: point.y.round(),
            delay_ms: rhythm.frame_delay_ms(),
        });
    }
    if allow_overshoot && rhythm.random() < POINTER_OVERSHOOT_PROBABILITY {
        let span = POINTER_OVERSHOOT_MAX_PX - POINTER_OVERSHOOT_MIN_PX;
        let reach = POINTER_OVERSHOOT_MIN_PX + rhythm.random() * span;
        let overshoot = PointerFrame {
            x: (landing.x + delta_x / distance * reach).round(),
            y: (landing.y + delta_y / distance * reach).round(),
            delay_ms: rhythm.frame_delay_ms(),
        };
        // 抵达后先越过落点，再回拉——末帧恒为落点。
        frames.insert(frames.len() - 1, overshoot);
    }
    PointerPath { frames, landing }
}

fn ease_in_out(progress: f64) -> f64 {
    if progress < 0.5 {
        4.0 * progress * progress * progress
    } else {
        let shifted = -2.0 * progress + 2.0;
        1.0 - shifted * shifted * shifted / 2.0
    }
}

fn cubic_bezier(
    start: PointerPoint,
    first_control: PointerPoint,
    second_control: PointerPoint,
    end: PointerPoint,
    progress: f64,
) -> PointerPoint {
    let inverse = 1.0 - progress;
    let start_weight = inverse * inverse * inverse;
    let first_weight = 3.0 * inverse * inverse * progress;
    let second_weight = 3.0 * inverse * progress * progress;
    let end_weight = progress * progress * progress;
    PointerPoint {
        x: start.x * start_weight
            + first_control.x * first_weight
            + second_control.x * second_weight
            + end.x * end_weight,
        y: start.y * start_weight
            + first_control.y * first_weight
            + second_control.y * second_weight
            + end.y * end_weight,
    }
}

struct PointerRhythm {
    state: u64,
}

impl PointerRhythm {
    fn new() -> Self {
        Self::from_seed(
            unix_time_ms()
                ^ POINTER_SEQUENCE
                    .fetch_add(1, Ordering::Relaxed)
                    .wrapping_mul(0xA076_1D64_78BD_642F),
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

    fn gaussian(&mut self) -> f64 {
        let first = self.random().max(f64::MIN_POSITIVE);
        let second = self.random();
        (-2.0 * first.ln()).sqrt() * (TAU * second).cos()
    }

    fn symmetric(&mut self, span: f64) -> f64 {
        (self.random() * 2.0 - 1.0) * span
    }

    fn control_offset(&mut self, distance: f64) -> f64 {
        let ratio = POINTER_CONTROL_OFFSET_MIN_RATIO
            + self.random() * (POINTER_CONTROL_OFFSET_MAX_RATIO - POINTER_CONTROL_OFFSET_MIN_RATIO);
        let side = if self.random() < 0.5 { -1.0 } else { 1.0 };
        ratio * distance * side
    }

    fn frame_delay_ms(&mut self) -> u64 {
        (POINTER_FRAME_DELAY_CENTER_MS.ln() + POINTER_FRAME_DELAY_SIGMA * self.gaussian())
            .exp()
            .clamp(
                POINTER_FRAME_DELAY_MIN_MS as f64,
                POINTER_FRAME_DELAY_MAX_MS as f64,
            )
            .round() as u64
    }

    fn aim_dwell_ms(&mut self) -> u64 {
        (POINTER_AIM_DWELL_CENTER_MS.ln() + PAUSE_SIGMA * self.gaussian())
            .exp()
            .clamp(POINTER_AIM_DWELL_MIN_MS, POINTER_AIM_DWELL_MAX_MS)
            .round() as u64
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

    /// 反证「瞬移」：一次点击的移动帧必须多于 1 帧，且末帧落在目标的有界抖动范围内。
    #[test]
    fn pointer_path_is_multi_frame_and_lands_within_bounded_jitter() {
        for seed in 1..=64 {
            let mut rhythm = PointerRhythm::from_seed(seed);
            let from = PointerPoint { x: 120.0, y: 640.0 };
            let to = PointerPoint { x: 720.0, y: 300.0 };
            let path = generate_pointer_path(from, to, true, POINTER_FRAME_COUNT_MAX, &mut rhythm);
            assert!(
                path.frames.len() > 1,
                "点击必须逐帧移动，不得瞬移到目标坐标"
            );
            assert!(
                (POINTER_FRAME_COUNT_MIN..=POINTER_FRAME_COUNT_MAX + 1)
                    .contains(&path.frames.len())
            );
            assert!((path.landing.x - to.x).abs() <= POINTER_LANDING_JITTER_PX);
            assert!((path.landing.y - to.y).abs() <= POINTER_LANDING_JITTER_PX);
            let last = path.frames.last().expect("pointer frame");
            assert_eq!((last.x, last.y), (path.landing.x, path.landing.y));
            assert!(
                path.frames
                    .iter()
                    .all(|frame| frame.x.fract() == 0.0 && frame.y.fract() == 0.0),
                "所有轨迹点必须是整数像素"
            );
        }
    }

    /// 反证「线性插值」：水平连线上必须出现垂直于连线的偏移（弧线，而非直线）。
    #[test]
    fn pointer_path_bows_off_the_straight_line() {
        for seed in 1..=64 {
            let mut rhythm = PointerRhythm::from_seed(seed);
            let from = PointerPoint { x: 100.0, y: 400.0 };
            let to = PointerPoint { x: 700.0, y: 400.0 };
            let path = generate_pointer_path(from, to, false, POINTER_FRAME_COUNT_MAX, &mut rhythm);
            let deviation = path
                .frames
                .iter()
                .map(|frame| (frame.y - 400.0).abs())
                .fold(0.0_f64, f64::max);
            assert!(
                deviation > 5.0,
                "轨迹必须是弧线：seed={seed} 最大法向偏移 {deviation}"
            );
        }
    }

    /// 反证「等周期帧」：帧间延迟必须非恒定（dt 方差为 0 本身是机器特征）。
    #[test]
    fn pointer_frame_delays_are_not_constant() {
        for seed in 1..=64 {
            let mut rhythm = PointerRhythm::from_seed(seed);
            let path = generate_pointer_path(
                PointerPoint { x: 40.0, y: 40.0 },
                PointerPoint { x: 640.0, y: 480.0 },
                true,
                POINTER_FRAME_COUNT_MAX,
                &mut rhythm,
            );
            let first = path.frames[0].delay_ms;
            assert!(
                path.frames.iter().any(|frame| frame.delay_ms != first),
                "帧间延迟不得恒定：seed={seed}"
            );
            assert!(path.frames.iter().all(|frame| {
                (POINTER_FRAME_DELAY_MIN_MS..=POINTER_FRAME_DELAY_MAX_MS).contains(&frame.delay_ms)
            }));
        }
    }

    /// ease-in-out：中段步距大于首尾步距（Fitts 形态：起步慢、中段快、逼近再慢）。
    #[test]
    fn pointer_path_accelerates_then_decelerates() {
        let mut rhythm = PointerRhythm::from_seed(11);
        let from = PointerPoint { x: 0.0, y: 0.0 };
        let path = generate_pointer_path(
            from,
            PointerPoint { x: 800.0, y: 0.0 },
            false,
            POINTER_FRAME_COUNT_MAX,
            &mut rhythm,
        );
        let step = |index: usize| -> f64 {
            let current = path.frames[index];
            let previous = if index == 0 {
                PointerFrame {
                    x: from.x,
                    y: from.y,
                    delay_ms: 0,
                }
            } else {
                path.frames[index - 1]
            };
            (current.x - previous.x).hypot(current.y - previous.y)
        };
        let middle = step(path.frames.len() / 2);
        assert!(middle > step(0));
        assert!(middle > step(path.frames.len() - 1));
    }

    /// 过冲：末段先越过落点再回拉，末帧仍恒为落点。
    #[test]
    fn pointer_path_overshoots_and_pulls_back_when_allowed() {
        let mut overshot = 0;
        for seed in 1..=256 {
            let mut rhythm = PointerRhythm::from_seed(seed);
            let path = generate_pointer_path(
                PointerPoint { x: 0.0, y: 300.0 },
                PointerPoint { x: 600.0, y: 300.0 },
                true,
                POINTER_FRAME_COUNT_MAX,
                &mut rhythm,
            );
            let last = path.frames[path.frames.len() - 1];
            let penultimate = path.frames[path.frames.len() - 2];
            assert_eq!((last.x, last.y), (path.landing.x, path.landing.y));
            if penultimate.x > path.landing.x {
                let reach = penultimate.x - path.landing.x;
                assert!(
                    (POINTER_OVERSHOOT_MIN_PX - 1.0..=POINTER_OVERSHOOT_MAX_PX + 1.0)
                        .contains(&reach)
                );
                overshot += 1;
            }
        }
        assert!(overshot > 0, "允许过冲时必须存在「越过再回拉」的轨迹");
    }

    /// 禁过冲时绝不越过落点：贴住「控件 → 浮层」走廊，避免甩出 hover 区致浮层收起。
    #[test]
    fn pointer_path_never_overshoots_when_forbidden() {
        for seed in 1..=256 {
            let mut rhythm = PointerRhythm::from_seed(seed);
            let path = generate_pointer_path(
                PointerPoint { x: 0.0, y: 300.0 },
                PointerPoint { x: 600.0, y: 300.0 },
                false,
                POINTER_FRAME_COUNT_MAX,
                &mut rhythm,
            );
            assert!(
                path.frames
                    .iter()
                    .all(|frame| frame.x <= path.landing.x + 0.5),
                "禁过冲时不得越过落点：seed={seed}"
            );
        }
    }

    /// 极近距离退化为一帧；帧预算耗尽时同样缩到一帧（缩帧而非跳过配平）。
    #[test]
    fn pointer_path_degenerates_instead_of_drawing_a_pointless_curve() {
        let mut rhythm = PointerRhythm::from_seed(5);
        let path = generate_pointer_path(
            PointerPoint { x: 300.0, y: 300.0 },
            PointerPoint { x: 300.0, y: 300.0 },
            true,
            POINTER_FRAME_COUNT_MAX,
            &mut rhythm,
        );
        assert_eq!(path.frames.len(), 1);
        let mut rhythm = PointerRhythm::from_seed(6);
        let squeezed = generate_pointer_path(
            PointerPoint { x: 0.0, y: 0.0 },
            PointerPoint { x: 900.0, y: 0.0 },
            true,
            1,
            &mut rhythm,
        );
        assert_eq!(squeezed.frames.len(), 1);
    }

    /// 帧预算随剩余时间收缩，且**恒 ≥ 1**——预算再紧也只缩帧，不跳过按下 / 抬起配平。
    #[test]
    fn pointer_frame_budget_shrinks_with_the_remaining_deadline() {
        assert_eq!(pointer_time_allowance_ms(0), 0);
        assert_eq!(pointer_frame_budget(0), 1);
        assert_eq!(
            pointer_frame_budget(pointer_time_allowance_ms(u64::MAX)),
            POINTER_FRAME_COUNT_MAX
        );
        let tight = pointer_frame_budget(pointer_time_allowance_ms(unix_time_ms() + 240));
        assert!((1..POINTER_FRAME_COUNT_MAX).contains(&tight));
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
