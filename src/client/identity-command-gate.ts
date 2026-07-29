/**
 * identity-command-gate.ts — 身份未落定时，节点不许代表这个账号动作，也不许以陈旧身份重新上线
 * ===========================================================================================
 * 背景（本轮复验实测坐实的漏网入口）：`halt` 是**纯返回**——它停浏览、停观测、断云端，但**从不关
 * 浏览器**。浏览器仍开着、登着一个我们已经明说「不知道是谁」的账号。此时：
 *   - 运营在客户端切一次云端环境 → 重绑是 `client.rebind(url)` 一步到位、全程不问身份 ⇒ 节点以**陈旧
 *     身份**对新云端宣称在线。云端看到一个健康在线的节点，照常给它派发布 / 任务认领。
 *   - 那些指令会经协调器与执行器**真的执行** ⇒ 在未知身份下真发帖、记账挂到错账号。
 * 这比「浏览循环空转」重一个量级：前者只是白烧动作，后者在平台上留下**真实痕迹**且账目是错的。
 *
 * ── 判据落在哪一层 ──
 * 复用既有的操作登记表（`operation-registry.ts`）的 `identity` 维度，不新造一套分类：
 *   `identity: 'page_account'` ＝ **以页面上登着的那个账号的名义**做事（发布原子、评论 / 点赞 / 关注、
 *   任务认领、浏览动作…）。这一维本来就是为「这个操作代表谁」而设的，身份闸的边界与它逐字重合。
 * 其余维度（`bound_account` 的节奏 / 快照、`none` 的心跳）不代表账号动作，一律不拦。
 *
 * ── 为什么是「补集」而不是「黑名单」──
 * 被拦的是 `page_account` **减去**一张具名的救援 / 收尾清单。新增命令默认落进被拦的一侧（fail-closed）。
 * 反过来写成「拦这几条」，则今后每加一条页面命令都会**默认放行**，而没有任何机械手段会提醒你漏了它。
 *
 * ── 放行清单为什么是这几条（判据：拦掉它会让节点**更难救**，且它本身不在平台上留痕）──
 *   `edge.task.release`            释放租约永远安全；拦掉则租约挂着不放、云端侧一直以为任务在跑。
 *   `identity.read_current`        「现在到底登着谁」正是解开这个终局所需要的事实，拦掉等于把灯关了。
 *   `identity.read_self_profile`   同上。
 *   `captcha.assist.capture/click` 远程验证码协助是**救援通道**（很多时候正是它挡着身份读不出来）；
 *                                  它不代表账号发内容，拦掉会把唯一的自救路径也堵死。
 *   `session.end`                  云端拆会话是收尾，不是动作。
 * 注意它们全都是「读 / 收尾 / 救援」，没有一条会在平台上产生该账号名下的新痕迹——这就是那条线。
 */
import type { MessageType } from '../comm/protocol.js';
import type { IdentityHealth } from '../native-page-engine/identity-guard.js';
import { operationDescriptorFor } from './operation-registry.js';

export type IdentityCommandVerdict =
  | { kind: 'allow' }
  | { kind: 'refuse'; reason: 'identity_unresolved'; detail: string };

const IDENTITY_RESCUE_OPERATIONS: ReadonlySet<string> = new Set<MessageType>([
  'edge.task.release',
  'identity.read_current',
  'identity.read_self_profile',
  'captcha.assist.capture',
  'captcha.assist.click',
  'session.end',
]);

/** 身份是否已落定。`reestablishing` 也不算——那一刻我们已经判定「页面上的人变了」，只是还没换完。 */
export function identityResolved(health: IdentityHealth | undefined): boolean {
  return (health ?? 'healthy') === 'healthy';
}

function unresolvedDetail(health: IdentityHealth): string {
  return health === 'invalid'
    ? '运行期身份停在无身份终局（不知道浏览器里登着谁）'
    : '运行期身份正在重立中（已判定页面上的账号变了，新身份尚未确立）';
}

/**
 * 云端命令的身份闸。
 *
 * 身份未落定时，凡是**以页面账号名义**动作的命令一律拒绝并如实回执（绝不静默丢弃：云端分不清
 * 「命令没触达」与「执行了但没结果」）。救援 / 读 / 收尾类照常放行。
 */
export function judgeCommandUnderIdentity(
  health: IdentityHealth | undefined,
  type: MessageType,
): IdentityCommandVerdict {
  const current = health ?? 'healthy';
  if (identityResolved(current)) return { kind: 'allow' };
  if (IDENTITY_RESCUE_OPERATIONS.has(type)) return { kind: 'allow' };
  const descriptor = operationDescriptorFor(type);
  // 未登记的命令另有一道 fail-closed 闸（EdgeClient 入口）会拒；这里不重复表态。
  if (!descriptor || descriptor.identity !== 'page_account') return { kind: 'allow' };
  return {
    kind: 'refuse',
    reason: 'identity_unresolved',
    detail: `${unresolvedDetail(current)}：拒绝代表该账号执行 ${type}`,
  };
}

export type CloudRebindVerdict = { kind: 'allow' } | { kind: 'refuse'; reason: string };

/**
 * 切换云端环境（重绑控制传输）的身份闸。
 *
 * **裁定：拒绝，而不是「允许但不带身份」。** 两条理由：
 *   ① 协议上就没有「不带身份的在线」这一态——`hello` 必须带 accountId，不带会被云端以
 *      `missing_account_id` 拒绝握手。那样运营看到的是「云端拒绝了这个节点」，把人推去查云端配置，
 *      而真正的原因（浏览器里登着谁不知道）被盖住了：换来的是一个**更难排查**的假象。
 *   ② 「不宣称在线」正是此刻的**事实**。节点确实什么也做不了，云端把它当不在场是对的；而带着陈旧
 *      accountId 上线会让云端把它当成那个账号的健康节点、照常派活——那才是真发帖记错账的入口。
 * 拒绝是可恢复的：处理办法与 halt 本身相同（重新登录目标账号后重启本环境），重启时自然会连上新选的云端。
 */
export function judgeCloudRebindUnderIdentity(health: IdentityHealth | undefined): CloudRebindVerdict {
  const current = health ?? 'healthy';
  if (identityResolved(current)) return { kind: 'allow' };
  return {
    kind: 'refuse',
    reason: `identity_unresolved: ${unresolvedDetail(current)}——拒绝以陈旧身份对新的云端环境宣称在线。`
      + '请在浏览器里重新登录目标账号后重启本环境，重启时会直接连到新选的云端。',
  };
}
