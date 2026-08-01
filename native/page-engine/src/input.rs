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
/// 分块突发式输入的封顶常量。**封顶只作用于「一次写多少字」与「块间停多久」，
/// 绝不作用于内容** —— 所有字符都必须写入，预算耗尽只允许诚实失败，不允许写一半报成功。
///
/// 上限 240 次往返 = 「再长的正文也不会把往返数拖成失控」；退役实现写死 50，那是按
/// 「云端 30s 单步 + 宿主一次性 insertText」的旧支出账定的，Native 形态下这 30s 还要
/// 多养活 IPC / 闸探页 / 开窗 / 目标 probe / 拟人点击 / 清空 / focus / 回读 / 提交确认 / 清场，
/// 所以数值不照抄，改由每次写入前按**剩余预算**现算（见 `plan_typing_step`）。
const TYPING_MAX_SENDS_CEILING: usize = 240;
/// 块间停顿的中心值上限。再长的停顿对「像人」没有增益，只是把预算烧掉。
const TYPING_PAUSE_CENTER_CEILING_MS: u64 = 220;
/// 一次 CDP 写入往返的初始保守估值；真实值由每次写入实测后单调抬升（见 `type_content_burst_humanized`）。
const TYPING_INITIAL_SEND_COST_MS: u64 = 60;
/// 剩余预算里给停顿的份额（1/2），另一半留给 CDP 往返本身。
const TYPING_PAUSE_BUDGET_SHARE: u64 = 2;
/// 逐字档里单次停顿的封顶倍数：预算宽裕时不裁（保留 8% 概率的长停顿这一人感特征），
/// 预算收紧时才由中心值的这个倍数封住尾部。
const TYPING_PER_CHAR_PAUSE_CAP_FACTOR: u64 = 4;
/// 一次写入还称得上「像人打的」的字符上限。**它不是封顶动作，是判据**：
/// 规划出的块超过它，说明剩余预算已经买不起拟人粒度，这一步是**降级**的。
/// 降级本身不被禁止（禁止它会把内容写不完，违反零丢失红线），但**绝不许无声发生** ——
/// 一次 1000 字的 `Input.insertText` 在时序特征上等价于退役实现的「原型 value setter 整段赋值」，
/// 正是本 change 要根除的机器特征；回执照报成功、日志里一行痕迹都没有，就是这条红线的输入侧形态。
const TYPING_HUMANE_CHUNK_CHARS: usize = 120;
/// 换行后的归尾确认：轮询间隔与**迭代次数**上限（按次数限界，不按墙钟死循环）。
const NEWLINE_STABILIZE_INTERVAL_MS: u64 = 80;
const NEWLINE_STABILIZE_MAX_ROUNDS: usize = 19;
/// 连续命中多少轮才算稳定。一次命中可能正落在编辑器的延迟选区事务之前。
const NEWLINE_STABILIZE_REQUIRED_HITS: u32 = 2;
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
    /// 换行后的归尾确认在预算内始终没稳住（**读到了、但没稳**）。
    /// 与 `Engine`（探针根本读不到）分开：把「读不到」压成「没稳住」等于把不知道说成知道。
    NewlineUnstable,
}

/// 验证码键入的失败**带上已派发字符数**（change restore-native-xiaohongshu-session-guards 任务 3.5）。
///
/// 为什么把计数放进错误值而不是做成出参：出参形态下调用方可以完全无视它、照样编译通过，
/// 而「写了结构没接线」正是本 change 要消灭的形态。做成错误值的字段后，调用方要拿到 `failure`
/// 就必须解构这个结构体，`typed` 始终在视野里，漏用是显性的。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct CaptchaTypeError {
    pub(crate) failure: TextInputFailure,
    /// 一次完整「按下 + 抬起」返回成功之后才计入的字符数。
    ///
    /// 按下成功而抬起失败的那个字符会被**少算一个**——方向是少报、不是多报，且调用方随后清场，
    /// 符合「按实测回报」。MUST NOT 为了「好看」改成先加后提交。
    pub(crate) typed: usize,
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
    type_text_humanized_inner(cdp, value, cancellation, deadline_unix_ms, None)
        .await
        .map_err(GuardedTextInputFailure::into_unguarded)
}

pub(crate) async fn type_text_humanized_guarded(
    cdp: &mut CdpSession,
    value: &str,
    cancellation: Option<&AtomicBool>,
    deadline_unix_ms: u64,
    target_guard_expression: &str,
) -> Result<usize, GuardedTextInputFailure> {
    type_text_humanized_inner(
        cdp,
        value,
        cancellation,
        deadline_unix_ms,
        Some(target_guard_expression),
    )
    .await
}

/// Inserts one already-bounded value after a single focus check.
///
/// Facebook TOTP codes are commonly pasted as one unit. This path deliberately uses one CDP
/// `Input.insertText` call: it never touches the OS clipboard and never assigns a DOM value or
/// synthesizes JavaScript input events. Other text entry keeps the existing humanized behavior.
pub(crate) async fn insert_text_guarded(
    cdp: &mut CdpSession,
    value: &str,
    cancellation: Option<&AtomicBool>,
    deadline_unix_ms: u64,
    target_guard_expression: &str,
) -> Result<(), GuardedTextInputFailure> {
    ensure_text_input_active(cancellation, deadline_unix_ms)?;
    // 通道失败（求值发不出去 / 连接断了）单列为 Engine，保持不变。
    let result = cdp
        .evaluate(target_guard_expression, true)
        .await
        .map_err(|_| TextInputFailure::Engine)?;
    if let Some(failure) = guarded_focus_failure(focus_guard_verdict(&result)) {
        return Err(failure);
    }
    ensure_text_input_active(cancellation, deadline_unix_ms)?;
    cdp.insert_text(value)
        .await
        .map_err(|_| TextInputFailure::Engine)?;
    Ok(())
}

/// 逐字输入前的焦点守卫读数，三态。
///
/// `Unreadable` 与 `Lost` 必须分开：守卫在页面里抛了异常、或回来的结构对不上（`/result/value/output`
/// 缺失、kind 不是文本目标、布尔字段不是布尔），说明**这一次没读到**焦点状态；
/// 只有守卫确实回了「目标不在 / 没聚焦」才是焦点真丢了。塌成一态就会把「不知道」上报成
/// 「知道是坏的」，真机上按图索骥找一个根本没发生的失焦。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum FocusGuardVerdict {
    Focused,
    Lost,
    Unreadable,
}

