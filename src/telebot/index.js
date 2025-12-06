const { mainDb } = require('../dbConnection');
require("dotenv").config();
const { Telegraf, Markup, Scenes } = require("telegraf");
const User = require("../models/UserTeleBot")(mainDb);
const { GoogleGenAI } = require("@google/genai");
const fetch = require("node-fetch");
const dayjs = require("dayjs");
const bot = new Telegraf(process.env.BOT_TOKEN);
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API });
const RSS_URL = "https://www.coindesk.com/arc/outboundfeeds/rss"
const botBalyoz = new Telegraf(process.env.BOT_TOKEN_CRYPTO);
const CHANNEL_ID = '@guncelkriptohaber';
let lastTitle = "";

const falMessagesFallback = [
  "Yakında beklediğin bir haber gelebilir. ☕️",
  "Kalbinde bir sızı var ama yakında hafifleyecek.",
  "Yeni bir tanışma işaretleri görünüyor, dikkatli ol.",
  "Kariyerinde küçük ama olumlu bir adım atılacak.",
  "Ev içinde hareketlenme var, güzel gelişmeler olacak."
];

async function aiTranslateAndSummarize(title, content) {
  const contents = [
    {
      text: `İngilizce kripto haberini Türkçe'ye çevir ve 3-5 cümleyle özetle sadece cümleyi ver paylaşılacak çünkü. 
      Başlık: ${title}
      İçerik: ${content}`
    }
  ];

  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents,
    config: {
      systemInstruction: "Sen profesyonel bir kripto haber editörüsün. Haberleri Türkçe ve okunabilir şekilde özetle."
    }
  });

  return response.text || "Haber çevirisi sırasında hata oluştu.";
}

// RSS’den haber çekip kanala gönder
async function fetchAndPostNews() {
  try {
    const parser = new Parser();
    const feed = await parser.parseURL(RSS_URL);
    const today = dayjs().format("YYYY-MM-DD"); // bugünün tarihi
    const latest = feed.items[0];
    
    if (!feed.items.length) return;

    const pubDate = dayjs(latest.pubDate || latest.isoDate).format("YYYY-MM-DD");
    
    if (pubDate !== today) {
      console.log("❌ Haber bugün değil, atlanıyor:", latest.title);
      return; // bugünün haberleri dışında atlama
    }

    
    if (latest.title === lastTitle) return; // aynı haberi tekrar atma
    lastTitle = latest.title;

    const translated = await aiTranslateAndSummarize(
      latest.title,
      latest.contentSnippet || latest.content
    );

    const message = `📰 <b>${latest.title}</b>\n\n${translated}\n\n🔗 Kaynak: ${latest.link}`;

    await botBalyoz.telegram.sendMessage(CHANNEL_ID, message, { parse_mode: "HTML" });
    console.log("✅ BotBalyoz haber paylaşıldı:", latest.title);

  } catch (err) {
    console.error("❌ BotBalyoz Hata:", err.message);
  }
}

// Start ve hoşgeldin
bot.start(async (ctx) => {
  const telegramId = String(ctx.from.id);
  const username = ctx.from.username;

  let user = await User.findOne({ telegramId });
  if (!user) {
    user = await User.create({ telegramId, username, credits: 0, isFollowChannel: false });
  } else {
    user.username = username;
    await user.save();
  }

  const welcomeMessage = `Merhaba ${username || "misafir"}! ☕ TelveciAI’ye hoş geldin.`;

  await ctx.reply(
    welcomeMessage,
    Markup.inlineKeyboard([
      [Markup.button.callback("📸 Fal Baktır (10 Kredi)", "fal_baktır")],
      [Markup.button.callback("♍ Burç Yorumu (10 Kredi)", "burc_yorumu")],
      [Markup.button.callback("💰 Kredi Durumu", "kredi_durumu")],
      [Markup.button.callback("💳 Kredi Satın Al", "odeme_yap")],
      [Markup.button.callback("🎁 Kanalımıza Katıl 10 Kredi Kazan", "hediye_kredi")],
      [Markup.button.callback("🎁 Arkadaşını Davet Et 10 Kredi Kazan", "hediye_kredi_davet")],
      [Markup.button.callback("🎁 Referans Kodu Kullan", "use_ref_code")]
    ])
  );
});


