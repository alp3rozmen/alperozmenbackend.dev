// Gavelon oyun verisi bütünlük kontrolü. Mobil uygulamadaki src/engine/core/validate.ts ile aynı kurallar:
// hatalı veri yayınlanmaz, oyun son geçerli sürümle çalışmaya devam eder.

const LEAGUES = ['sokak', 'sehir', 'kita', 'gezegen', 'kozmik'];
const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;
const HEX = /^#[0-9a-fA-F]{6}$/;

function filterCharacters(characters, table) {
  const f = table.filter || {};
  return characters.filter(
    (c) =>
      (!f.universes || f.universes.includes(c.universe)) &&
      (!f.categories || f.categories.includes(c.category)) &&
      (!f.leagues || f.leagues.includes(c.league)) &&
      (!f.tags || f.tags.some((t) => c.tags.includes(t)))
  );
}

// Tek kayıt biçim kontrolü (kaydetmeden önce). Hata metni ya da null döner.
function checkEntity(entity, o) {
  const str = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
  if (!SLUG.test(String(o.id || ''))) return 'id yalnızca küçük harf, rakam ve tire içermeli (en fazla 40 karakter).';
  if (!str(o.name, 100)) return 'Ad zorunlu.';
  switch (entity) {
    case 'universes':
      if (!HEX.test(String(o.color || ''))) return 'Renk #RRGGBB biçiminde olmalı.';
      break;
    case 'characters':
      if (!SLUG.test(String(o.universe || ''))) return 'Evren seçilmeli.';
      if (!str(o.category, 40)) return 'Kategori zorunlu.';
      if (!LEAGUES.includes(o.league)) return `Lig şunlardan biri olmalı: ${LEAGUES.join(', ')}`;
      if (!Array.isArray(o.tags) || o.tags.length === 0 || !o.tags.every((t) => typeof t === 'string' && SLUG.test(t))) {
        return 'En az bir etiket gerekli (küçük harf/rakam/tire).';
      }
      if (o.image != null && o.image !== '' && !/^https?:\/\/\S+$/.test(o.image)) return 'Görsel http(s) adresi olmalı.';
      if (typeof o.hint !== 'string' || o.hint.length > 500) return 'İpucu en fazla 500 karakter.';
      break;
    case 'bonds': {
      const c = o.condition;
      if (!c || (c.type !== 'characters' && c.type !== 'tag')) return 'Koşul türü characters ya da tag olmalı.';
      if (c.type === 'characters' && (!Array.isArray(c.ids) || c.ids.length < 2)) return 'En az 2 karakter seçilmeli.';
      if (c.type === 'tag' && (!SLUG.test(String(c.tag || '')) || !Number.isInteger(c.count) || c.count < 2)) {
        return 'Etiket ve en az 2 adet gerekli.';
      }
      if (!Number.isInteger(o.bonus) || o.bonus < 1 || o.bonus > 50) return 'Bonus 1-50 arası tam sayı olmalı.';
      break;
    }
    case 'tables':
      if (!o.filter || typeof o.filter !== 'object' || Array.isArray(o.filter)) return 'Filtre nesne olmalı.';
      break;
    case 'scenarios':
      if (!o.modifiers || typeof o.modifiers !== 'object' || Array.isArray(o.modifiers)) return 'Etkiler nesne olmalı.';
      if (!Object.values(o.modifiers).every((v) => Number.isInteger(v) && Math.abs(v) <= 50)) return 'Etkiler -50..50 arası tam sayı olmalı.';
      break;
    default:
  }
  return null;
}

function checkConfig(c) {
  if (!c || typeof c !== 'object') return 'Ayar nesnesi gerekli.';
  for (const l of LEAGUES) if (!Number.isInteger(c.leagues?.[l]) || c.leagues[l] < 1) return `${l} lig puanı pozitif tam sayı olmalı.`;
  if (!Number.isInteger(c.eloK) || c.eloK < 1) return 'eloK pozitif tam sayı olmalı.';
  const k = c.classic;
  if (!k || !Number.isInteger(k.budget) || !Number.isInteger(k.teamSize) || !Number.isInteger(k.minPrice)) return 'Klasik mod sayıları tam sayı olmalı.';
  if (k.teamSize < 1 || k.minPrice < 1 || k.budget < k.teamSize * k.minPrice) return 'Bütçe, takım boyu × en düşük fiyattan küçük olamaz.';
  if (!Array.isArray(c.turnTimers) || c.turnTimers.length === 0 || !c.turnTimers.every((t) => t === null || (Number.isInteger(t) && t > 0))) {
    return 'Tur süreleri boş olmayan liste olmalı (null = süresiz).';
  }
  return null;
}

// Tüm veri kümesi: çapraz referanslar. Hata listesi döner (boş = geçerli).
function validateGameData(data) {
  const errors = [];
  const universeIds = new Set(data.universes.map((u) => u.id));
  const charIds = new Set();

  for (const c of data.characters) {
    if (charIds.has(c.id)) errors.push(`Tekrarlanan karakter id: ${c.id}`);
    charIds.add(c.id);
    if (!universeIds.has(c.universe)) errors.push(`${c.id}: bilinmeyen evren ${c.universe}`);
  }

  const allTags = new Set(data.characters.flatMap((c) => c.tags));
  for (const b of data.bonds) {
    if (b.condition.type === 'characters') {
      for (const id of b.condition.ids) if (!charIds.has(id)) errors.push(`Bağ ${b.id}: bilinmeyen ya da pasif karakter ${id}`);
    } else if (!allTags.has(b.condition.tag)) {
      errors.push(`Bağ ${b.id}: hiçbir karakterde olmayan etiket ${b.condition.tag}`);
    }
  }
  for (const s of data.scenarios) {
    for (const tag of Object.keys(s.modifiers)) if (!allTags.has(tag)) errors.push(`Senaryo ${s.id}: hiçbir karakterde olmayan etiket ${tag}`);
  }
  const needed = data.config.classic.teamSize * 2;
  if (data.tables.length === 0) errors.push('En az bir masa gerekli.');
  for (const t of data.tables) {
    const pool = filterCharacters(data.characters, t).length;
    if (pool < needed) errors.push(`Masa ${t.id}: havuz ${pool} karakter, en az ${needed} gerekli`);
  }
  if (data.scenarios.length === 0) errors.push('En az bir senaryo gerekli.');
  return errors;
}

module.exports = { LEAGUES, SLUG, checkEntity, checkConfig, validateGameData };