/// 带焦点守卫的文本写入的失败面。比 `TextInputFailure` 多一态，而且**只多在守卫路径上**。
///
/// 为什么不是往 `TextInputFailure` 里加一个变体：那一态只可能由焦点守卫的读数产生，
/// 而共享枚举被 7 处穷举匹配消费，其中 5 处根本不带守卫。加变体等于逼那 5 处各写一条
/// 「此路不可达」的分支——每一条都是一次把不存在的状态映射成某个原因码的机会，
/// 也就是把「结构上不会发生」变成「发生了我就随便报一个」。用类型把它圈在守卫路径里，
/// 不带守卫的调用方连看见它的机会都没有。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum GuardedTextInputFailure {
    Input(TextInputFailure),
    /// 焦点守卫**这一次没读到**焦点状态：守卫在页面里抛了异常、输出缺失、kind 不对、
    /// 或布尔字段不是布尔。
    ///
    /// 三件事必须分开，谁也不许冒充谁：
    ///  - `Input(TextInputFailure::Engine)` —— 通道本身失败（求值发不出去 / 连接断了）；
    ///  - `Input(TextInputFailure::TargetLost)` —— 守卫**读到了**坏消息：目标不在 / 没聚焦；
    ///  - `GuardUnreadable` —— 读不到。
    ///
    /// 压成前两者之一都是撒谎：压成 `TargetLost` 是把不知道说成知道（真机上按图索骥去找一次
    /// 根本没发生的失焦）；压成 `Engine` 是把「页面里那段守卫自己坏了」说成「引擎的通道坏了」，
    /// 排障方向正好指反。
    GuardUnreadable,
}

impl From<TextInputFailure> for GuardedTextInputFailure {
    fn from(failure: TextInputFailure) -> Self {
        Self::Input(failure)
    }
}

impl GuardedTextInputFailure {
    /// 折回不带守卫的失败面。
    ///
    /// 只给**不传守卫表达式**的那条路径用：那里 `focus_guard_verdict` 一次都不会被调用，
    /// 所以 `GuardUnreadable` 结构上产生不出来。万一将来有人给那条路径接上守卫却忘了改回执，
    /// 这里回落到 `Engine`（引擎侧失败）而**绝不**回落到 `TargetLost` ——
    /// 方向是「说不清」，不是「谎称目标丢了」。
    fn into_unguarded(self) -> TextInputFailure {
        match self {
            Self::Input(failure) => failure,
            Self::GuardUnreadable => TextInputFailure::Engine,
        }
    }
}

/// 焦点守卫读数 → 写入失败面的**唯一**翻译点。
///
/// 收成一处而不是在两个守卫入口各写一遍 `match`：这三态一旦在某一处被合并，
/// 合并的那一处不会报错、只会安静地少报一种结论，而两处各写一遍就有两次合错的机会。
/// `Focused` 回 `None`（继续写），其余两态各自单列。
pub(crate) fn guarded_focus_failure(verdict: FocusGuardVerdict) -> Option<GuardedTextInputFailure> {
    match verdict {
        FocusGuardVerdict::Focused => None,
        FocusGuardVerdict::Lost => {
            Some(GuardedTextInputFailure::Input(TextInputFailure::TargetLost))
        }
        FocusGuardVerdict::Unreadable => Some(GuardedTextInputFailure::GuardUnreadable),
    }
}

pub(crate) fn focus_guard_verdict(result: &serde_json::Value) -> FocusGuardVerdict {
    if result.get("exceptionDetails").is_some() {
        return FocusGuardVerdict::Unreadable;
    }
    let Some(output) = result.pointer("/result/value/output") else {
        return FocusGuardVerdict::Unreadable;
    };
    if output.get("kind").and_then(serde_json::Value::as_str) != Some("text_target") {
        return FocusGuardVerdict::Unreadable;
    }
    let (Some(ok), Some(focused)) = (
        output
            .pointer("/value/ok")
            .and_then(serde_json::Value::as_bool),
        output
            .pointer("/value/focused")
            .and_then(serde_json::Value::as_bool),
    ) else {
        return FocusGuardVerdict::Unreadable;
    };
    if ok && focused {
        FocusGuardVerdict::Focused
    } else {
        FocusGuardVerdict::Lost
    }
}

async fn type_text_humanized_inner(
    cdp: &mut CdpSession,
    value: &str,
    cancellation: Option<&AtomicBool>,
    deadline_unix_ms: u64,
    target_guard_expression: Option<&str>,
) -> Result<usize, GuardedTextInputFailure> {
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
            // 通道失败（求值发不出去 / 连接断了）单列为 Engine，保持不变。
            let result = cdp
                .evaluate(expression, true)
                .await
                .map_err(|_| TextInputFailure::Engine)?;
            // 「守卫求值本身失败 / 输出缺失」不是「焦点确实丢了」：前者是读不到，后者是读到了坏消息。
            // 也不是「通道坏了」：守卫这一次的求值**回来了**，只是回来的东西读不出焦点状态。
            // 三态各自单列、谁也不许冒充谁，翻译收在 guarded_focus_failure 一处。
            if let Some(failure) = guarded_focus_failure(focus_guard_verdict(&result)) {
                return Err(failure);
            }
        }
        cdp.insert_text(&character.to_string())
            .await
            .map_err(|_| TextInputFailure::Engine)?;
        typed += 1;
    }
    Ok(typed)
}

/// 文本写入的结构性不变量：**一次写入永远不携带回车符**。
///
/// 这不是注释级约定，而是类型级约定 —— 唯一的构造器带否定检查，构造失败即响亮失败。
/// **绝不**提供「发现带回车就过滤掉」的兜底：那会把「内容被悄悄改写」说成成功，
/// 正是本轮要根除的静默假成功。
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct NewlineFreeText(String);

impl NewlineFreeText {
    pub(crate) fn new(value: &str) -> Option<Self> {
        (!value.contains('\n') && !value.contains('\r')).then(|| Self(value.to_owned()))
    }

    pub(crate) fn as_str(&self) -> &str {
        &self.0
    }
}

/// 正文的两类输入单元。文本单元结构上不可能携带回车符；换行是独立单元，
/// 由调用方按编辑器形态选择它的写法（见 `ContentNewline`）。
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum ContentUnit {
    Text(NewlineFreeText),
    Newline,
}

/// 换行怎么写。
pub(crate) enum ContentNewline<'a> {
    /// 当成普通字符写（受控 `textarea` / `input` 形态，例如评论框）：
    /// 那里的 `\n` 就是一个字符，不是段落事务，走裸回车反而会把评论提交出去。
    LiteralCharacter,
    /// 裸回车按键 + 有界归尾确认（富文本正文）：让编辑器自己执行段落拆分，
    /// 并在每次回车后确认「已写前缀仍在 + 换行数达标 + 光标在末端」连续两轮命中。
    BareEnterKey {
        caret_state_expression: &'a str,
        stabilize_budget_ms: u64,
    },
}