const burcYorumla = async (pBurcname, ctx) => {
  const telegramId = String(ctx.from.id);
  const user = await User.findOne({ telegramId });

  if (!user.credits || user.credits < 10) {
    return ctx.reply("⚠ Yeterli krediniz yok. Burç yorumu için 10 kredi gerekli.");
  }

  if (user.isProcessing) {
    return ctx.reply("⚠ Şuan bir isteğiniz işleniyor lütfen işlem bittikten sonra tekrar deneyiniz.");
  }

  user.credits -= 10;
  user.isProcessing = true;
  await user.save();

  const contents = [
    {
      text: `${pBurcname} + Bu burç için bugünün yorumunu yaparmısın`,
    }
  ];

  await ctx.reply(`🌙 Seçilen burç yorumlanıyor... 🔮\nBu işlem birkaç dakika sürebilir, yorum hazır olduğunda sana mesaj atacağız.`);

  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents,
      config: {
        systemInstruction: "Sen bir burç yorumcususun, adın TelveciAI",
      }
    });

    const aiComment = response.text;
    await ctx.reply(`🌙 TelveciAI yorumu:\n\n${aiComment}`);
    await ctx.reply(`🌙 Kalan Krediniz: ${user.credits}`);
    user.isProcessing = false;
    await user.save();
  } catch (err) {
    console.log(err);

    // Krediyi geri ver
    user.credits += 10;
    user.isProcessing = false;
    await user.save();
    await ctx.reply(`⚠ Burç yorumlanırken hata oluştu. Krediniz iade edildi.`);
  }

}

bot.on("message", async (ctx) => {
  if (ctx.chat.type === "group" || ctx.chat.type === "supergroup") {
    const username = ctx.from.username
      ? `@${ctx.from.username}`
      : ctx.from.first_name || "kullanıcı";

    // Grupta fal baktırmaya çalışan kişiye yönlendirme mesajı at
    await ctx.reply(
      `${username}, kahve falına baktırmak için lütfen botla özelden konuş 💌\n👉 [TelveciAI botuna git](https://t.me/telveciaibot) ve **/start** yaz.`,
      { parse_mode: "Markdown" }
    );

    // Gruba başka hiçbir şey atma
    return;
  }
});

// Fotoğraf geldiğinde fal üret
bot.on("photo", async (ctx) => {
  const telegramId = String(ctx.from.id);
  const user = await User.findOne({ telegramId });

  if (!user.credits || user.credits < 10) {
    return ctx.reply("⚠ Yeterli krediniz yok. Fal bakımı için 10 kredi gerekli.");
  }

  if (user.isProcessing) {
    return ctx.reply("⚠ Şuan bir isteğiniz işleniyor lütfen işlem bittikten sonra tekrar deneyiniz.");
  }

  user.credits -= 10;
  user.isProcessing = true;
  await user.save();

  const photo = ctx.message.photo[ctx.message.photo.length - 1];
  const fileLink = await ctx.telegram.getFileLink(photo.file_id);

  const res = await fetch(fileLink.href);
  const buffer = await res.arrayBuffer();
  const base64Image = Buffer.from(buffer).toString("base64");

  const contents = [
    {
      inlineData: {
        mimeType: "image/jpeg",
        data: base64Image,
      },
    },
    {
      text: "Bu fincanı yorumlarmısın? Fincan resmi değilse bu bir fincana benzemiyor."
    }
  ];

  await ctx.reply("📸 Fotoğraf alındı! Fal hazırlanıyor... 🔮\nBu işlem birkaç dakika sürebilir, fal hazır olduğunda sana mesaj atacağız.");

  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents,
      config: {
        systemInstruction: "Sen bir kahve falı uzmanısın, adın TelveciAI",
      }
    });

    const aiComment = response.text || falMessagesFallback[Math.floor(Math.random() * falMessagesFallback.length)];
    await ctx.reply(`🌙 TelveciAI yorumu:\n\n${aiComment}`);
    user.isProcessing = false;
    await user.save();
  } catch (err) {
    console.log(err);

    // Krediyi geri ver
    user.credits += 10;
    user.isProcessing = false;
    await user.save();

    const fallback = falMessagesFallback[Math.floor(Math.random() * falMessagesFallback.length)];
    await ctx.reply(`⚠ Fal yorumlanırken hata oluştu. Krediniz iade edildi.\n\nİşte eğlencelik bir yorum:\n\n${fallback}`);
  }

});

