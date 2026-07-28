//! 定位三道闸（决定「自愈」不变成「自残」）。
//!
//! 1. **后置校验**：写动作之后必须**重新读回**业务结果，校验不过一律判失败，绝不静默成功。
//!    重新读回是结构性强制——不是在同一份执行前的活引用上复查（页面整段重渲染后那份引用
//!    早已脱离文档树，复查恒真或恒假）。
//! 2. **重试上限 + 升级**：失败按原因分流后有界重试；上限耗尽才给「升级」这个结论，且分成
//!    「一次都没写下去」（无目标）与「写下去了但业务结果始终没发生」（疑似系统性改版）两种
//!    终局。可重放的写才允许再来一轮；**不可重放的写一经派发即停手报不确定，绝不重放**。
//! 3. **反污染回写**：非确定性来源解析出的新锚点先进暂存区，连续确认成功达阈值才晋升主缓存；
//!    任一次后置校验失败即丢弃暂存项，永不晋升。要义是「一次错误解析不得被复制成系统性故障」。
//!
//! **接线状态（务必读）**：本模块是三道闸的**落点**，本轮只造原语、**尚未接进任何平台命令**。
//! 其中闸③在当前引擎里必然空转：引擎的定位规则是编译进二进制的固定选择器，没有任何
//! **非确定性**锚点来源（退役实现里那条模型选元素路径在迁移中整条消失），因此
//! [`AnchorCache::stage_non_deterministic`] 在生产上不会被调用、暂存区恒为空。这是已知且
//! 待裁定的前提（change 的 design「待裁定 P1」），**不得**据此把「定位自愈已恢复」当成事实。

use crate::error::EngineError;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// 一轮定位的终局。
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LocatingOutcome {
    /// 后置校验读到了业务结果确实发生。
    Confirmed { attempts: u32 },
    /// 一次都没把写派发出去（目标始终没解析出来）。绝不伪造成成功。
    NoTarget { attempts: u32 },
    /// 写已经派发，但结果无法判定。永不回落成已确认。
    Ambiguous { attempts: u32, reason: &'static str },
    /// 重试上限耗尽后的升级结论。
    Escalated { attempts: u32, kind: EscalationKind },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EscalationKind {
    /// 连续校验失败到上限：疑似平台系统性改版，停手。
    SystemicRevision,
    /// 解析来源本身不可用：立刻升级、不再重试（与「改版」不是一回事，不得混淆）。
    ResolverUnavailable,
}

/// 锚点来源。只有非确定性来源才需要走暂存 → 晋升这条防污染路径；
/// 编译进二进制的固定选择器是确定性的，它的成功不构成「学到了新东西」。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AnchorSource {
    Deterministic,
    NonDeterministic,
}

/// 一次成功解析出的目标。`key` 是该动作的锚点键，`anchor` 是可复用的定位指纹。
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResolvedTarget {
    pub key: String,
    pub anchor: String,
    pub source: AnchorSource,
}

/// 解析结果三态。「没找到」与「来源不可用」必须分开——后者立刻升级、不再重试。
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Resolution {
    Found(ResolvedTarget),
    Missing,
    SourceUnavailable,
}

/// 一次写动作的派发事实。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Actuation {
    /// 写是否真的派发出去了。false = 未开始，可安全重试。
    pub dispatched: bool,
    /// 这次写是否可重放。点赞这类幂等翻转可重放；发帖 / 评论提交这类不可重放，
    /// 一经派发就只能停手报不确定。
    pub replayable: bool,
}

/// 后置校验的判定。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Verdict {
    /// 读到了业务结果确实发生。
    Confirmed,
    /// 明确读到结果没有发生。
    Unchanged,
    /// 读不出来（目标丢了 / 身份对不上）。绝不当成成功。
    Indeterminate,
}

/// 三道闸编排所依赖的三段可替换步骤。把它做成接口，是为了让判据能脱离浏览器被断言——
/// 退役实现正是靠同样的两个窄接口，把定位逻辑全部跑在桩上。
pub trait LocatingSteps {
    /// 解析目标。每一轮都必须**重新解析**，不得复用上一轮的活引用。
    fn resolve(
        &mut self,
        attempt: u32,
    ) -> impl std::future::Future<Output = Result<Resolution, EngineError>>;

    /// 把写动作落到页面上。
    fn actuate(
        &mut self,
        target: &ResolvedTarget,
    ) -> impl std::future::Future<Output = Result<Actuation, EngineError>>;