/// 把一段文本拆成输入单元。`\r\n` / 裸 `\r` 先归一成 `\n`，文本片段一律来自
/// `split('\n')` —— 其产物结构上不可能含 `\n`，故 `NewlineFreeText::new` 恒成功；
/// 返回 `None` 只可能是编程错误，调用方 MUST 响亮失败，不得静默降级。
pub(crate) fn build_content_units(text: &str) -> Option<Vec<ContentUnit>> {
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    let mut units = Vec::new();
    for (index, line) in normalized.split('\n').enumerate() {
        if index > 0 {
            units.push(ContentUnit::Newline);
        }
        if line.is_empty() {
            continue;
        }
        units.push(ContentUnit::Text(NewlineFreeText::new(line)?));
    }
    Some(units)
}

/// 单元里的文本字符总数（换行不计 —— 它走的是另一条通道）。
pub(crate) fn content_text_char_count(units: &[ContentUnit]) -> usize {
    units
        .iter()
        .map(|unit| match unit {
            ContentUnit::Text(value) => value.as_str().chars().count(),
            ContentUnit::Newline => 0,
        })
        .sum()
}

/// 一次写入的形状：这次写几个字符、写之前停多久。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct TypingStep {
    pub(crate) chunk_size: usize,
    pub(crate) pause_center_ms: u64,
    /// 这一步的粒度已经买不起拟人形态（块大于 `TYPING_HUMANE_CHUNK_CHARS`）。
    /// 由调用方累计并响亮记一笔，绝不无声吞掉。
    pub(crate) degraded: bool,
}

impl TypingStep {
    fn delay_ms(&self, rhythm: &mut KeyboardRhythm, first: char) -> u64 {
        if self.pause_center_ms == 0 {
            return 0;
        }
        if self.chunk_size == 1 {
            // 逐字档走键盘节奏（与退役实现逐项一致）；只有预算收紧时封顶才真的咬住。
            rhythm
                .flight_delay_ms(first)
                .min(self.pause_center_ms * TYPING_PER_CHAR_PAUSE_CAP_FACTOR)
        } else {
            sample_pause_ms(self.pause_center_ms as f64)
        }
    }
}

/// 按**剩余字符数**与**剩余预算**现算下一次写入的形状。每次写入前都重算一次，
/// 所以一次 CDP 抖动只会让后续的块变大 / 停顿变短，绝不会变成「少写几个字」。
///
/// 推导：预算一半给停顿、一半给往返；往返那一半除以**实测**的单次往返成本得到还买得起
/// 几次写入，再与剩余字符数、往返上限取小；块大小由「剩余字符数 ÷ 买得起的次数」向上取整。
///
/// 这里的 `.max(1)` 是**终止性**保证，不是拟人下限：预算收紧时 `affordable_sends` 一路降到 0，
/// 只有兜住 1 才能让剩余尾巴在一次写入里落地、循环收敛。给它抬一个「至少分 N 块」的下限
/// 会破坏这条收敛性 —— 每一步重算都只吃掉剩余的 1/N，字符按几何级数递减而预算按线性递减，
/// 结果是写到 90% 撞死线、清场、诚实失败；把一次「像机器但内容完整」的成功换成一次失败，
/// 方向反了。所以这里不加下限，改为**把降级如实标出来**（`degraded`），由调用方响亮记账。
///
/// 另注：初始估值 60ms ⇒ 第一步只有在剩余预算不足 120ms 时才会降级，而那之前
/// `xhs_typing_deadline` 已经零派发拒绝了。故降级只可能发生在**尾巴**上，整篇正文
/// 一次性灌进去这一形态结构上到不了。
pub(crate) fn plan_typing_step(
    remaining_chars: usize,
    remaining_budget_ms: u64,
    observed_send_cost_ms: u64,
) -> TypingStep {
    if remaining_chars == 0 {
        return TypingStep {
            chunk_size: 1,
            pause_center_ms: 0,
            degraded: false,
        };
    }
    let send_cost = observed_send_cost_ms.max(1);
    let pause_budget_ms = remaining_budget_ms / TYPING_PAUSE_BUDGET_SHARE;
    let roundtrip_budget_ms = remaining_budget_ms - pause_budget_ms;
    let affordable_sends = (roundtrip_budget_ms / send_cost).max(1);
    let max_sends = affordable_sends
        .min(remaining_chars as u64)
        .min(TYPING_MAX_SENDS_CEILING as u64) as usize;
    let chunk_size = remaining_chars.div_ceil(max_sends);
    let chunk_count = remaining_chars.div_ceil(chunk_size);
    let pause_center_ms =
        (pause_budget_ms / chunk_count as u64).min(TYPING_PAUSE_CENTER_CEILING_MS);
    TypingStep {
        chunk_size,
        pause_center_ms,
        degraded: chunk_size > TYPING_HUMANE_CHUNK_CHARS,
    }
}

/// 一次分块输入跑完之后的**实测**账：写进去多少字符、有几步是降级的、最大的一次写入多少字符、
/// 实测单次往返成本收敛到多少。后三项只在降级发生时才有意义，专供响亮记账。
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) struct TypingOutcome {
    /// **实际写进页面**的字符数（换行按 1 计）。绝不回报请求值。
    pub(crate) written: usize,
    pub(crate) degraded_sends: usize,
    pub(crate) max_chunk_chars: usize,
    pub(crate) observed_send_cost_ms: u64,
}

/// 降级记账行。没降级就是 `None` —— 让「一切正常」与「降级了但没人看见」在类型上就分得开。
///
/// 这一行是真机上唯一能看出「拟人写入退化成整段赋值」的证据：`send_cost_ms` 指向放大器
/// （单次慢往返被单调 `max` 永久抬高），`max_chunk` 指向这次退化到了多机器。
pub(crate) fn typing_degradation_note(outcome: &TypingOutcome) -> Option<String> {
    (outcome.degraded_sends > 0).then(|| {
        format!(
            "degraded_sends={}:max_chunk={}:humane_chunk={}:send_cost_ms={}",
            outcome.degraded_sends,
            outcome.max_chunk_chars,
            TYPING_HUMANE_CHUNK_CHARS,
            outcome.observed_send_cost_ms,
        )
    })
}

