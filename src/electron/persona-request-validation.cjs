const MAX_PERSONA_KEYWORD_SELECTIONS = 64;
const MAX_PERSONA_KEYWORD_LENGTH = 40;

function validatePersonaKeywordSelections(value) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    return { ok: false, reason: 'invalid_request', message: 'keywordSelections 不合法' };
  }
  if (
    value.length > MAX_PERSONA_KEYWORD_SELECTIONS
    || value.some((item) => item.length > MAX_PERSONA_KEYWORD_LENGTH)
  ) {
    return { ok: false, reason: 'input_too_large', message: '关键词太多或太长' };
  }
  return { ok: true };
}

module.exports = {
  MAX_PERSONA_KEYWORD_SELECTIONS,
  MAX_PERSONA_KEYWORD_LENGTH,
  validatePersonaKeywordSelections,
};
