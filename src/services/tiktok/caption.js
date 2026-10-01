const TiktokIdea = require('../../models/TiktokIdea');

async function ideaItem(ideaId, ideaIndex) {
  if (!ideaId) return null;
  const idea = await TiktokIdea.findById(ideaId);
  return idea?.ideas?.[ideaIndex] || null;
}

// Telegram'a giden videonun altındaki metin: başlık + hook + TikTok açıklaması + hashtag'ler
function buildCaption(title, item, extra) {
  return [
    title,
    item && `\n🪝 ${item.hookText}`,
    item && `\n${item.caption}`,
    item && `\n${item.hashtags.join(' ')}`,
    extra && `\n${extra}`,
  ].filter(Boolean).join('\n');
}

module.exports = { ideaItem, buildCaption };