/// 分块突发式输入（8.2 的新原语）。
///
/// 与逐字原语的关系：短文本自然落到 `chunk_size == 1`，逐字派发、走同一条键盘节奏；
/// 长正文才把块撑大。**取消缝仍在「这一块的停顿已结束、它的写入尚未发出」那一瞬**，
/// 已写入的部分留在编辑器里，由调用方负责清场。
///
/// 返回**实测**的写入账（写进去多少字符、降级了几步）。绝不回报请求值。
pub(crate) async fn type_content_burst_humanized(
    cdp: &mut CdpSession,
    units: &[ContentUnit],
    newline: &ContentNewline<'_>,
    cancellation: Option<&AtomicBool>,
    deadline_unix_ms: u64,
) -> Result<TypingOutcome, TextInputFailure> {
    let mut rhythm = KeyboardRhythm::new();
    let mut remaining_chars = content_text_char_count(units);
    let mut observed_send_cost_ms = TYPING_INITIAL_SEND_COST_MS;
    let mut written = 0_usize;
    let mut degraded_sends = 0_usize;
    let mut max_chunk_chars = 0_usize;
    let mut expected_prefix = String::new();
    let mut expected_newlines = 0_usize;
    for unit in units {
        match unit {
            ContentUnit::Newline => {
                let step = plan_typing_step(
                    remaining_chars.max(1),
                    remaining_budget_ms(deadline_unix_ms),
                    observed_send_cost_ms,
                );
                // 取消缝：停顿已结束、这一次换行尚未发出。
                wait_before_character(step.pause_center_ms, cancellation, deadline_unix_ms).await?;
                match newline {
                    ContentNewline::LiteralCharacter => {
                        cdp.insert_text("\n")
                            .await
                            .map_err(|_| TextInputFailure::Engine)?;
                    }
                    ContentNewline::BareEnterKey {
                        caret_state_expression,
                        stabilize_budget_ms,
                    } => {
                        // 裸回车：不带 text —— 让编辑器自己执行段落拆分。
                        // 带 '\r' 的 keypress 形态是搜索框专用，用在正文上会触发提交。
                        cdp.dispatch_key("rawKeyDown", "Enter", "Enter", 13)
                            .await
                            .map_err(|_| TextInputFailure::Engine)?;
                        cdp.dispatch_key("keyUp", "Enter", "Enter", 13)
                            .await
                            .map_err(|_| TextInputFailure::Engine)?;
                        expected_prefix.push('\n');
                        expected_newlines += 1;
                        written += 1;
                        stabilize_after_newline(
                            cdp,
                            caret_state_expression,
                            &expected_prefix,
                            expected_newlines,
                            *stabilize_budget_ms,
                            cancellation,
                            deadline_unix_ms,
                        )
                        .await?;
                        continue;
                    }
                }
                expected_prefix.push('\n');
                written += 1;
            }
            ContentUnit::Text(value) => {
                let chars: Vec<char> = value.as_str().chars().collect();
                let mut index = 0;
                while index < chars.len() {
                    let step = plan_typing_step(
                        remaining_chars,
                        remaining_budget_ms(deadline_unix_ms),
                        observed_send_cost_ms,
                    );
                    let take = step.chunk_size.min(chars.len() - index);
                    let chunk: String = chars[index..index + take].iter().collect();
                    let delay_ms = step.delay_ms(&mut rhythm, chars[index]);
                    // 取消缝：这一块的停顿已结束、它的写入尚未发出。
                    wait_before_character(delay_ms, cancellation, deadline_unix_ms).await?;
                    // 记账在**派发之前**：这一步的粒度已经定了，之后不论成功、超时还是被接管，
                    // 「这一次写入有多机器」都已经是既成事实，不该被后续的失败路径抹掉。
                    if step.degraded {
                        degraded_sends += 1;
                    }
                    max_chunk_chars = max_chunk_chars.max(take);
                    let started = Instant::now();
                    cdp.insert_text(&chunk)
                        .await
                        .map_err(|_| TextInputFailure::Engine)?;
                    // 实测单次往返成本，单调抬升（保守方向：只会让后续块更大、往返更少，
                    // 绝不会因为低估而把内容写不完）。
                    let elapsed_ms: u64 =
                        started.elapsed().as_millis().try_into().unwrap_or(u64::MAX);
                    observed_send_cost_ms = observed_send_cost_ms.max(elapsed_ms);
                    expected_prefix.push_str(&chunk);
                    written += take;
                    remaining_chars = remaining_chars.saturating_sub(take);
                    index += take;
                }
            }
        }
    }
    Ok(TypingOutcome {
        written,
        degraded_sends,
        max_chunk_chars,
        observed_send_cost_ms,
    })
}

fn remaining_budget_ms(deadline_unix_ms: u64) -> u64 {
    deadline_unix_ms.saturating_sub(unix_time_ms())
}

/// 换行之后的有界归尾确认。
///
/// 判据四条同时成立才算一次命中：探针读到了目标 && 已写前缀仍在 && 换行数达标 && 光标在末端；
/// 任一条不满足即把连续命中计数**清零**。连续两轮命中才收敛 —— 富文本编辑器的选区事务
/// 可能比一次读慢一拍，单轮命中会把「还没落定」当成落定。
///
/// 「读不到」与「没稳住」是两态：全程一次都没读到判定 ⇒ `Engine`（探针问题），
/// 读到过但始终不满足 ⇒ `NewlineUnstable`。压成一态就会在真机上按图索骥找一个不存在的病因。
///
/// 预算按**实际流逝**限界，不按「预算 ÷ 间隔」推算轮数：每一轮的真实开销是
/// 「一次 `Runtime.evaluate` 往返 + 一个间隔」，真机 RTT 几十毫秒 ⇒ 推算出来的轮数
/// 跑起来能吃掉分配值的两倍以上。而 `xhs_fill_budget` 正是按这个分配值把可用窗口的
/// **一半**划给归尾确认的 —— 推算法让那个「一半」的前提不成立，12 段正文能把 26.5s 里的
/// 21.5s 吃掉、只剩 5s 给 5000 字正文，然后撞死线、清场、诚实失败。
/// 迭代次数上限仍在（`NEWLINE_STABILIZE_MAX_ROUNDS`），所以不是拿墙钟裸跑死循环。
async fn stabilize_after_newline(
    cdp: &mut CdpSession,
    expression: &str,
    expected_prefix: &str,
    expected_newlines: usize,
    budget_ms: u64,
    cancellation: Option<&AtomicBool>,
    deadline_unix_ms: u64,
) -> Result<(), TextInputFailure> {
    if budget_ms < NEWLINE_STABILIZE_INTERVAL_MS * u64::from(NEWLINE_STABILIZE_REQUIRED_HITS) {
        // 预算连两轮都排不下：这一段结构上不可能确认，不开写才是诚实的。
        return Err(TextInputFailure::NewlineUnstable);
    }
    let started = Instant::now();
    let expected = normalize_field_text(expected_prefix);
    let expected_hanzi = hanzi_only(&expected);
    let mut hits = 0_u32;
    let mut readable_once = false;
    for round in 0..NEWLINE_STABILIZE_MAX_ROUNDS {
        if round > 0 {
            // 下一轮（间隔 + 一次往返）排不进剩余预算就收工。判据是**已经花掉多少**，
            // 不是「按名义间隔应该还剩几轮」。
            let elapsed_ms = started.elapsed().as_millis().try_into().unwrap_or(u64::MAX);
            let interval_ms = if elapsed_ms + NEWLINE_STABILIZE_INTERVAL_MS >= budget_ms {
                0
            } else {
                NEWLINE_STABILIZE_INTERVAL_MS
            };
            // 即使这一轮已经排不下，也先走一次（零等待的）接管 / 死线检查：
            // 接管必须**原样穿出**，不许被「没稳住」这条本地结局盖掉。
            wait_before_character(interval_ms, cancellation, deadline_unix_ms).await?;
            if interval_ms == 0 {
                break;
            }
        }
        let raw = cdp
            .evaluate(expression, true)
            .await
            .map_err(|_| TextInputFailure::Engine)?;
        match caret_state_from_cdp(&raw) {
            Some(state) => {
                readable_once = true;
                // 前缀两级比较：编辑器会做无害的空白规整 / 全半角改写，严格等值会误杀；
                // 含汉字时只比汉字（退役实测口径），不含汉字才比规整后的全文。
                let prefix_matches = expected.is_empty()
                    || if expected_hanzi.is_empty() {
                        state.text.contains(&expected)
                    } else {
                        hanzi_only(&state.text).contains(&expected_hanzi)
                    };
                if state.found
                    && prefix_matches
                    && state.newlines >= expected_newlines
                    && state.at_end
                {
                    hits += 1;
                    if hits >= NEWLINE_STABILIZE_REQUIRED_HITS {
                        return Ok(());
                    }
                } else {
                    hits = 0;
                }
            }
            None => hits = 0,
        }
    }
    Err(if readable_once {
        TextInputFailure::NewlineUnstable
    } else {
        TextInputFailure::Engine
    })
}

