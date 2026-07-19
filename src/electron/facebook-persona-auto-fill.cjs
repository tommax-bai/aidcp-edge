'use strict';

const WRITING_LANGUAGES = new Set(['zh-CN', 'en', 'vi']);

function normalizeFacebookPersonaAutoFillOptions(opts) {
  const raw = opts && typeof opts === 'object' ? opts : {};
  if (raw.facebookPersonaAutoFill === false) return { ok: true, enabled: false };
  const provided = raw.facebookPersonaWritingLanguage;
  if (provided !== undefined && !WRITING_LANGUAGES.has(provided)) {
    return { ok: false, error: 'Facebook 人设发言语言不合法' };
  }
  return { ok: true, enabled: true, writingLanguage: provided || 'zh-CN' };
}

/**
 * 向 customer-auth 提交一次批次意图。请求体刻意没有 accountId/envKey/导入资料；
 * createdItems 只用于本地确认至少有一个环境已被 Cloud 权威归属，不进入网络 body。
 */
async function requestFacebookPersonaAutoFill({
  request,
  token,
  idempotencyKey,
  writingLanguage,
  createdItems,
}) {
  const authoritativeCreated = (Array.isArray(createdItems) ? createdItems : [])
    .some((item) => item && item.assignedToCurrentClient === true && item.requiresAdminAssignment !== true);
  if (!authoritativeCreated) {
    return {
      accepted: false,
      attempted: false,
      warning: '人设自动补齐尚未提交：本批没有完成 Cloud 权威归属的环境。',
    };
  }
  if (typeof request !== 'function' || !token) {
    return {
      accepted: false,
      attempted: false,
      warning: '人设自动补齐尚未提交：客户端 Cloud 登录不可用。',
    };
  }

  let response = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    response = await request('/persona-auto-fill/runs', {
      method: 'POST',
      token,
      idempotencyKey,
      body: {
        platform: 'facebook',
        strategy: 'facebook_auto_v1',
        writingLanguage,
      },
    });
    if (response && (response.ok || (response.status > 0 && response.status < 500))) break;
  }
  if (response && response.ok) return { accepted: true, attempted: true };
  const reason = response && response.data && response.data.error;
  return {
    accepted: false,
    attempted: true,
    sessionExpired: Boolean(response && response.status === 401),
    warning: `环境已创建，但云端未受理人设自动补齐${reason ? `（${reason}）` : ''}。`,
  };
}

module.exports = {
  WRITING_LANGUAGES,
  normalizeFacebookPersonaAutoFillOptions,
  requestFacebookPersonaAutoFill,
};
