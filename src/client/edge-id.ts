/**
 * 节点身份（edgeId）派生。
 *
 * edgeId 在云端是【双重身份】：既是「节点身份」（判定同节点重连 / 顶替旧连接），
 * 又是「下行路由地址」（按它把命令、验证码暂停发回某个节点）。因此它必须同时满足两条：
 *  - 【唯一】：不同节点的 edgeId 不能相同。否则云端把两个不同账号的节点误判成「同一节点重连」而互相顶掉下线，
 *    且下行命令会按同一 edgeId 串发到别的账号浏览器。
 *  - 【稳定】：同一个节点每次重启 edgeId 不变。否则云端认不出「同节点重连」，半死的旧连接要拖到心跳超时才清。
 *
 * 旧实现把缺省值钉成共享常量 'edge-local'，两条都不满足——同机（或跨机）两个裸 `npm start`（不同账号）
 * 都领到 'edge-local'，于是在云端互踢。本函数改为按节点真实隔离边界派生唯一且稳定的缺省值，
 * 任何情况都【绝不回落共享常量】：
 *  1. 显式 AIDCP_EDGE_ID：直接用（逃生阀；launch-multinode 也走这条，给每槽位注入独立值）。
 *  2. 分身浏览器（adspower）：用分身 id → `ads-<profileId>`（与 launch-multinode 同公式，裸起=多开同一套身份）。
 *  3. 自起浏览器（self）：用该节点专属 user-data-dir 末段 → `self-<dir>`（各节点目录不同、重启不变）。
 *  4. 兜底：用主机名 → `host-<name>`（跨机唯一；同机多个「无分身、无独立目录」的裸起仍可能撞，故附告警提示设 AIDCP_EDGE_ID）。
 */
import { hostname as osHostname } from 'node:os';
import { basename } from 'node:path';

export type EdgeIdSource =
  | 'env-override'
  | 'adspower-profile'
  | 'self-profile-dir'
  | 'hostname-fallback';

export interface EdgeIdDerivation {
  edgeId: string;
  source: EdgeIdSource;
  /** 仅兜底分支携带：同机多个裸起仍可能撞 edgeId，应显式设 AIDCP_EDGE_ID。 */
  warning?: string;
}

/**
 * 按优先级派生节点身份。注入 env / hostname 以便单测（缺省读真实 process.env / os.hostname）。
 */
export function deriveEdgeId(
  env: NodeJS.ProcessEnv = process.env,
  hostnameFn: () => string = osHostname,
): EdgeIdDerivation {
  const explicit = env.AIDCP_EDGE_ID?.trim();
  if (explicit) return { edgeId: explicit, source: 'env-override' };

  const adsId = env.AIDCP_ADS_USER_ID?.trim();
  if (adsId) return { edgeId: `ads-${adsId}`, source: 'adspower-profile' };

  const profileDir = env.AIDCP_CHROME_PROFILE?.trim();
  if (profileDir) {
    // 去掉结尾分隔符再取末段；末段为空（如根路径）则退回整串，仍唯一稳定。
    const tail = basename(profileDir.replace(/[\\/]+$/, '')) || profileDir;
    return { edgeId: `self-${tail}`, source: 'self-profile-dir' };
  }

  const host = hostnameFn()?.trim() || 'unknown';
  return {
    edgeId: `host-${host}`,
    source: 'hostname-fallback',
    warning:
      '未设 AIDCP_EDGE_ID，且无分身 id / 独立 user-data-dir 可派生稳定节点身份，已回落主机名。' +
      '同一台机器上多个裸 npm start 仍可能 edgeId 撞车互踢——请为各节点显式设置独立 AIDCP_EDGE_ID。',
  };
}