pub(crate) struct CaretState {
    pub(crate) found: bool,
    pub(crate) text: String,
    pub(crate) newlines: usize,
    pub(crate) at_end: bool,
}

/// 解析归尾探针的读数。异常 / 结构缺失一律回 `None`＝**这一轮没读到**，
/// 绝不冒充「读到了一个坏消息」。
pub(crate) fn caret_state_from_cdp(raw: &serde_json::Value) -> Option<CaretState> {
    if raw.get("exceptionDetails").is_some() {
        return None;
    }
    let value = raw.pointer("/result/value")?;
    Some(CaretState {
        found: value.get("found").and_then(serde_json::Value::as_bool)?,
        text: value
            .get("text")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        newlines: value
            .get("newlines")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or_default() as usize,
        at_end: value
            .get("atEnd")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false),
    })
}

/// 与页面侧读回同口径的归一：折叠空白、去首尾。
pub(crate) fn normalize_field_text(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut pending_space = false;
    for character in value.chars() {
        if character.is_whitespace() {
            pending_space = true;
            continue;
        }
        if pending_space && !out.is_empty() {
            out.push(' ');
        }
        pending_space = false;
        out.push(character);
    }
    out
}

/// 只保留汉字。用于前缀比较的退化档：编辑器对标点 / 全半角的无害改写不该判成内容丢失。
pub(crate) fn hanzi_only(value: &str) -> String {
    value.chars().filter(|value| is_han(*value)).collect()
}

fn is_han(character: char) -> bool {
    matches!(
        character as u32,
        0x3400..=0x4DBF
            | 0x4E00..=0x9FFF
            | 0xF900..=0xFAFF
            | 0x2_0000..=0x2_A6DF
            | 0x2_A700..=0x2_EBEF
            | 0x2_F800..=0x2_FA1F
            | 0x3_0000..=0x3_134F
    )
}

/// 字符二元组 Dice 系数。编辑器的空白规整 / 全半角替换是无害改写，严格等值会误杀；
/// 但「只写进去一半」会显著拉低系数，阈值仍拦得住。
pub(crate) fn bigram_similarity(left: &str, right: &str) -> f64 {
    if left == right {
        return 1.0;
    }
    if left.is_empty() || right.is_empty() {
        return 0.0;
    }
    let bigrams = |value: &str| {
        let characters: Vec<char> = value.chars().collect();
        let mut map: std::collections::HashMap<(char, char), usize> =
            std::collections::HashMap::new();
        for window in characters.windows(2) {
            *map.entry((window[0], window[1])).or_default() += 1;
        }
        map
    };
    let first = bigrams(left);
    let second = bigrams(right);
    let mut shared = 0_usize;
    let mut total = 0_usize;
    for (gram, count) in &first {
        total += count;
        shared += (*count).min(second.get(gram).copied().unwrap_or_default());
    }
    for count in second.values() {
        total += count;
    }
    if total == 0 {
        0.0
    } else {
        2.0 * shared as f64 / total as f64
    }
}