// Referans Kodu Sahnesi
const contactDataWizard = new Scenes.WizardScene(
  'REFERANCE_SCENE',
  (ctx) => {
    ctx.reply('Lütfen Referans Kodunu Girin:');
    ctx.wizard.state.contactData = {};
    return ctx.wizard.next();
  },
  async (ctx) => {
    const code = ctx.message.text?.trim();
    if (!code || code.length === 0) {
      await ctx.reply('❌ Geçersiz kod girdiniz.');
      return;
    }

    const telegramId = String(ctx.from.id);
    const user = await User.findOne({ telegramId });

    if (!user) {
      await ctx.reply('⚠ Kullanıcı bulunamadı.');
      return ctx.scene.leave();
    }

    if (user.isUsedRefCode) {
      await ctx.reply('❗ Daha önce bu ödülü zaten kullandınız.');
      return ctx.scene.leave();
    }

    const refCodeFindedUser = await User.findOne({
      refCode: code,
      telegramId: { $ne: telegramId } // kendi kodu hariç
    });

    if (!refCodeFindedUser) {
      await ctx.reply('❌ Referans kodu bulunamadı.');
      return ctx.scene.leave();
    }

    // Başarılı
    user.credits += 10;
    user.isUsedRefCode = true;
    await user.save();

    refCodeFindedUser.credits += 10; // referans veren kişi de ödül alabilir
    await refCodeFindedUser.save();

    await ctx.reply(`💰 Tebrikler! 10 kredi hesabınıza eklendi.\n🔹 Mevcut krediniz: ${user.credits}`);
    return ctx.scene.leave();
  }
);


// Referans kodu sahnesi tanımlandıktan sonra:
const stage = new Scenes.Stage([contactDataWizard]);

// 🔧 Bu iki satırı ekle:
const { session } = require("telegraf");
const Parser = require("rss-parser");
bot.use(session());


// Sahne middleware'i
bot.use(stage.middleware());