    /// 后置校验：按同一绑定目标**重新读回**业务结果。
    fn validate(
        &mut self,
        target: &ResolvedTarget,
    ) -> impl std::future::Future<Output = Result<Verdict, EngineError>>;
}

/// 重试上限。与退役实现同为 3 轮。
pub const DEFAULT_MAX_ATTEMPTS: u32 = 3;

/// 跑一次「解析 → 执行 → 后置校验」的有界闭环，并按结果维护锚点暂存区。
///
/// 🔴 从写动作派发到校验返回之间**不得取消**：页面已经被写、结果尚未校验，中止 = 把一次
/// 可能已生效的写当成没发生（缓存记账也全在校验之后，会一并漂移）。
pub async fn run_locating_gates<S: LocatingSteps>(
    steps: &mut S,
    cache: &mut AnchorCache,
    max_attempts: u32,
) -> Result<LocatingOutcome, EngineError> {
    let attempts_cap = max_attempts.max(1);
    let mut dispatched_any = false;
    let mut attempts = 0;
    while attempts < attempts_cap {
        attempts += 1;
        let target = match steps.resolve(attempts).await? {
            Resolution::Found(target) => target,
            Resolution::Missing => continue,
            // 来源不可用 ≠ 平台改版：立刻升级、不再重试，免得把一次「查不了」谎报成「改版了」。
            Resolution::SourceUnavailable => {
                return Ok(LocatingOutcome::Escalated {
                    attempts,
                    kind: EscalationKind::ResolverUnavailable,
                });
            }
        };
        // 闸③上半：非确定性来源的新锚点先进暂存区，绝不直接覆盖主缓存。
        cache.stage_non_deterministic(&target);
        let actuation = steps.actuate(&target).await?;
        if !actuation.dispatched {
            continue;
        }
        dispatched_any = true;
        // 闸①：写完必须重新读回业务结果。
        match steps.validate(&target).await? {
            Verdict::Confirmed => {
                cache.record_success(&target);
                return Ok(LocatingOutcome::Confirmed { attempts });
            }
            verdict => {
                // 闸③下半：校验没过 ⇒ 该锚点疑似失效 ⇒ 暂存项当场丢弃、绝不晋升。
                cache.record_failure(&target);
                if !actuation.replayable {
                    return Ok(LocatingOutcome::Ambiguous {
                        attempts,
                        reason: if verdict == Verdict::Unchanged {
                            "dispatched_not_replayable_unchanged"
                        } else {
                            "dispatched_not_replayable_indeterminate"
                        },
                    });
                }
            }
        }
    }
    // 闸②：上限耗尽才给升级结论，且区分「一次都没写下去」与「写下去了但结果始终没发生」。
    if dispatched_any {
        Ok(LocatingOutcome::Escalated {
            attempts,
            kind: EscalationKind::SystemicRevision,
        })
    } else {
        Ok(LocatingOutcome::NoTarget { attempts })
    }
}

/// 锚点缓存的运行模式。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AnchorCacheMode {
    /// 运行时读主缓存；新锚点先暂存，连续确认成功达阈值才晋升。
    ReadWrite,
    /// 只读主缓存，运行时绝不回写（生产推荐）。新锚点只能离线 / 金丝雀晋升。
    ReadOnly,
    /// 读恒为空，强制每次重新解析。仅建库阶段用。
    WriteOnly,
}