/// 逐字符派发验证码答案，**成功与失败都回带真实的已派发字符数**。
///
/// 中途被抢占 / 超预算 / 通道失败时，调用方要如实回报「打进去几个」——而这个数只有在这里才知道：
/// 一旦以裸 `TextInputFailure` 抛出，内部计数就丢了，调用方唯一还拿得到的只有**请求文本长度**，
/// 于是必然回退成「请求了几个就说打了几个」。那正是本 change 要消灭的静默假成功。
pub(crate) async fn type_captcha_with_key_events(
    cdp: &mut CdpSession,
    value: &str,
    cancellation: Option<&AtomicBool>,
    deadline_unix_ms: u64,
) -> Result<usize, CaptchaTypeError> {
    let mut rhythm = KeyboardRhythm::new();
    let mut typed = 0;
    let mut last_rtt_ms = 0_u64;
    for character in value.chars() {
        let wait_ms = rhythm
            .flight_delay_ms(character)
            .saturating_sub(last_rtt_ms);
        wait_before_character(wait_ms, cancellation, deadline_unix_ms)
            .await
            .map_err(|failure| CaptchaTypeError { failure, typed })?;
        let spec = captcha_key_spec(character).ok_or(CaptchaTypeError {
            failure: TextInputFailure::Engine,
            typed,
        })?;
        let dwell_ms = rhythm.dwell_delay_ms();
        let started = Instant::now();
        commit_captcha_key_stroke(cdp, &spec, dwell_ms)
            .await
            .map_err(|failure| CaptchaTypeError { failure, typed })?;
        // 计数只在**整对按键提交成功之后**自增（与退役实现的逐字进度回调同一时机）。
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
    ensure_text_input_active(cancellation, deadline_unix_ms)
}

fn ensure_text_input_active(
    cancellation: Option<&AtomicBool>,
    deadline_unix_ms: u64,
) -> Result<(), TextInputFailure> {
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

pub(crate) fn unix_time_ms() -> u64 {
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

    /// 焦点守卫的三态：读到「在且聚焦」/ 读到「不在或没聚焦」/ **根本没读到**。
    /// 第三态过去被塌进「目标丢了」，等于把不知道说成知道是坏的。
    #[test]
    fn focus_guard_separates_unreadable_from_a_real_focus_loss() {
        let focused = serde_json::json!({
            "result": {"value": {"output": {"kind": "text_target", "value": {"ok": true, "focused": true}}}}
        });
        assert_eq!(focus_guard_verdict(&focused), FocusGuardVerdict::Focused);

        // 读到了坏消息：目标不在 / 没聚焦，都是真的焦点丢了。
        for value in [
            serde_json::json!({"ok": false, "focused": true}),
            serde_json::json!({"ok": true, "focused": false}),
            serde_json::json!({"ok": false, "focused": false}),
        ] {
            let lost = serde_json::json!({
                "result": {"value": {"output": {"kind": "text_target", "value": value}}}
            });
            assert_eq!(focus_guard_verdict(&lost), FocusGuardVerdict::Lost);
        }

        // 没读到：守卫在页面里抛了、输出缺失、kind 不对、字段不是布尔——四种都是「不知道」。
        for unreadable in [
            serde_json::json!({"exceptionDetails": {"lineNumber": 3}, "result": {"value": {}}}),
            serde_json::json!({"result": {"value": {}}}),
            serde_json::json!({"result": {"value": {"output": {"kind": "point_target"}}}}),
            serde_json::json!({
                "result": {"value": {"output": {"kind": "text_target", "value": {"ok": "yes", "focused": true}}}}
            }),
            serde_json::json!({
                "result": {"value": {"output": {"kind": "text_target", "value": {"focused": true}}}}
            }),
        ] {
            assert_eq!(
                focus_guard_verdict(&unreadable),
                FocusGuardVerdict::Unreadable,
                "{unreadable}"
            );
        }
    }

    /// 三态读数必须翻成**三个不同**的结论。
    ///
    /// 此前 `Unreadable` 与通道失败一起压成 `Engine`：外面看到的原因码只有两种，
    /// 「守卫读不到」和「求值根本发不出去」长得一模一样，排障方向被指反。
    #[test]
    fn focus_guard_verdicts_translate_into_three_distinct_conclusions() {
        assert_eq!(guarded_focus_failure(FocusGuardVerdict::Focused), None);
        assert_eq!(
            guarded_focus_failure(FocusGuardVerdict::Lost),
            Some(GuardedTextInputFailure::Input(TextInputFailure::TargetLost)),
        );
        let unreadable =
            guarded_focus_failure(FocusGuardVerdict::Unreadable).expect("unreadable is a failure");
        assert_eq!(unreadable, GuardedTextInputFailure::GuardUnreadable);
        // 「读不到」既不许冒充「读到了目标丢失」，也不许冒充「通道坏了」。
        assert_ne!(
            unreadable,
            GuardedTextInputFailure::Input(TextInputFailure::TargetLost)
        );
        assert_ne!(
            unreadable,
            GuardedTextInputFailure::Input(TextInputFailure::Engine)
        );
    }

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

    /// 反证「滚轮帧背靠背派发」：帧间延迟必须有**正的下界**，且一次手势内必须散开。
    ///
    /// 上面那条形状断言只查「落在上下界常量之间」——把上下界一起改成 0 它照过（`0..=0` 含 0），
    /// 而滚轮就退化成零延迟的一次性投递：整段位移在同一毫秒内发完，帧数还在、时序特征全没。
    /// 这里的判据取自**人手**、不引用被测常量：滚一次滚轮的两帧之间至少隔着 8ms
    /// （远低于实现的量级，只把 0 挡在外面），且同一次手势里的帧间隔不可能全等
    /// （极差 ≥ 10ms，实测每个种子都在 23ms 以上）。种子固定，故本条零随机性。
    #[test]
    fn wheel_frame_delays_keep_a_floor_and_are_not_constant() {
        const HUMAN_FLOOR_MS: u64 = 8;
        const MIN_SPREAD_MS: u64 = 10;
        for seed in 1..=64 {
            let mut rhythm = WheelRhythm::from_seed(seed);
            let gesture = generate_wheel_gesture(650.0, &mut rhythm);
            let delays: Vec<u64> = gesture.frames.iter().map(|frame| frame.delay_ms).collect();
            let floor = delays.iter().copied().min().expect("wheel frame");
            let ceiling = delays.iter().copied().max().expect("wheel frame");
            assert!(
                floor >= HUMAN_FLOOR_MS,
                "滚轮帧间延迟失去了下界（seed={seed} 最小 {floor}ms）：零延迟等于一次性投递"
            );
            assert!(
                ceiling - floor >= MIN_SPREAD_MS,
                "滚轮帧间延迟塌成了等间隔（seed={seed} 极差 {}ms）：dt 方差为 0 本身是机器特征",
                ceiling - floor
            );
        }
    }

    /// 反证「抖动塌成恒定间隔」：围绕中心值的停顿采样必须真的散开。
    ///
    /// 分散度归零时采样恒等于中心值——每两个动作之间停一样久，这正是拟人化本来要取代的固定间隔，
    /// 而所有「≤ 上界」类断言对它一声不吭。判据是分布性的、且不引用被测常量：256 次采样必须
    /// 出现多种取值、极差至少到中心值的一成，同时保住一个正的下界。
    /// 实测最坏一轮为「171 种取值 / 极差 451ms / 下界 220ms」，门槛离它们各有一个数量级。
    #[test]
    fn sampled_pauses_spread_around_their_center_instead_of_repeating_it() {
        const CENTER_MS: f64 = 400.0;
        const SAMPLES: usize = 256;
        const MIN_DISTINCT: usize = 16;
        const MIN_SPREAD_MS: u64 = 40;
        const HUMAN_FLOOR_MS: u64 = 100;
        let samples: Vec<u64> = (0..SAMPLES).map(|_| sample_pause_ms(CENTER_MS)).collect();
        let floor = samples.iter().copied().min().expect("pause sample");
        let ceiling = samples.iter().copied().max().expect("pause sample");
        let distinct: std::collections::HashSet<u64> = samples.iter().copied().collect();
        assert!(
            distinct.len() >= MIN_DISTINCT,
            "停顿采样只剩 {} 种取值：抖动没了，动作间隔就是恒定的机器节拍",
            distinct.len()
        );
        assert!(
            ceiling - floor >= MIN_SPREAD_MS,
            "停顿采样的极差只有 {}ms：分散度被压没了",
            ceiling - floor
        );
        assert!(
            floor >= HUMAN_FLOOR_MS,
            "停顿采样失去了下界（最小 {floor}ms）：停顿归零等于动作背靠背"
        );
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

    /// 「文本写入一律不带回车符」由**类型系统**承载：构造器带否定检查，且没有
    /// 「发现带回车就过滤掉」的兜底 —— 那种兜底会把内容被改写说成成功。
    #[test]
    fn newline_free_text_rejects_carriage_and_line_feed() {
        assert!(NewlineFreeText::new("a\nb").is_none());
        assert!(NewlineFreeText::new("a\rb").is_none());
        assert!(NewlineFreeText::new("a\r\nb").is_none());
        let clean = NewlineFreeText::new("正文 abc 😀").expect("clean text");
        assert_eq!(clean.as_str(), "正文 abc 😀");
    }

    /// 拆单元既不许把回车带进文本单元，也不许丢掉任何一个字符：
    /// 用 `'\n'` 把单元重新接起来必须逐字符等于归一化后的原文。
    #[test]
    fn content_units_never_carry_a_newline_and_lose_no_character() {
        for sample in [
            "第一段\r\n第二段",
            "单个回车\r第二段",
            "连续空行\n\n\n收尾",
            "emoji 😀\n第二段 🎉",
            "\n开头就是换行",
            "结尾是换行\n",
            "没有换行",
            "",
        ] {
            let units = build_content_units(sample).expect("units");
            for unit in &units {
                if let ContentUnit::Text(value) = unit {
                    assert!(
                        !value.as_str().contains('\n') && !value.as_str().contains('\r'),
                        "text unit carried a newline for {sample:?}"
                    );
                }
            }
            let rejoined: String = units
                .iter()
                .map(|unit| match unit {
                    ContentUnit::Text(value) => value.as_str().to_owned(),
                    ContentUnit::Newline => "\n".to_owned(),
                })
                .collect();
            let normalized = sample.replace("\r\n", "\n").replace('\r', "\n");
            assert_eq!(rejoined, normalized, "content lost for {sample:?}");
            assert_eq!(
                content_text_char_count(&units),
                normalized.chars().filter(|value| *value != '\n').count()
            );
        }
    }

    /// 封顶只缩**往返与停顿**，绝不缩内容：任意（字数, 预算）组合下，模拟整条写入循环，
    /// 写入次数受上限约束、且写进去的字符数恒等于原字数。
    #[test]
    fn the_send_cap_shrinks_round_trips_never_content() {
        for (chars, budget_ms, send_cost_ms) in [
            (5_usize, 20_000_u64, 60_u64),
            (200, 20_000, 60),
            (1_000, 12_000, 60),
            (5_000, 12_000, 60),
            (5_000, 3_000, 200),
            (32_000, 1_000, 400),
        ] {
            let mut remaining = chars;
            let mut spent_ms = 0_u64;
            let mut sends = 0_usize;
            let mut written = 0_usize;
            while remaining > 0 {
                let step =
                    plan_typing_step(remaining, budget_ms.saturating_sub(spent_ms), send_cost_ms);
                assert!(step.chunk_size >= 1, "块大小恒 ≥ 1，否则循环不前进");
                let take = step.chunk_size.min(remaining);
                spent_ms += step.pause_center_ms + send_cost_ms;
                sends += 1;
                written += take;
                remaining -= take;
            }
            assert_eq!(
                written, chars,
                "封顶绝不许丢字符（{chars} 字 / {budget_ms}ms）"
            );
            assert!(
                sends <= TYPING_MAX_SENDS_CEILING,
                "写入次数 {sends} 越过上限（{chars} 字 / {budget_ms}ms）"
            );
        }
    }

    /// 每一步的停顿计划都只敢要走「剩下的一半」：块数 × 中心值 ≤ 剩余预算的一半，
    /// 且中心值不越过人感上限。
    #[test]
    fn the_pause_plan_never_asks_for_more_than_half_of_what_is_left() {
        for (chars, budget_ms) in [
            (1_usize, 30_000_u64),
            (24, 20_000),
            (1_000, 12_000),
            (5_000, 6_000),
            (5_000, 100),
        ] {
            let step = plan_typing_step(chars, budget_ms, 60);
            let chunk_count = chars.div_ceil(step.chunk_size) as u64;
            assert!(
                step.pause_center_ms * chunk_count <= budget_ms / 2,
                "停顿计划越过了剩余预算的一半（{chars} 字 / {budget_ms}ms）"
            );
            assert!(step.pause_center_ms <= TYPING_PAUSE_CENTER_CEILING_MS);
        }
    }

    /// 预算买不起拟人粒度时的降级**必须被标出来**。
    ///
    /// 降级本身不被禁止：这里的 `.max(1)` 是终止性保证，抬成「至少分 N 块」会让每一步只吃掉
    /// 剩余的 1/N，字符按几何级数递减而预算按线性递减，结果是写到九成撞死线 —— 把一次
    /// 「像机器但内容完整」的成功换成一次失败。所以这一条钉的是：降级**不许无声发生**。
    #[test]
    fn a_tail_that_can_no_longer_afford_humane_granularity_is_marked_and_accounted_for() {
        // 一次慢往返把实测成本抬到 3s，剩余预算只有 1s ⇒ 往返那一半连一次都买不起。
        let degraded = plan_typing_step(5_000, 1_000, 3_000);
        assert_eq!(
            degraded.chunk_size, 5_000,
            "终止性：买不起时尾巴必须能在一次写入里落地"
        );
        assert!(
            degraded.degraded,
            "5000 字一次性灌进去是机器特征（等价于退役实现的整段赋值），必须被标成降级"
        );

        let note = typing_degradation_note(&TypingOutcome {
            written: 5_000,
            degraded_sends: 1,
            max_chunk_chars: 5_000,
            observed_send_cost_ms: 3_000,
        })
        .expect("降级必须留下记账行，否则拟人保证是悄悄消失的");
        assert!(
            note.contains("max_chunk=5000"),
            "记账行要指出退化到了多机器：{note}"
        );
        assert!(
            note.contains("send_cost_ms=3000"),
            "记账行要指向放大器（单调 max 的实测往返成本）：{note}"
        );

        // 对照：预算宽裕时既不降级，也不留噪声行 —— 否则这条断言什么也没证明。
        let healthy = plan_typing_step(5_000, 30_000, 60);
        assert!(healthy.chunk_size <= TYPING_HUMANE_CHUNK_CHARS);
        assert!(!healthy.degraded);
        assert_eq!(
            typing_degradation_note(&TypingOutcome {
                written: 5_000,
                ..TypingOutcome::default()
            }),
            None
        );
    }

    /// 预算收紧只会让块变大、停顿变短 —— 方向必须是这一个，反了就是用拟人化制造超时。
    #[test]
    fn a_tighter_budget_only_grows_the_chunk_and_shortens_the_pause() {
        let roomy = plan_typing_step(2_000, 20_000, 60);
        let tight = plan_typing_step(2_000, 2_000, 60);
        assert!(tight.chunk_size >= roomy.chunk_size);
        assert!(tight.pause_center_ms <= roomy.pause_center_ms);
    }

    /// 打字节奏的取样文本：汉字 / 拉丁 / 空白 / 标点各占一部分，
    /// 让「标点与空白后停得更久」这一支也进入样本。
    const TYPING_RHYTHM_SAMPLE_TEXT: &str = "今天天气不错，出门走走。abc def! ok?";

    /// 反证「零延迟爆发式打字」：逐字飞行间隔必须有**正的下界**，且必须散开。
    ///
    /// 这一族缺口的形状是：所有触及停顿量级的断言都是上界（`停顿 × 次数 ≤ 预算的一半`）或
    /// 自指（`中心值 ≤ 上限常量`），把间隔恒定成 0 时它们全部照过、回执还一路诚实地报「写完了」。
    /// 判据取自**人**、不取自实现常量：人的两次击键之间至少隔着几十毫秒（这里取 25ms 这个
    /// 所有人都远远超过的下界），且 1024 次击键不可能落在同一个间隔上（实测最坏 254 种取值）。
    #[test]
    fn typing_flight_rhythm_keeps_a_floor_and_a_spread() {
        const SAMPLES: usize = 1_024;
        const HUMAN_FLOOR_MS: u64 = 25;
        const MIN_DISTINCT: usize = 32;
        let text: Vec<char> = TYPING_RHYTHM_SAMPLE_TEXT.chars().collect();
        let mut rhythm = KeyboardRhythm::new();
        let delays: Vec<u64> = (0..SAMPLES)
            .map(|index| rhythm.flight_delay_ms(text[index % text.len()]))
            .collect();
        let floor = delays.iter().copied().min().expect("flight sample");
        assert!(
            floor >= HUMAN_FLOOR_MS,
            "逐字间隔失去了下界（最小 {floor}ms）：字间零延迟就是机器爆发式写入"
        );
        let distinct: std::collections::HashSet<u64> = delays.iter().copied().collect();
        assert!(
            distinct.len() >= MIN_DISTINCT,
            "逐字间隔塌成了 {} 种取值：等间隔本身是机器特征",
            distinct.len()
        );
    }

    /// 反证「停顿被规划成 0」：预算宽裕时，块间停顿的中心值必须留住一个人类量级的下界。
    ///
    /// 与「不许超过剩余预算的一半」是**方向相反**的一条：那条是上界，`0 ≤ 任何预算的一半`
    /// 恒成立，所以把停顿规划成 0 它一声不吭。下界只在**预算宽裕**的组合上断言 ——
    /// 预算真的紧张时压缩停顿是设计（拿拟人化换「内容写得完」），不是退化。
    #[test]
    fn the_pause_plan_keeps_a_human_floor_when_the_budget_is_roomy() {
        const HUMAN_FLOOR_MS: u64 = 60;
        for (chars, budget_ms) in [
            (1_usize, 30_000_u64),
            (24, 20_000),
            (200, 20_000),
            (2_000, 60_000),
        ] {
            let step = plan_typing_step(chars, budget_ms, 60);
            assert!(
                step.pause_center_ms >= HUMAN_FLOOR_MS,
                "{chars} 字 / {budget_ms}ms 预算宽裕，停顿中心值却只有 {}ms：拟人化被悄悄关掉了",
                step.pause_center_ms
            );
        }
    }

    /// 反证「封顶把节奏压扁」：预算宽裕的逐字档里，停顿封顶不得咬住键盘节奏的长尾。
    ///
    /// 真人打字带偶发的长停顿（想词、看屏、切输入法）；把每次停顿都压到中心值附近，
    /// 时序特征就退回匀速机器 —— 而这一步既不报错也不降级，回执照报「已写入、已确认」。
    /// 判据是分布性的、且不引用被测常量：1024 次逐字停顿里必须有一批越过 260ms
    /// （实测常态约 100 次、最坏一轮 66 次，取 16 次做门槛，远离随机涨落）。
    #[test]
    fn per_char_pauses_keep_the_long_tail_of_a_real_typist() {
        const SAMPLES: usize = 1_024;
        const HUMAN_FLOOR_MS: u64 = 25;
        const LONG_PAUSE_MS: u64 = 260;
        const MIN_LONG_PAUSES: usize = 16;
        let step = plan_typing_step(24, 20_000, 60);
        assert_eq!(
            step.chunk_size, 1,
            "本条守卫针对逐字档，先钉住它确实是逐字档"
        );
        let text: Vec<char> = TYPING_RHYTHM_SAMPLE_TEXT.chars().collect();
        let mut rhythm = KeyboardRhythm::new();
        let delays: Vec<u64> = (0..SAMPLES)
            .map(|index| step.delay_ms(&mut rhythm, text[index % text.len()]))
            .collect();
        let floor = delays.iter().copied().min().expect("pause sample");
        assert!(
            floor >= HUMAN_FLOOR_MS,
            "逐字停顿失去了下界（最小 {floor}ms）：字间零延迟就是机器爆发式写入"
        );
        let long_pauses = delays
            .iter()
            .filter(|value| **value > LONG_PAUSE_MS)
            .count();
        assert!(
            long_pauses >= MIN_LONG_PAUSES,
            "{SAMPLES} 次逐字停顿里只有 {long_pauses} 次越过 {LONG_PAUSE_MS}ms：\
             封顶把人的长停顿削平了，节奏退回匀速机器"
        );
    }

    /// 归尾探针的读数：异常 / 结构缺失 = **这一轮没读到**，绝不冒充「读到了坏消息」。
    #[test]
    fn caret_state_separates_unreadable_from_a_real_reading() {
        assert!(
            caret_state_from_cdp(&serde_json::json!({"exceptionDetails": {"lineNumber": 1}}))
                .is_none()
        );
        assert!(caret_state_from_cdp(&serde_json::json!({"result": {}})).is_none());
        assert!(
            caret_state_from_cdp(&serde_json::json!({"result": {"value": {"text": "x"}}}))
                .is_none()
        );
        let state = caret_state_from_cdp(&serde_json::json!({
            "result": {"value": {"found": true, "text": "第一段 第二段", "newlines": 1, "atEnd": true}}
        }))
        .expect("readable");
        assert!(state.found && state.at_end);
        assert_eq!(state.newlines, 1);
    }

    /// 前缀比较的两级口径：编辑器的空白规整 / 全半角改写是无害的，严格等值会误杀。
    #[test]
    fn prefix_comparison_survives_harmless_editor_rewrites() {
        assert_eq!(
            normalize_field_text("  第一段\n\n第二段  "),
            "第一段 第二段"
        );
        assert_eq!(hanzi_only("第一段，abc123 第二段！"), "第一段第二段");
        assert!(bigram_similarity("第一段第二段", "第一段第二段") > 0.99);
        assert!(bigram_similarity("第一段第二段", "第一段") < XHS_TEST_SIMILARITY_FLOOR);
    }

    const XHS_TEST_SIMILARITY_FLOOR: f64 = 0.9;

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
