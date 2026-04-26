require("dotenv").config();
const { REST, Routes, SlashCommandBuilder } = require("discord.js");

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID;
const guildId = process.env.GUILD_ID;

if (!token || !clientId || !guildId) {
  console.error("Missing DISCORD_TOKEN / CLIENT_ID / GUILD_ID in .env");
  process.exit(1);
}

const commands = [
  new SlashCommandBuilder()
    .setName("setup")
    .setDescription("Создать/обновить закреплённый тир-лист в выбранном канале")
    .addChannelOption(opt =>
      opt.setName("channel")
        .setDescription("Канал, где будет тир-лист")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("summary")
    .setDescription("Создать/обновить summary-сообщение с персонажами по тирам")
    .addChannelOption(opt =>
      opt.setName("channel")
        .setDescription("Канал, где будет summary-сообщение")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("tiers")
    .setDescription("Управление названиями тиров (для картинки)")
    .addSubcommand(sc =>
      sc.setName("set")
        .setDescription("Поменять название одного тира")
        .addStringOption(opt =>
          opt.setName("tier")
            .setDescription("Какой тир")
            .setRequired(true)
            .addChoices(
              { name: "S", value: "S" },
              { name: "A", value: "A" },
              { name: "B", value: "B" },
              { name: "C", value: "C" },
              { name: "D", value: "D" }
            )
        )
        .addStringOption(opt =>
          opt.setName("name")
            .setDescription("Новое название (на картинке)")
            .setRequired(true)
        )
    ),

  new SlashCommandBuilder()
    .setName("rebuild")
    .setDescription("Пересобрать картинку тир-листа (mods)"),

  new SlashCommandBuilder()
    .setName("character")
    .setDescription("Управление персонажами (mods)")
    .addSubcommand(sc =>
      sc.setName("add")
        .setDescription("Добавить нового персонажа по загруженной картинке")
        .addStringOption(opt =>
          opt.setName("name")
            .setDescription("Отображаемое имя персонажа")
            .setRequired(true)
            .setMaxLength(100)
        )
        .addAttachmentOption(opt =>
          opt.setName("image")
            .setDescription("Полная картинка персонажа (PNG/JPG)")
            .setRequired(true)
        )
        .addStringOption(opt =>
          opt.setName("id")
            .setDescription("Необязательный id латиницей, например ryu")
            .setRequired(false)
            .setMaxLength(64)
        )
    ),

  new SlashCommandBuilder()
    .setName("stats")
    .setDescription("Статус бота/дашборда (mods)"),

  new SlashCommandBuilder()
    .setName("debug")
    .setDescription("Диагностика (mods)")
    .addSubcommand(sc =>
      sc.setName("fonts")
        .setDescription("Показать какие шрифты найдены/используются")
    ),

  new SlashCommandBuilder()
    .setName("image")
    .setDescription("Настройка размеров картинки (mods)")
    .addSubcommand(sc =>
      sc.setName("show")
        .setDescription("Показать текущие размеры")
    )
    .addSubcommand(sc =>
      sc.setName("set")
        .setDescription("Установить размеры (и сразу пересобрать)")
        .addIntegerOption(opt =>
          opt.setName("width")
            .setDescription("Ширина PNG (например 2000)")
            .setRequired(false)
            .setMinValue(1200)
            .setMaxValue(4096)
        )
        .addIntegerOption(opt =>
          opt.setName("height")
            .setDescription("Высота PNG (например 1200)")
            .setRequired(false)
            .setMinValue(700)
            .setMaxValue(2160)
        )
        .addIntegerOption(opt =>
          opt.setName("icon")
            .setDescription("Размер иконок (например 112)")
            .setRequired(false)
            .setMinValue(64)
            .setMaxValue(256)
        )
    ),

  new SlashCommandBuilder()
    .setName("panel")
    .setDescription("Открыть панель управления тир-листом (mods)")
].map(c => c.toJSON());

const rest = new REST({ version: "10" }).setToken(token);

(async () => {
  try {
    console.log("Deploying guild commands...");
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
    console.log("Done.");
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
})();