// Callback query (butonlar)
bot.on("callback_query", async (ctx) => {
  const telegramId = String(ctx.from.id);
  const action = ctx.callbackQuery.data;
  const user = await User.findOne({ telegramId });

  if (!user) return;

  switch (action) {
    case "fal_baktır":
      if (user.credits <= 0) {
        await ctx.answerCbQuery("Kredi yok. Lütfen /odeme ile kredi alın.", { show_alert: true });
      } else {
        await ctx.answerCbQuery();
        await ctx.reply(`📸 Fincan fotoğrafını buraya gönderebilirsiniz.\nKalan krediniz: ${user.credits} 🪙`);
      }
      break;

    case "burc_yorumu":
      await ctx.answerCbQuery();
      await ctx.reply(
        'Hangi Burç için yorum almak istersin?',
        Markup.inlineKeyboard([
          [Markup.button.callback("♈ Koç (Aries)", "koc")],
          [Markup.button.callback("♉ Boğa (Taurus)", "boga")],
          [Markup.button.callback("♊ İkizler (Gemini)", "ikizler")],
          [Markup.button.callback("♋ Yengeç (Cancer)", "yengec")],
          [Markup.button.callback("♌ Aslan (Leo)", "aslan")],
          [Markup.button.callback("♍ Başak (Virgo)", "basak")],
          [Markup.button.callback("♎ Terazi (Libra)", "terazi")],
          [Markup.button.callback("♏ Akrep (Scorpio)", "akrep")],
          [Markup.button.callback("♐ Yay (Sagittarius)", "yay")],
          [Markup.button.callback("♑ Oğlak (Capricorn)", "oglak")],
          [Markup.button.callback("♒ Kova (Aquarius)", "kova")],
          [Markup.button.callback("♓ Balık (Pisces)", "balik")]
        ])
      );
      break;

    case "koc":
    case "boga":
    case "ikizler":
    case "yengec":
    case "aslan":
    case "basak":
    case "terazi":
    case "akrep":
    case "yay":
    case "oglak":
    case "kova":
    case "balik":
      burcYorumla(action, ctx);
      break;

    case "odeme_yap":
      await ctx.answerCbQuery();
      await ctx.reply(
        'Kaç kredi satın almak istersin?',
        Markup.inlineKeyboard([
          [Markup.button.callback("🪙 10 Kredi 🪙", "10_kredi")],
          [Markup.button.callback("🪙 50 Kredi 🪙", "50_kredi")],
          [Markup.button.callback("🪙 100 Kredi 🪙", "100_kredi")],
          [Markup.button.callback("🪙 1000 Kredi 🪙", "1000_kredi")]
        ])
      );
      break;

    case "kredi_durumu":
      await ctx.answerCbQuery();
      await ctx.reply(`💰 Kredi durumun: ${user.credits}`);
      break;

    case "10_kredi":
    case "50_kredi":
    case "100_kredi":
    case "1000_kredi":
      const amount = parseInt(action.split("_")[0]);
      await ctx.replyWithInvoice({
        title: "TelveciAI Kredisi",
        description: `${amount} kredi satın almak için ödeme yapın.`,
        payload: action,
        currency: "XTR",
        prices: [{ label: `${amount} kredi`, amount }],
        start_parameter: "telveci_ai_kredi"
      });
      break;

    case "use_ref_code":
      await ctx.answerCbQuery();
      await ctx.scene.enter('REFERANCE_SCENE');
      break;

    case "hediye_kredi_davet":
      let userRefCode = user.refCode;

      if (!userRefCode || userRefCode === '') {
        userRefCode = `${user.username}_${Math.floor(Math.random() * 10000)}`;
        user.refCode = userRefCode;
        await user.save();
      }

      await ctx.reply(`Arkadaşınızı davet ederek 10 kredi kazanabilirsiniz.`);
      await ctx.reply(`🎟 Referans Kodunuz: ${userRefCode}`);
      await ctx.answerCbQuery();
      break;


    case "hediye_kredi":
      const channelUsername = "@telveciai";
      try {
        const member = await ctx.telegram.getChatMember(channelUsername, telegramId);
        if (["member", "administrator", "creator"].includes(member.status)) {
          if (!user.isFollowChannel) {
            user.credits += 10;
            user.isFollowChannel = true;
            await user.save();
            await ctx.answerCbQuery("🎁 10 kredi eklendi!", { show_alert: true });
          } else {
            await ctx.answerCbQuery("Bu ödülü zaten almışsınız.", { show_alert: true });
          }
        } else {
          await ctx.editMessageText(
            "⚠ Kanalı takip etmeniz gerekiyor! Katılın ve 'Katıldım!' butonuna basın.",
            Markup.inlineKeyboard([
              [Markup.button.url("Kanala Katıl", "https://t.me/telveciai")],
              [Markup.button.callback("Katıldım!", "check_membership")]
            ])
          );
        }
      } catch (err) {
        console.log(err);
        await ctx.answerCbQuery("⚠ Kanal kontrol edilirken hata oluştu.", { show_alert: true });
      }
      break;



    case "check_membership":
      try {
        const member = await ctx.telegram.getChatMember("@telveciai", telegramId);
        if (["member", "administrator", "creator"].includes(member.status)) {
          if (!user.isFollowChannel) {
            user.credits += 10;
            user.isFollowChannel = true;
            await user.save();
            await ctx.answerCbQuery("🎁 10 kredi eklendi!", { show_alert: true });
          } else {
            await ctx.answerCbQuery("Bu ödülü zaten almışsınız.", { show_alert: true });
          }
        } else {
          await ctx.answerCbQuery("⚠ Kanalı hala takip etmiyorsunuz.", { show_alert: true });
        }
      } catch (err) {
        console.log(err);
        await ctx.answerCbQuery("⚠ Kanal kontrol edilirken hata oluştu.", { show_alert: true });
      }
      break;
  }
});

// Pre-checkout ve başarılı ödeme
bot.on("pre_checkout_query", async (ctx) => {
  await ctx.answerPreCheckoutQuery(true);
});

bot.on("successful_payment", async (ctx) => {
  const telegramId = String(ctx.from.id);
  let user = await User.findOne({ telegramId });

  if (!user) {
    user = await User.create({ telegramId, credits: 0, isFollowChannel: false });
  }

  const amountMap = { "10_kredi": 10, "50_kredi": 50, "100_kredi": 100, "1000_kredi": 1000 };
  const creditsToAdd = amountMap[ctx.message.successful_payment.invoice_payload] || 0;

  user.credits += creditsToAdd;
  await user.save();

  await ctx.reply(`💰 Ödeme alındı! ${creditsToAdd} kredi hesabına eklendi.`);
});

// Bot başlat
const startBot = () => {
  bot.launch();
  // botBalyoz.launch();
  // fetchAndPostNews(); // hemen bir kez gönder
  // setInterval(fetchAndPostNews, 60 * 60 * 1000); // 60 dakikada bir tekrar
  console.log("🚀 BotBalyoz Kapatıldı...");
  console.log("🚀 TelveciAI botu çalışıyor...");
};

module.exports = { bot, startBot };