/// 主缓存里的一条锚点。
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct AnchorEntry {
    pub anchor: String,
    pub hit_count: u32,
    pub fail_count: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct StagedAnchor {
    anchor: String,
    confirmations: u32,
}

/// 主缓存 + 暂存区两层。反污染要义：一次非确定性解析**不**直接覆盖主缓存，
/// 避免单次错误被复制成系统性故障。
#[derive(Clone, Debug)]
pub struct AnchorCache {
    mode: AnchorCacheMode,
    confirm_threshold: u32,
    primary: BTreeMap<String, AnchorEntry>,
    staged: BTreeMap<String, StagedAnchor>,
}

impl AnchorCache {
    pub fn new(mode: AnchorCacheMode, confirm_threshold: u32) -> Self {
        Self {
            mode,
            confirm_threshold: confirm_threshold.max(1),
            primary: BTreeMap::new(),
            staged: BTreeMap::new(),
        }
    }

    pub fn mode(&self) -> AnchorCacheMode {
        self.mode
    }

    /// 读主缓存。只写模式恒返回空——强制每次重新解析。
    pub fn get(&self, key: &str) -> Option<&AnchorEntry> {
        if self.mode == AnchorCacheMode::WriteOnly {
            return None;
        }
        self.primary.get(key)
    }

    /// 暂存区当前是否为空。**当前引擎里它恒为空**（无非确定性锚点来源），保留此查询是为了
    /// 让「空转」这件事可被断言、而不是被读成「已经在自愈了」。
    pub fn staged_len(&self) -> usize {
        self.staged.len()
    }

    pub fn staged_confirmations(&self, key: &str) -> u32 {
        self.staged
            .get(key)
            .map(|staged| staged.confirmations)
            .unwrap_or(0)
    }

    /// 闸③上半：只有**非确定性**来源的锚点才进暂存区。确定性选择器的命中不是「学到新东西」，
    /// 把它也塞进来会把「防单次错误扩散」偷换成「稳定性统计」。
    pub fn stage_non_deterministic(&mut self, target: &ResolvedTarget) {
        if target.source != AnchorSource::NonDeterministic || self.mode == AnchorCacheMode::ReadOnly
        {
            return;
        }
        match self.staged.get_mut(&target.key) {
            // 暂存的锚点与新解析不一致 ⇒ 还不稳定 ⇒ 确认计数归零。
            Some(staged) if staged.anchor != target.anchor => {
                staged.anchor = target.anchor.clone();
                staged.confirmations = 0;
            }
            Some(_) => {}
            None => {
                self.staged.insert(
                    target.key.clone(),
                    StagedAnchor {
                        anchor: target.anchor.clone(),
                        confirmations: 0,
                    },
                );
            }
        }
    }

    /// 后置校验通过：主缓存记命中；暂存项累加确认，达阈值才晋升。
    pub fn record_success(&mut self, target: &ResolvedTarget) {
        if let Some(entry) = self.primary.get_mut(&target.key)
            && entry.anchor == target.anchor
        {
            entry.hit_count = entry.hit_count.saturating_add(1);
            entry.fail_count = 0;
        }
        if self.mode == AnchorCacheMode::ReadOnly {
            return;
        }
        let Some(staged) = self.staged.get_mut(&target.key) else {
            return;
        };
        if staged.anchor != target.anchor {
            staged.anchor = target.anchor.clone();
            staged.confirmations = 0;
            return;
        }
        staged.confirmations = staged.confirmations.saturating_add(1);
        if staged.confirmations >= self.confirm_threshold {
            let anchor = staged.anchor.clone();
            self.staged.remove(&target.key);
            self.primary.insert(
                target.key.clone(),
                AnchorEntry {
                    anchor,
                    hit_count: 1,
                    fail_count: 0,
                },
            );
        }
    }

    /// 后置校验没过：主缓存记失败；暂存项**当场丢弃**，永不晋升。
    pub fn record_failure(&mut self, target: &ResolvedTarget) {
        if let Some(entry) = self.primary.get_mut(&target.key)
            && entry.anchor == target.anchor
        {
            entry.fail_count = entry.fail_count.saturating_add(1);
        }
        self.staged.remove(&target.key);
    }

    /// 直接写主缓存。仅供建库 / 离线晋升使用，运行时路径不得调用。
    pub fn install(&mut self, key: &str, anchor: &str) {
        self.primary.insert(
            key.to_owned(),
            AnchorEntry {
                anchor: anchor.to_owned(),
                hit_count: 0,
                fail_count: 0,
            },
        );
    }

    /// 导出主缓存快照。**暂存区不进快照**——没被确认过的东西不该跨进程扩散。
    pub fn snapshot(&self) -> String {
        serde_json::to_string(&self.primary).unwrap_or_else(|_| "{}".to_owned())
    }

    /// 载入主缓存快照。畸形快照一律拒绝并保持原状，绝不半载入。
    pub fn load(&mut self, snapshot: &str) -> Result<usize, EngineError> {
        let parsed: BTreeMap<String, AnchorEntry> =
            serde_json::from_str(snapshot).map_err(|_| {
                EngineError::new(
                    crate::error::ErrorCode::InvalidRequest,
                    "native anchor cache snapshot is malformed",
                )
            })?;
        let loaded = parsed.len();
        self.primary = parsed;
        Ok(loaded)
    }
}
