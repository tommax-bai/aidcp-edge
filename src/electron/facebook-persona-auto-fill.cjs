'use strict';

const WRITING_LANGUAGES = new Set(['zh-CN', 'en', 'vi']);
const TONES = new Set(['亲切接地气', '专业理性', '活泼幽默', '温柔治愈', '犀利真实']);
const LIKE_AFFINITIES = new Set(['normal', 'like_more', 'like_most']);
const MAX_SELECTED_PERSONA_BYTES = 32 * 1024;

function quoteScalar(value) {
  return `"${String(value).replace(/"/g, '\\"').replace(/\r\n?/g, '\n').replace(/\n/g, '\\n')}"`;
}

function stringList(raw, maxItems = 12) {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.map((item) => String(item || '').trim().slice(0, 40)).filter(Boolean))].slice(0, maxItems);
}

function emitList(key, values) {
  if (!values.length) return [`  ${key}: []`];
  return [`  ${key}:`, ...values.map((value) => `    - ${quoteScalar(value)}`)];
}

function likePrinciple(affinity, primary) {
  const topics = primary.slice(0, 3).join('、');
  if (affinity === 'like_most') return `对${topics}相关且内容真实、有启发的帖子更积极点赞，但不强制互动`;
  if (affinity === 'like_more') return `对${topics}相关且确实喜欢的帖子适度增加点赞，仍按内容判断`;
  return `只在真正喜欢且符合${topics}兴趣的内容上自然点赞`;
}

/** 根据用户在客户端明确选择的内容确定性构建一份批量模板；不调用模型。 */
function buildFacebookSelectedPersona(selection) {
  const raw = selection && typeof selection === 'object' && !Array.isArray(selection) ? selection : {};
  const tone = String(raw.tone || '').trim();
  const writingLanguage = String(raw.writingLanguage || '').trim();
  const likeAffinity = String(raw.likeAffinity || '').trim();
  const contentPreferences = stringList(raw.contentPreferences);
  const contentCategories = stringList(raw.contentCategories, 8);
  if (!TONES.has(tone)) return { ok: false, reason: 'tone_required' };
  if (!WRITING_LANGUAGES.has(writingLanguage)) return { ok: false, reason: 'writing_language_required' };
  if (!LIKE_AFFINITIES.has(likeAffinity)) return { ok: false, reason: 'like_affinity_invalid' };
  if (!contentPreferences.length) return { ok: false, reason: 'content_preferences_required' };

  const primary = contentPreferences.slice(0, 5);
  const secondary = contentCategories.filter((item) => !primary.includes(item)).slice(0, 4);
  const seedKeywords = contentPreferences.slice(0, 8);
  const subject = contentCategories[0] || primary[0];
  const name = `${primary[0]}兴趣分享者`;
  const role = `${subject}内容爱好者`;
  const background = `关注${primary.slice(0, 3).join('、')}，围绕这些兴趣持续浏览、互动和分享，表达保持真实克制`;
  const lines = [
    'identity:',
    `  name: ${quoteScalar(name)}`,
    `  role: ${quoteScalar(role)}`,
    `  background: ${quoteScalar(background)}`,
    `  tone: ${quoteScalar(tone)}`,
    `writing_language: ${quoteScalar(writingLanguage)}`,
    'interests:',
    ...emitList('primary', primary),
    ...emitList('secondary', secondary),
    ...emitList('seed_keywords', seedKeywords),
    'behavior_guidelines:',
    `  style: ${quoteScalar(`${tone}；浏览、点赞与收藏保持自然、有分寸`)}`,
    `  privacy: ${quoteScalar('不编造私人经历或关系，不泄露隐私，不做越权承诺')}`,
    `  collection_principle: ${quoteScalar('只收藏会反复参考、能直接复用或确有长期价值的内容；收藏比点赞更稀有')}`,
    `  like_principle: ${quoteScalar(likePrinciple(likeAffinity, primary))}`,
    `  like_affinity: ${quoteScalar(likeAffinity)}`,
  ];
  const soulYaml = `${lines.join('\n')}\n`;
  if (Buffer.byteLength(soulYaml, 'utf8') > MAX_SELECTED_PERSONA_BYTES) {
    return { ok: false, reason: 'input_too_large' };
  }
  return { ok: true, soulYaml, identitySummary: `${name}·${role}（${primary.slice(0, 3).join('、')}）` };
}

/** 只提交用户已确认的完整模板；目标范围由 Cloud 从客户令牌与权威绑定确定。 */
async function requestFacebookSelectedPersonaFill({ request, token, idempotencyKey, soulYaml }) {
  if (typeof soulYaml !== 'string' || !soulYaml.trim() || Buffer.byteLength(soulYaml, 'utf8') > MAX_SELECTED_PERSONA_BYTES) {
    return { accepted: false, attempted: false, warning: '所选人设无效，请重新选择。' };
  }
  if (typeof request !== 'function' || !token) {
    return { accepted: false, attempted: false, warning: '客户端 Cloud 登录不可用。' };
  }
  let response = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    response = await request('/persona-auto-fill/runs', {
      method: 'POST',
      token,
      idempotencyKey,
      body: { platform: 'facebook', soulYaml },
    });
    if (response && (response.ok || (response.status > 0 && response.status < 500))) break;
  }
  if (response && response.ok) return { accepted: true, attempted: true };
  const reason = response && response.data && response.data.error;
  return {
    accepted: false,
    attempted: true,
    sessionExpired: Boolean(response && response.status === 401),
    warning: `云端未受理批量人设设置${reason ? `（${reason}）` : ''}。`,
  };
}

module.exports = {
  MAX_SELECTED_PERSONA_BYTES,
  buildFacebookSelectedPersona,
  requestFacebookSelectedPersonaFill,
};
