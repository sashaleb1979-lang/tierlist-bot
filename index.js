require("dotenv").config();
const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const { PassThrough } = require("stream");
let PImage = null;
try { PImage = require("pureimage"); } catch {}

const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  AttachmentBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  PermissionsBitField,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  SlashCommandBuilder,
} = require("discord.js");

// ====== НАСТРОЙКИ ======
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;

const GUILD_ID = process.env.GUILD_ID;
const SUBMIT_CHANNEL_ID = process.env.SUBMIT_CHANNEL_ID;
const REVIEW_CHANNEL_ID = process.env.REVIEW_CHANNEL_ID;
const TIERLIST_CHANNEL_ID = process.env.TIERLIST_CHANNEL_ID;
const MOD_ROLE_ID = process.env.MOD_ROLE_ID;
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID || "";
const GRAPHIC_TIERLIST_CHANNEL_ID = process.env.GRAPHIC_TIERLIST_CHANNEL_ID || "";
const GRAPHIC_TIERLIST_TITLE = process.env.GRAPHIC_TIERLIST_TITLE || "ELO Tier List";

const SUBMIT_COOLDOWN_SECONDS = 120; // кулдаун на ВАЛИДНУЮ заявку
const PENDING_EXPIRE_HOURS = 48;     // протухание pending

// TODO: ВПИШИ СВОИ НАЗВАНИЯ ТИРОВ ТУТ (пока цифры)
// (можно менять через /elo labels тоже)
const DEFAULT_TIER_LABELS = { 1: "1", 2: "2", 3: "3", 4: "4", 5: "5" };

// ====== DB (файл) ======
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "db.json");

function loadDB() {
  if (!fs.existsSync(DB_PATH)) {
    return { config: {}, submissions: {}, ratings: {}, cooldowns: {}, miniCards: {} };
  }
  try {
    const data = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
    data.config ||= {};
    data.submissions ||= {};
    data.ratings ||= {};
    data.cooldowns ||= {};
    data.miniCards ||= {};
    return data;
  } catch {
    return { config: {}, submissions: {}, ratings: {}, cooldowns: {}, miniCards: {} };
  }
}

function saveDB(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), "utf8");
}

const db = loadDB();
db.config.tierLabels ||= DEFAULT_TIER_LABELS;
db.miniCards ||= {};
db.config.graphicTierlist ||= {
  title: GRAPHIC_TIERLIST_TITLE,
  dashboardChannelId: GRAPHIC_TIERLIST_CHANNEL_ID || "",
  dashboardMessageId: "",
  lastUpdated: 0,
  image: { width: null, height: null, icon: null },
  tierColors: {
    5: "#ff6b6b",
    4: "#ff9f43",
    3: "#feca57",
    2: "#1dd1a1",
    1: "#54a0ff"
  },
  panel: {
    selectedTier: 5
  }
};
db.config.graphicTierlist.image ||= { width: null, height: null, icon: null };
db.config.graphicTierlist.tierColors ||= { 5: "#ff6b6b", 4: "#ff9f43", 3: "#feca57", 2: "#1dd1a1", 1: "#54a0ff" };
db.config.graphicTierlist.panel ||= { selectedTier: 5 };
if (!db.config.graphicTierlist.title) db.config.graphicTierlist.title = GRAPHIC_TIERLIST_TITLE;
if (!db.config.graphicTierlist.dashboardChannelId && GRAPHIC_TIERLIST_CHANNEL_ID) db.config.graphicTierlist.dashboardChannelId = GRAPHIC_TIERLIST_CHANNEL_ID;
saveDB(db);

// ====== HELPERS ======
function makeId() {
  return (Date.now().toString(36) + Math.random().toString(36).slice(2, 10)).toUpperCase();
}

function parseElo(text) {
  if (!text) return null;
  const m = text.match(/(\d{1,4})\+?/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function isImageAttachment(att) {
  if (!att) return false;
  const ct = att.contentType || "";
  if (ct.startsWith("image/")) return true;
  const url = (att.url || "").toLowerCase();
  return url.endsWith(".png") || url.endsWith(".jpg") || url.endsWith(".jpeg") || url.endsWith(".webp") || url.endsWith(".gif");
}

// Тиры "ОТ": 15 / 35 / 60 / 90 / 120 (ниже 15 — невалидно)
function tierFor(elo) {
  if (elo >= 120) return 5;
  if (elo >= 90) return 4;
  if (elo >= 60) return 3;
  if (elo >= 35) return 2;
  if (elo >= 15) return 1;
  return null;
}

function formatTierTitle(t) {
  const labels = db.config.tierLabels || DEFAULT_TIER_LABELS;
  // В тир-листе не добавляем префикс "Тир" перед кастомным названием.
  return `${labels[t] ?? t}`;
}

function sanitizeFileName(name, fallbackExt = "png") {
  const base = (name || "")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);

  if (!base) return `screenshot.${fallbackExt}`;
  // Если нет расширения — добавим.
  if (!/\.[a-z0-9]{2,5}$/i.test(base)) return `${base}.${fallbackExt}`;
  return base;
}

async function downloadToBuffer(url, timeoutMs = 15000) {
  // 1) Node 18+: используем fetch
  if (typeof fetch === "function") {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const ab = await res.arrayBuffer();
      return Buffer.from(ab);
    } finally {
      clearTimeout(t);
    }
  }

  // 2) Fallback (Node 16/17): качаем через http/https
  return await new Promise((resolve, reject) => {
    const lib = url.startsWith("https:") ? https : http;
    const req = lib.get(url, (res) => {
      // редиректы
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        downloadToBuffer(res.headers.location, timeoutMs).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }

      const chunks = [];
      res.on("data", (d) => chunks.push(d));
      res.on("end", () => resolve(Buffer.concat(chunks)));
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error("timeout"));
    });
  });
}

function isModerator(member) {
  if (!member) return false;
  if (member.permissions.has(PermissionsBitField.Flags.Administrator)) return true;
  if (MOD_ROLE_ID && member.roles?.cache?.has(MOD_ROLE_ID)) return true;
  return false;
}

// ====== ROLES: PER-TIER (RANK) ======
// Раньше выдавалась одна роль "участник тир-листа" (TIERLIST_ROLE_ID).
// Теперь: за КАЖДЫЙ тир/ранг выдаётся своя роль, и бот держит ровно одну из них.
// Настройка через .env (любые можно оставить пустыми — тогда роли не трогаем):
// TIER_ROLE_1_ID, TIER_ROLE_2_ID, TIER_ROLE_3_ID, TIER_ROLE_4_ID, TIER_ROLE_5_ID
const TIER_ROLE_IDS = {
  1: process.env.TIER_ROLE_1_ID || "",
  2: process.env.TIER_ROLE_2_ID || "",
  3: process.env.TIER_ROLE_3_ID || "",
  4: process.env.TIER_ROLE_4_ID || "",
  5: process.env.TIER_ROLE_5_ID || "",
};

let _guildCache = null;

async function getGuild(client) {
  if (_guildCache) return _guildCache;
  if (!GUILD_ID) return null;
  _guildCache = await client.guilds.fetch(GUILD_ID).catch(() => null);
  return _guildCache;
}

function allTierRoleIds() {
  return Object.values(TIER_ROLE_IDS).filter(Boolean);
}

async function ensureSingleTierRole(client, userId, targetTier, reason = "tier role sync") {
  const targetRoleId = TIER_ROLE_IDS[targetTier] || "";
  const all = allTierRoleIds();

  // если роли не настроены — ничего не делаем
  if (!all.length) return;

  const guild = await getGuild(client);
  if (!guild) return;

  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) return;

  // 1) снять все "не те" тир-роли
  const toRemove = all.filter(rid => rid !== targetRoleId && member.roles.cache.has(rid));
  for (const rid of toRemove) {
    await member.roles.remove(rid, reason).catch(() => {});
  }

  // 2) надеть нужную (если она задана)
  if (targetRoleId && !member.roles.cache.has(targetRoleId)) {
    await member.roles.add(targetRoleId, reason).catch(() => {});
  }
}

async function clearAllTierRoles(client, userId, reason = "tier role clear") {
  const all = allTierRoleIds();
  if (!all.length) return;

  const guild = await getGuild(client);
  if (!guild) return;

  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) return;

  for (const rid of all) {
    if (member.roles.cache.has(rid)) {
      await member.roles.remove(rid, reason).catch(() => {});
    }
  }
}

async function syncTierRolesOnStart(client) {
  const ids = Object.keys(db.ratings || {});
  if (!ids.length) return;

  for (const uid of ids) {
    const r = db.ratings[uid];
    if (!r?.tier) continue;
    await ensureSingleTierRole(client, uid, Number(r.tier), "sync from db");
  }
}

// ====== GRAPHIC TIERLIST (PNG DASHBOARD) ======
const GRAPHIC_TIER_ORDER = [5, 4, 3, 2, 1];
const DEFAULT_GRAPHIC_TIER_COLORS = {
  5: "#ff6b6b",
  4: "#ff9f43",
  3: "#feca57",
  2: "#1dd1a1",
  1: "#54a0ff"
};
let graphicFontsReady = false;
let GRAPHIC_FONT_REG = "GraphicFontRegular";
let GRAPHIC_FONT_BOLD = "GraphicFontBold";
let GRAPHIC_FONT_INFO = { regularFile: null, boldFile: null, usedFallback: false };
const graphicAvatarCache = new Map();

function getGraphicTierlistState() {
  db.config.graphicTierlist ||= {
    title: GRAPHIC_TIERLIST_TITLE,
    dashboardChannelId: GRAPHIC_TIERLIST_CHANNEL_ID || "",
    dashboardMessageId: "",
    lastUpdated: 0,
    image: { width: null, height: null, icon: null },
    tierColors: { ...DEFAULT_GRAPHIC_TIER_COLORS },
    panel: {
      selectedTier: 5
    }
  };
  db.config.graphicTierlist.image ||= { width: null, height: null, icon: null };
  db.config.graphicTierlist.tierColors ||= { ...DEFAULT_GRAPHIC_TIER_COLORS };
  db.config.graphicTierlist.panel ||= { selectedTier: 5 };
  if (!db.config.graphicTierlist.title) db.config.graphicTierlist.title = GRAPHIC_TIERLIST_TITLE;
  if (!db.config.graphicTierlist.dashboardChannelId && GRAPHIC_TIERLIST_CHANNEL_ID) {
    db.config.graphicTierlist.dashboardChannelId = GRAPHIC_TIERLIST_CHANNEL_ID;
  }
  for (const t of GRAPHIC_TIER_ORDER) {
    if (!db.config.graphicTierlist.tierColors[t]) db.config.graphicTierlist.tierColors[t] = DEFAULT_GRAPHIC_TIER_COLORS[t];
  }
  return db.config.graphicTierlist;
}

function getGraphicImageConfig() {
  const state = getGraphicTierlistState();
  const cfg = state.image || {};
  const w = Number(cfg.width) || 2000;
  const h = Number(cfg.height) || 1200;
  const icon = Number(cfg.icon) || 112;
  return {
    W: Math.max(1200, w),
    H: Math.max(700, h),
    ICON: Math.max(64, icon)
  };
}

function applyGraphicImageDelta(kind, delta) {
  const state = getGraphicTierlistState();
  state.image ||= { width: null, height: null, icon: null };
  const cfg = getGraphicImageConfig();

  if (kind === "icon") {
    state.image.icon = Math.max(64, Math.min(256, cfg.ICON + delta));
  } else if (kind === "width") {
    state.image.width = Math.max(1200, Math.min(4096, cfg.W + delta));
  } else if (kind === "height") {
    state.image.height = Math.max(700, Math.min(2160, cfg.H + delta));
  }
}

function resetGraphicImageOverrides() {
  const state = getGraphicTierlistState();
  state.image ||= { width: null, height: null, icon: null };
  state.image.width = null;
  state.image.height = null;
  state.image.icon = null;
}

function normalizeDiscordAvatarUrl(url) {
  if (!url) return "";
  try {
    const u = new URL(url);
    const file = u.pathname || "";
    u.pathname = file.replace(/\.(webp|gif|jpg|jpeg)$/i, ".png");
    u.searchParams.set("size", "256");
    return u.toString();
  } catch {
    return String(url).replace(/\.(webp|gif|jpg|jpeg)(\?.*)?$/i, ".png$2");
  }
}

function normalizeHexColor(input) {
  const raw = String(input || "").trim();
  if (!raw) return null;
  const m = raw.match(/^#?([0-9a-fA-F]{6})$/);
  if (!m) return null;
  return `#${m[1].toLowerCase()}`;
}

function setGraphicTierColor(tier, color) {
  const state = getGraphicTierlistState();
  const hex = normalizeHexColor(color);
  if (!hex) return false;
  state.tierColors ||= { ...DEFAULT_GRAPHIC_TIER_COLORS };
  state.tierColors[tier] = hex;
  return true;
}

function resetGraphicTierColor(tier) {
  const state = getGraphicTierlistState();
  state.tierColors ||= { ...DEFAULT_GRAPHIC_TIER_COLORS };
  state.tierColors[tier] = DEFAULT_GRAPHIC_TIER_COLORS[tier] || "#cccccc";
}

function resetAllGraphicTierColors() {
  const state = getGraphicTierlistState();
  state.tierColors = { ...DEFAULT_GRAPHIC_TIER_COLORS };
}

function clearGraphicAvatarCache() {
  graphicAvatarCache.clear();
}

function buildGraphicBucketsFromRatings() {
  const buckets = { 1: [], 2: [], 3: [], 4: [], 5: [] };
  const entries = Object.values(db.ratings || {});

  for (const raw of entries) {
    const tier = Number(raw?.tier);
    if (!buckets[tier]) continue;
    buckets[tier].push({
      userId: raw.userId,
      name: raw.name || raw.userId,
      elo: Number(raw.elo) || 0,
      tier,
      avatarUrl: normalizeDiscordAvatarUrl(raw.avatarUrl || "")
    });
  }

  for (const t of Object.keys(buckets)) {
    buckets[t].sort((a, b) => {
      if ((b.elo || 0) !== (a.elo || 0)) return (b.elo || 0) - (a.elo || 0);
      return String(a.name || "").localeCompare(String(b.name || ""), "ru");
    });
  }

  return buckets;
}

function listGraphicFontFiles() {
  const candidates = [
    path.join(__dirname, "assets", "fonts"),
    "/usr/share/fonts/truetype/dejavu",
    "/usr/share/fonts/truetype/liberation2",
    "/usr/share/fonts/truetype/freefont"
  ];

  const out = [];
  for (const dir of candidates) {
    try {
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir)) {
        if (f.toLowerCase().endsWith(".ttf")) out.push(path.join(dir, f));
      }
    } catch {}
  }
  return out;
}

function pickGraphicFontFiles() {
  const preferredPairs = [
    [
      path.join(__dirname, "assets", "fonts", "NotoSans-Regular.ttf"),
      path.join(__dirname, "assets", "fonts", "NotoSans-Bold.ttf")
    ],
    [
      "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
      "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
    ],
    [
      "/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf",
      "/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf"
    ],
  ];

  for (const [regularFile, boldFile] of preferredPairs) {
    if (fs.existsSync(regularFile) && fs.existsSync(boldFile)) {
      return { regularFile, boldFile, usedFallback: false };
    }
  }

  const any = listGraphicFontFiles();
  if (any.length) {
    return { regularFile: any[0], boldFile: any[0], usedFallback: true };
  }

  return { regularFile: null, boldFile: null, usedFallback: true };
}

function ensureGraphicFonts() {
  if (!PImage) return false;
  if (graphicFontsReady) return true;

  const picked = pickGraphicFontFiles();
  GRAPHIC_FONT_INFO = picked;

  try {
    if (picked.regularFile) PImage.registerFont(picked.regularFile, GRAPHIC_FONT_REG).loadSync();
    if (picked.boldFile) PImage.registerFont(picked.boldFile, GRAPHIC_FONT_BOLD).loadSync();
  } catch {}

  graphicFontsReady = true;
  return true;
}

function hexToRgb(hex) {
  const h = String(hex || "#cccccc").replace("#", "");
  const n = parseInt(h, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function fillColor(ctx, hex) {
  const { r, g, b } = hexToRgb(hex);
  ctx.fillStyle = `rgb(${r},${g},${b})`;
}

function bufferToPassThrough(buf) {
  const s = new PassThrough();
  s.end(buf);
  return s;
}

async function decodeImageFromBuffer(buf) {
  if (!PImage || !buf) return null;
  try {
    return await PImage.decodePNGFromStream(bufferToPassThrough(buf));
  } catch {}
  try {
    return await PImage.decodeJPEGFromStream(bufferToPassThrough(buf));
  } catch {}
  return null;
}

async function loadGraphicAvatar(url) {
  if (!url) return null;
  if (graphicAvatarCache.has(url)) return graphicAvatarCache.get(url);

  let img = null;
  try {
    const buf = await downloadToBuffer(url, 15000);
    img = await decodeImageFromBuffer(buf);
  } catch {}

  graphicAvatarCache.set(url, img || null);
  return img || null;
}

async function renderGraphicTierlistPng() {
  if (!PImage) throw new Error('Не найден модуль pureimage. Установи: npm i pureimage');
  ensureGraphicFonts();

  const state = getGraphicTierlistState();
  const buckets = buildGraphicBucketsFromRatings();
  const entries = Object.values(db.ratings || {});
  const { W, H: H_CFG, ICON } = getGraphicImageConfig();

  const topY = 120;
  const leftW = Math.floor(W * 0.24);
  const rightPadding = 36;
  const gap = Math.max(10, Math.floor(ICON * 0.16));
  const overlayH = Math.max(24, Math.floor(ICON * 0.24));
  const rightW = W - leftW - rightPadding - 24;
  const cols = Math.max(1, Math.floor((rightW + gap) / (ICON + gap)));

  const rowHeights = GRAPHIC_TIER_ORDER.map((tierKey) => {
    const n = (buckets[tierKey] || []).length;
    const rowsNeeded = Math.max(1, Math.ceil(n / cols));
    const iconsH = rowsNeeded * (ICON + gap) - gap;
    const needed = 18 + iconsH + 22 + 12;
    return Math.max(needed, 160);
  });

  const footerH = 44;
  const neededH = topY + rowHeights.reduce((a, b) => a + b, 0) + footerH;
  const H = Math.max(H_CFG, neededH);

  const img = PImage.make(W, H);
  const ctx = img.getContext('2d');

  fillColor(ctx, '#242424');
  ctx.fillRect(0, 0, W, H);

  fillColor(ctx, '#ffffff');
  ctx.font = `64px '${GRAPHIC_FONT_BOLD}'`;
  ctx.fillText(state.title || GRAPHIC_TIERLIST_TITLE, 40, 82);

  fillColor(ctx, '#cfcfcf');
  ctx.font = `22px '${GRAPHIC_FONT_REG}'`;
  ctx.fillText(`players: ${entries.length}. updated: ${new Date().toLocaleString('ru-RU')}`, 40, H - 18);

  let yCursor = topY;

  for (let i = 0; i < GRAPHIC_TIER_ORDER.length; i++) {
    const tierKey = GRAPHIC_TIER_ORDER[i];
    const y = yCursor;
    const rowH = rowHeights[i];
    yCursor += rowH;

    fillColor(ctx, '#2f2f2f');
    ctx.fillRect(leftW, y, W - leftW - rightPadding, rowH - 12);

    fillColor(ctx, state.tierColors?.[tierKey] || '#cccccc');
    ctx.fillRect(40, y, leftW - 40, rowH - 12);

    const blockH = rowH - 12;
    fillColor(ctx, '#111111');
    ctx.font = `56px '${GRAPHIC_FONT_BOLD}'`;
    ctx.fillText(formatTierTitle(tierKey), 40 + 70, y + Math.floor(blockH / 2) + 18);

    fillColor(ctx, '#111111');
    ctx.font = `24px '${GRAPHIC_FONT_REG}'`;
    ctx.fillText(`TIER ${tierKey}`, 40 + 70, y + blockH - 18);

    const list = buckets[tierKey] || [];
    const rightX = leftW + 24;
    const rightY = y + 18;

    for (let idx = 0; idx < list.length; idx++) {
      const player = list[idx];
      const col = idx % cols;
      const row = Math.floor(idx / cols);
      const x = rightX + col * (ICON + gap);
      const yy = rightY + row * (ICON + gap);

      const avatar = await loadGraphicAvatar(player.avatarUrl);

      fillColor(ctx, '#171717');
      ctx.fillRect(x - 3, yy - 3, ICON + 6, ICON + 6);

      if (avatar) {
        ctx.drawImage(avatar, x, yy, ICON, ICON);
      } else {
        fillColor(ctx, '#555555');
        ctx.fillRect(x, yy, ICON, ICON);
      }

      ctx.fillStyle = 'rgba(0,0,0,0.72)';
      ctx.fillRect(x, yy + ICON - overlayH, ICON, overlayH);
      ctx.fillStyle = 'rgba(255,255,255,0.96)';
      ctx.font = `24px '${GRAPHIC_FONT_BOLD}'`;
      const eloText = String(player.elo || 0);
      const tx = x + Math.max(8, Math.floor((ICON - (eloText.length * 14)) / 2));
      ctx.fillText(eloText, tx, yy + ICON - 8);
    }
  }

  const chunks = [];
  const stream = new PassThrough();
  stream.on('data', c => chunks.push(c));
  await PImage.encodePNGToStream(img, stream);
  stream.end();
  return Buffer.concat(chunks);
}

function buildGraphicDashboardComponents() {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('graphic_refresh').setLabel('Обновить PNG').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('graphic_panel').setLabel('PNG панель').setStyle(ButtonStyle.Primary)
  )];
}

async function ensureGraphicTierlistMessage(client, forcedChannelId = null) {
  const state = getGraphicTierlistState();
  const channelId = forcedChannelId || state.dashboardChannelId || GRAPHIC_TIERLIST_CHANNEL_ID;
  if (!channelId) return null;

  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased()) throw new Error('GRAPHIC_TIERLIST_CHANNEL_ID: не текстовый канал');

  let msg = null;
  if (state.dashboardMessageId) {
    try { msg = await channel.messages.fetch(state.dashboardMessageId); } catch {}
  }

  const png = await renderGraphicTierlistPng();
  const attachment = new AttachmentBuilder(png, { name: 'elo-tierlist.png' });
  const embed = new EmbedBuilder()
    .setTitle(state.title || GRAPHIC_TIERLIST_TITLE)
    .setDescription('Отдельный графический тир-лист ELO. Основной embed-индекс остаётся без изменений.')
    .setImage('attachment://elo-tierlist.png');

  if (!msg) {
    msg = await channel.send({ embeds: [embed], files: [attachment], components: buildGraphicDashboardComponents() });
    try { await msg.pin(); } catch {}
    state.dashboardMessageId = msg.id;
  } else {
    await msg.edit({ embeds: [embed], files: [attachment], components: buildGraphicDashboardComponents(), attachments: [] });
  }

  state.dashboardChannelId = channelId;
  state.lastUpdated = Date.now();
  saveDB(db);
  return msg;
}

async function refreshGraphicTierlist(client) {
  const state = getGraphicTierlistState();
  if (!state.dashboardChannelId || !state.dashboardMessageId) {
    if (GRAPHIC_TIERLIST_CHANNEL_ID) {
      await ensureGraphicTierlistMessage(client, GRAPHIC_TIERLIST_CHANNEL_ID);
      return true;
    }
    return false;
  }

  const channel = await client.channels.fetch(state.dashboardChannelId).catch(() => null);
  if (!channel?.isTextBased()) return false;

  let msg = null;
  try { msg = await channel.messages.fetch(state.dashboardMessageId); } catch {}
  if (!msg) {
    await ensureGraphicTierlistMessage(client, state.dashboardChannelId);
    return true;
  }

  const png = await renderGraphicTierlistPng();
  const attachment = new AttachmentBuilder(png, { name: 'elo-tierlist.png' });
  const embed = new EmbedBuilder()
    .setTitle(state.title || GRAPHIC_TIERLIST_TITLE)
    .setDescription('Отдельный графический тир-лист ELO. Основной embed-индекс остаётся без изменений.')
    .setImage('attachment://elo-tierlist.png');

  await msg.edit({ embeds: [embed], files: [attachment], components: buildGraphicDashboardComponents(), attachments: [] });
  state.lastUpdated = Date.now();
  saveDB(db);
  return true;
}

function buildGraphicPanelTierSelect() {
  const graphic = getGraphicTierlistState();
  const selected = Number(graphic.panel?.selectedTier) || 5;
  const menu = new StringSelectMenuBuilder()
    .setCustomId('graphic_panel_select_tier')
    .setPlaceholder('Выбери тир для будущей настройки')
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      GRAPHIC_TIER_ORDER.map((t) => ({ label: `Tier ${t}`, value: String(t), default: selected === t }))
    );
  return new ActionRowBuilder().addComponents(menu);
}

function buildGraphicPanelPayload() {
  const graphic = getGraphicTierlistState();
  const cfg = getGraphicImageConfig();
  const selectedTier = Number(graphic.panel?.selectedTier) || 5;
  const tierLabel = formatTierTitle(selectedTier);
  const tierColor = graphic.tierColors?.[selectedTier] || DEFAULT_GRAPHIC_TIER_COLORS[selectedTier] || "#cccccc";

  const e = new EmbedBuilder()
    .setTitle('PNG Panel')
    .setDescription([
      `**Title:** ${graphic.title || GRAPHIC_TIERLIST_TITLE}`,
      `**Канал:** ${graphic.dashboardChannelId ? `<#${graphic.dashboardChannelId}>` : 'не задан'}`,
      `**Message ID:** ${graphic.dashboardMessageId || '—'}`,
      `**Картинка:** ${cfg.W}×${cfg.H}`,
      `**Иконки:** ${cfg.ICON}px`,
      `**Выбранный тир:** ${selectedTier} → **${tierLabel}**`,
      `**Цвет тира:** ${tierColor}`,
      '',
      'Панель меняет только PNG-контур и связанные подписи и цвета. Основной embed-индекс продолжает жить отдельно.'
    ].join('\n'));

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('graphic_panel_refresh').setLabel('Пересобрать').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('graphic_panel_title').setLabel('Название PNG').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('graphic_panel_rename').setLabel('Переименовать тир').setStyle(ButtonStyle.Primary)
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('graphic_panel_icon_minus').setLabel('Иконки -').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('graphic_panel_icon_plus').setLabel('Иконки +').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('graphic_panel_w_minus').setLabel('Ширина -').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('graphic_panel_w_plus').setLabel('Ширина +').setStyle(ButtonStyle.Secondary)
  );

  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('graphic_panel_h_minus').setLabel('Высота -').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('graphic_panel_h_plus').setLabel('Высота +').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('graphic_panel_set_color').setLabel('Цвет тира').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('graphic_panel_reset_color').setLabel('Сброс цвета тира').setStyle(ButtonStyle.Secondary)
  );

  const row4 = buildGraphicPanelTierSelect();

  const row5 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('graphic_panel_reset_img').setLabel('Сбросить размеры').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('graphic_panel_reset_colors').setLabel('Сбросить все цвета').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('graphic_panel_clear_cache').setLabel('Сбросить кэш ав').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('graphic_panel_fonts').setLabel('Шрифты').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('graphic_panel_close').setLabel('Закрыть').setStyle(ButtonStyle.Danger)
  );

  return { embeds: [e], components: [row1, row2, row3, row4, row5] };
}

function hoursSince(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 999999;
  return (Date.now() - t) / 36e5;
}

async function logLine(client, text) {
  if (!LOG_CHANNEL_ID) return;
  const ch = await client.channels.fetch(LOG_CHANNEL_ID).catch(() => null);
  if (ch?.isTextBased()) await ch.send(text).catch(() => {});
}

async function dmUser(client, userId, text) {
  try {
    const user = await client.users.fetch(userId);
    await user.send(text);
  } catch {}
}

async function fetchReviewMessage(client, sub) {
  if (!sub.reviewChannelId || !sub.reviewMessageId) return null;
  const ch = await client.channels.fetch(sub.reviewChannelId).catch(() => null);
  if (!ch?.isTextBased()) return null;
  const msg = await ch.messages.fetch(sub.reviewMessageId).catch(() => null);
  return msg;
}


// ====== MINI CARDS (SUBMIT CHANNEL) ======
// Маленькие "карточки" в канале подачи (#elo-submit): кто сейчас в тир-листе.
// Требование: очень компактно, без картинок, без полей.
function buildMiniCardEmbed(rating) {
  return new EmbedBuilder()
    .setDescription(`✅ **${rating.name}** добавлен в тир-лист.`);
}

async function upsertMiniCardMessage(client, rating) {
  if (!SUBMIT_CHANNEL_ID) return { changed: false };
  const ch = await client.channels.fetch(SUBMIT_CHANNEL_ID).catch(() => null);
  if (!ch?.isTextBased()) return { changed: false };

  const embed = buildMiniCardEmbed(rating);
  const existingId = (db.miniCards || {})[rating.userId];

  if (existingId) {
    try {
      const msg = await ch.messages.fetch(existingId);
      await msg.edit({ embeds: [embed] }).catch(() => {});
      return { changed: false };
    } catch {
      // сообщение удалено/недоступно — пересоздадим
      db.miniCards[rating.userId] = "";
      saveDB(db);
    }
  }

  const msg = await ch.send({ embeds: [embed] }).catch(() => null);
  if (!msg) return { changed: false };

  // можно закреплять, чтобы "висело" (если лимит закрепов — просто проигнорит)
  try { await msg.pin(); } catch {}

  db.miniCards[rating.userId] = msg.id;
  saveDB(db);
  return { changed: true };
}

async function deleteMiniCardMessage(client, userId) {
  const msgId = (db.miniCards || {})[userId];
  if (!msgId) {
    if (db.miniCards && (userId in db.miniCards)) {
      delete db.miniCards[userId];
      saveDB(db);
    }
    return false;
  }

  const ch = await client.channels.fetch(SUBMIT_CHANNEL_ID).catch(() => null);
  if (ch?.isTextBased()) {
    const msg = await ch.messages.fetch(msgId).catch(() => null);
    if (msg) await msg.delete().catch(() => {});
  }

  delete db.miniCards[userId];
  saveDB(db);
  return true;
}

async function syncMiniCards(client) {
  db.miniCards ||= {};
  const wantIds = new Set(Object.keys(db.ratings || {}));

  let created = 0;
  let removed = 0;

  // создать/починить отсутствующие
  for (const uid of wantIds) {
    const r = db.ratings[uid];
    if (!r) continue;
    const had = Boolean(db.miniCards[uid]);
    const res = await upsertMiniCardMessage(client, r);
    if (!had && res.changed) created++;
  }

  // удалить лишние (кто уже не в тир-листе)
  for (const uid of Object.keys(db.miniCards)) {
    if (wantIds.has(uid)) continue;
    const ok = await deleteMiniCardMessage(client, uid);
    if (ok) removed++;
  }

  return { created, removed, total: wantIds.size };
}


// ====== TIERLIST INDEX ======
async function ensureIndexMessage(client) {
  const channel = await client.channels.fetch(TIERLIST_CHANNEL_ID);
  if (!channel || !channel.isTextBased()) throw new Error("TIERLIST_CHANNEL_ID: не текстовый канал");

  if (db.config.indexMessageId) {
    try {
      const msg = await channel.messages.fetch(db.config.indexMessageId);
      if (msg) return msg;
    } catch {}
  }

  const embed = new EmbedBuilder()
    .setTitle("ТИР-СПИСОК (авто)")
    .setDescription("Пока пусто.");

  const msg = await channel.send({ embeds: [embed] });
  try { await msg.pin(); } catch {}
  db.config.indexMessageId = msg.id;
  saveDB(db);
  return msg;
}

function buildIndexEmbed() {
  const entries = Object.values(db.ratings);
  const tiers = { 1: [], 2: [], 3: [], 4: [], 5: [] };

  for (const r of entries) {
    const t = Number(r.tier);
    if (tiers[t]) tiers[t].push(r);
  }

  for (const t of Object.keys(tiers)) {
    tiers[t].sort((a, b) => (b.elo || 0) - (a.elo || 0));
  }

  const embed = new EmbedBuilder()
    .setTitle("ТИР-СПИСОК (авто)")
    .setFooter({ text: "Подача: #elo-submit • Проверка: #elo-review" });

  for (const t of [5, 4, 3, 2, 1]) {
    const list = tiers[t];
    if (!list.length) {
      embed.addFields({ name: formatTierTitle(t), value: "—", inline: false });
      continue;
    }
    const lines = list.slice(0, 50).map((r, i) => `${i + 1}. <@${r.userId}> (${r.name}) — **${r.elo}**`);
    embed.addFields({ name: formatTierTitle(t), value: lines.join("\n"), inline: false });
  }

  return embed;
}

async function updateIndex(client) {
  const indexMsg = await ensureIndexMessage(client);
  await indexMsg.edit({ embeds: [buildIndexEmbed()] });
}

async function upsertCardMessage(client, rating, approvedByTag) {
  const channel = await client.channels.fetch(TIERLIST_CHANNEL_ID);
  if (!channel || !channel.isTextBased()) return;

  const embed = new EmbedBuilder()
    .setAuthor({
      name: `${rating.name} • ${formatTierTitle(rating.tier)}`,
      iconURL: rating.avatarUrl || undefined,
    })
    .setTitle(`ELO: ${rating.elo}`)
    .addFields(
      { name: "Тир", value: `**${rating.tier}**`, inline: true },
      { name: "ELO", value: `**${rating.elo}**`, inline: true },
      { name: "Пруф", value: rating.proofUrl ? `[скрин](${rating.proofUrl})` : "—", inline: true }
    )
    .setFooter({ text: `Approved by ${approvedByTag}` });

  if (rating.proofUrl) embed.setImage(rating.proofUrl);

  if (rating.cardMessageId) {
    try {
      const msg = await channel.messages.fetch(rating.cardMessageId);
      await msg.edit({ embeds: [embed] });
      return;
    } catch {
      rating.cardMessageId = "";
    }
  }

  const msg = await channel.send({ embeds: [embed] });
  rating.cardMessageId = msg.id;
}

// ====== REVIEW UI ======
function buildReviewEmbed(sub, statusLabel, extraFields = []) {
  const e = new EmbedBuilder()
    .setTitle(`ELO заявка (${statusLabel})`)
    .setDescription(
      `Игрок: <@${sub.userId}> (${sub.name})\n` +
      `ELO: **${sub.elo}**\n` +
      `Тир (по числу): **${sub.tier}**\n` +
      `Сообщение: [link](${sub.messageUrl})\n` +
      `ID: \`${sub.id}\``
    )
    // Главное: в review показываем через attachment://..., если мы перезалили файл.
    .setImage(sub.reviewImage || sub.screenshotUrl);

  if (extraFields.length) e.addFields(...extraFields);
  return e;
}

function buildReviewButtons(subId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`approve:${subId}`).setLabel("Approve").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`edit:${subId}`).setLabel("Edit ELO").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`reject:${subId}`).setLabel("Reject").setStyle(ButtonStyle.Danger)
  );
}

// ====== SLASH COMMANDS ======
function buildCommands() {
  return [
    new SlashCommandBuilder()
      .setName("elo")
      .setDescription("ELO tierlist commands")
      .addSubcommand(s => s.setName("me").setDescription("Показать мой рейтинг"))
      .addSubcommand(s => s.setName("user").setDescription("Показать рейтинг игрока")
        .addUserOption(o => o.setName("target").setDescription("Игрок").setRequired(true)))
      .addSubcommand(s => s.setName("pending").setDescription("Показать pending заявки (модеры)"))
      .addSubcommand(s => s.setName("rebuild").setDescription("Пересобрать закреп (модеры)"))
      .addSubcommand(s => s.setName("graphicsetup").setDescription("Создать/пересоздать PNG тир-лист в отдельном канале (модеры)")
        .addChannelOption(o => o.setName("channel").setDescription("Канал для PNG тир-листа").setRequired(true)))
      .addSubcommand(s => s.setName("graphicrebuild").setDescription("Пересобрать PNG тир-лист (модеры)"))
      .addSubcommand(s => s.setName("graphicstatus").setDescription("Статус PNG тир-листа (модеры)"))
      .addSubcommand(s => s.setName("graphicpanel").setDescription("Панель PNG тир-листа (модеры)"))
      .addSubcommand(s => s.setName("remove").setDescription("Удалить игрока из тир-листа (модеры)")
        .addUserOption(o => o.setName("target").setDescription("Игрок").setRequired(true)))
      .addSubcommand(s => s.setName("wipe").setDescription("Очистить рейтинг полностью (модеры)")
        .addStringOption(o => o.setName("mode").setDescription("soft=только база, hard=база+удалить карточки").setRequired(true)
          .addChoices(
            { name: "soft", value: "soft" },
            { name: "hard", value: "hard" }
          ))
        .addStringOption(o => o.setName("confirm").setDescription('Напиши WIPE чтобы подтвердить').setRequired(true)))
      .addSubcommand(s => s.setName("labels").setDescription("Поменять названия тиров (модеры)")
        .addStringOption(o => o.setName("t1").setDescription("Название тира 1").setRequired(true))
        .addStringOption(o => o.setName("t2").setDescription("Название тира 2").setRequired(true))
        .addStringOption(o => o.setName("t3").setDescription("Название тира 3").setRequired(true))
        .addStringOption(o => o.setName("t4").setDescription("Название тира 4").setRequired(true))
        .addStringOption(o => o.setName("t5").setDescription("Название тира 5").setRequired(true)))
      .addSubcommand(s => s.setName("minicards").setDescription("Пересоздать мини-карточки в submit (модеры)"))
  ].map(c => c.toJSON());
}

async function registerGuildCommands(client) {
  if (!GUILD_ID) throw new Error("Нет GUILD_ID в .env");
  const guild = await client.guilds.fetch(GUILD_ID);
  await guild.commands.set(buildCommands());
}

// ====== DISCORD CLIENT ======
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
});

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  // рег слэш-команд (guild, применяются быстро)
  await registerGuildCommands(client);

  await ensureIndexMessage(client);
  await updateIndex(client);
  await syncTierRolesOnStart(client);
  await syncMiniCards(client);
  try {
    const graphic = getGraphicTierlistState();
    if (graphic.dashboardChannelId || GRAPHIC_TIERLIST_CHANNEL_ID) {
      await ensureGraphicTierlistMessage(client, graphic.dashboardChannelId || GRAPHIC_TIERLIST_CHANNEL_ID);
    }
  } catch (e) {
    console.error("Graphic tierlist setup failed:", e?.message || e);
  }

  console.log("Ready");
});

// ====== SUBMIT CHANNEL ONLY ======
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (message.channelId !== SUBMIT_CHANNEL_ID) return;

  const elo = parseElo(message.content);
  const attachment = message.attachments.first();
  const tier = elo ? tierFor(elo) : null;

  // невалидно -> удалить и не отправлять
  if (!attachment || !isImageAttachment(attachment) || !elo || !tier) {
    const warn = await message.reply("Невалидно. Нужен **скрин (картинка)** и **ELO числом от 15**. Пример: `73`");
    setTimeout(() => warn.delete().catch(() => {}), 8000);
    message.delete().catch(() => {});
    return;
  }

  // дубликат ELO -> не принимать
  const current = db.ratings[message.author.id];
  if (current && Number(current.elo) === Number(elo)) {
    const warn = await message.reply("У тебя уже стоит **такой же ELO** в тир-листе. Если изменится — присылай новый скрин.");
    setTimeout(() => warn.delete().catch(() => {}), 8000);
    message.delete().catch(() => {});
    return;
  }

  // pending уже есть
  const hasPending = Object.values(db.submissions).some(
    (s) => s.userId === message.author.id && s.status === "pending"
  );
  if (hasPending) {
    const warn = await message.reply("У тебя уже есть заявка на проверке. Дождись решения модера.");
    setTimeout(() => warn.delete().catch(() => {}), 8000);
    message.delete().catch(() => {});
    return;
  }

  // кулдаун только на валидные
  const now = Date.now();
  const last = db.cooldowns[message.author.id] || 0;
  const left = SUBMIT_COOLDOWN_SECONDS - Math.floor((now - last) / 1000);
  if (left > 0) {
    const warn = await message.reply(`Кулдаун. Подожди ${left} сек и попробуй снова.`);
    setTimeout(() => warn.delete().catch(() => {}), 8000);
    message.delete().catch(() => {});
    return;
  }

  const submissionId = makeId();

  // Перезаливаем скрин в review, чтобы картинка стабильно открывалась
  // (не зависит от временных ссылок и удаления исходного сообщения).
  let reviewFile = null;
  let reviewImage = attachment.url;
  let reviewFileName = null;
  try {
    const buf = await downloadToBuffer(attachment.url);
    reviewFileName = sanitizeFileName(`${submissionId}_${attachment.name || "screenshot"}`);
    reviewFile = new AttachmentBuilder(buf, { name: reviewFileName });
    reviewImage = `attachment://${reviewFileName}`;
  } catch {
    // fallback: оставляем URL как есть (лучше чем ничего)
    reviewFile = null;
    reviewImage = attachment.url;
    reviewFileName = null;
  }
  db.submissions[submissionId] = {
    id: submissionId,
    userId: message.author.id,
    name: message.member?.displayName || message.author.username,
    elo,
    tier,
    screenshotUrl: attachment.url,
    reviewImage,
    reviewFileName,
    messageUrl: message.url,
    status: "pending",
    createdAt: new Date().toISOString(),
    reviewChannelId: null,
    reviewMessageId: null,
  };

  // кулдаун ставим после валидной заявки
  db.cooldowns[message.author.id] = Date.now();
  saveDB(db);

  const reviewChannel = await client.channels.fetch(REVIEW_CHANNEL_ID).catch(() => null);
  if (!reviewChannel || !reviewChannel.isTextBased()) return;

  const sub = db.submissions[submissionId];
  const payload = {
    embeds: [buildReviewEmbed(sub, "pending")],
    components: [buildReviewButtons(submissionId)],
  };
  if (reviewFile) payload.files = [reviewFile];
  const sent = await reviewChannel.send(payload);

  // сохраняем, чтобы модалки могли редактировать сообщение
  sub.reviewChannelId = sent.channel.id;
  sub.reviewMessageId = sent.id;
  saveDB(db);

  const ok = await message.reply("Заявка отправлена на проверку модерам.");
  setTimeout(() => ok.delete().catch(() => {}), 8000);

  message.delete().catch(() => {});
});

// ====== INTERACTIONS: slash + buttons + modals ======
client.on("interactionCreate", async (interaction) => {
  // ---- SLASH ----
  if (interaction.isChatInputCommand()) {
    if (interaction.commandName !== "elo") return;

    const sub = interaction.options.getSubcommand();

    // /elo me
    if (sub === "me") {
      const r = db.ratings[interaction.user.id];
      if (!r) {
        await interaction.reply({ content: "Тебя нет в тир-листе.", ephemeral: true });
        return;
      }
      await interaction.reply({
        content: `Ты: <@${r.userId}>\nELO: **${r.elo}**\nТир: **${r.tier}** (${formatTierTitle(r.tier)})`,
        ephemeral: true,
      });
      return;
    }

    // /elo user
    if (sub === "user") {
      const target = interaction.options.getUser("target", true);
      const r = db.ratings[target.id];
      if (!r) {
        await interaction.reply({ content: "Этого игрока нет в тир-листе.", ephemeral: true });
        return;
      }
      await interaction.reply({
        content: `Игрок: <@${r.userId}> (${r.name})\nELO: **${r.elo}**\nТир: **${r.tier}** (${formatTierTitle(r.tier)})`,
        ephemeral: true,
      });
      return;
    }

    // mod-only from here
    if (!isModerator(interaction.member)) {
      await interaction.reply({ content: "Нет прав.", ephemeral: true });
      return;
    }

    // /elo pending
    if (sub === "pending") {
      const pend = Object.values(db.submissions)
        .filter(s => s.status === "pending")
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
        .slice(0, 15);

      if (!pend.length) {
        await interaction.reply({ content: "Pending заявок нет.", ephemeral: true });
        return;
      }

      const lines = pend.map(s =>
        `• <@${s.userId}> ELO **${s.elo}** (id \`${s.id}\`)`
      );

      await interaction.reply({
        content: `Pending (${pend.length} из ${Object.values(db.submissions).filter(s=>s.status==="pending").length}):\n${lines.join("\n")}`,
        ephemeral: true,
      });
      return;
    }

    // /elo rebuild
    if (sub === "rebuild") {
      await updateIndex(client);
      await refreshGraphicTierlist(client).catch(() => false);
      await interaction.reply({ content: "Закреп пересобран. PNG тоже обновлён, если был настроен.", ephemeral: true });
      return;
    }

    // /elo graphicsetup
    if (sub === "graphicsetup") {
      const channel = interaction.options.getChannel("channel", true);
      const graphic = getGraphicTierlistState();
      graphic.dashboardChannelId = channel.id;
      saveDB(db);
      await ensureGraphicTierlistMessage(client, channel.id);
      await interaction.reply({ content: `PNG тир-лист создан/обновлён в <#${channel.id}>.`, ephemeral: true });
      return;
    }

    // /elo graphicrebuild
    if (sub === "graphicrebuild") {
      const ok = await refreshGraphicTierlist(client);
      await interaction.reply({ content: ok ? "PNG тир-лист обновлён." : "PNG тир-лист ещё не настроен. Сначала /elo graphicsetup.", ephemeral: true });
      return;
    }

    // /elo graphicstatus
    if (sub === "graphicstatus") {
      const graphic = getGraphicTierlistState();
      const cfg = getGraphicImageConfig();
      const lines = [
        `title: ${graphic.title || GRAPHIC_TIERLIST_TITLE}`,
        `channelId: ${graphic.dashboardChannelId || "—"}`,
        `messageId: ${graphic.dashboardMessageId || "—"}`,
        `img: ${cfg.W}x${cfg.H}, icon=${cfg.ICON}`,
        `selectedTier: ${graphic.panel?.selectedTier || 5} -> ${formatTierTitle(graphic.panel?.selectedTier || 5)}`,
        `tierColors: ${GRAPHIC_TIER_ORDER.map(t => `${t}=${graphic.tierColors?.[t] || DEFAULT_GRAPHIC_TIER_COLORS[t]}`).join(', ')}`,
        `lastUpdated: ${graphic.lastUpdated ? new Date(graphic.lastUpdated).toLocaleString("ru-RU") : "—"}`,
        `font regular: ${GRAPHIC_FONT_INFO.regularFile ? path.basename(GRAPHIC_FONT_INFO.regularFile) : "(none)"}`,
        `font bold: ${GRAPHIC_FONT_INFO.boldFile ? path.basename(GRAPHIC_FONT_INFO.boldFile) : "(none)"}`
      ];
      await interaction.reply({ content: lines.join("\n"), ephemeral: true });
      return;
    }

    // /elo graphicpanel
    if (sub === "graphicpanel") {
      await interaction.reply({ ...buildGraphicPanelPayload(), ephemeral: true });
      return;
    }

    // /elo minicards
    if (sub === "minicards") {
      const res = await syncMiniCards(client);
      await interaction.reply({
        content: `Мини-карточки: создано ${res.created}, удалено ${res.removed}, всего в тир-листе ${res.total}.`,
        ephemeral: true,
      });
      return;
    }


    // /elo labels
    if (sub === "labels") {
      db.config.tierLabels = {
        1: interaction.options.getString("t1", true),
        2: interaction.options.getString("t2", true),
        3: interaction.options.getString("t3", true),
        4: interaction.options.getString("t4", true),
        5: interaction.options.getString("t5", true),
      };
      saveDB(db);
      await updateIndex(client);
      await refreshGraphicTierlist(client).catch(() => false);
      await interaction.reply({ content: "Названия тиров обновлены. PNG тоже обновлён, если был настроен.", ephemeral: true });
      return;
    }

    // /elo remove
    if (sub === "remove") {
      const target = interaction.options.getUser("target", true);
      const rating = db.ratings[target.id];

      if (!rating) {
        await interaction.reply({ content: "Этого игрока нет в тир-листе.", ephemeral: true });
        return;
      }

      if (rating.cardMessageId) {
        const ch = await client.channels.fetch(TIERLIST_CHANNEL_ID).catch(() => null);
        if (ch?.isTextBased()) {
          const msg = await ch.messages.fetch(rating.cardMessageId).catch(() => null);
          if (msg) await msg.delete().catch(() => {});
        }
      }

      delete db.ratings[target.id];
      saveDB(db);
      await deleteMiniCardMessage(client, target.id);
      await updateIndex(client);
      await refreshGraphicTierlist(client).catch(() => false);
      await clearAllTierRoles(client, target.id, "Removed from tierlist");

      await interaction.reply({ content: `Удалил <@${target.id}> из тир-листа. PNG тоже обновлён, если был настроен.`, ephemeral: true });
      return;
    }

    // /elo wipe
    if (sub === "wipe") {
      const mode = interaction.options.getString("mode", true);
      const confirm = interaction.options.getString("confirm", true);

      if (confirm !== "WIPE") {
        await interaction.reply({ content: 'Не подтверждено. В confirm надо написать ровно: WIPE', ephemeral: true });
        return;
      }

      if (mode === "hard") {
        const ch = await client.channels.fetch(TIERLIST_CHANNEL_ID).catch(() => null);
        if (ch?.isTextBased()) {
          for (const r of Object.values(db.ratings)) {
            if (!r.cardMessageId) continue;
            const msg = await ch.messages.fetch(r.cardMessageId).catch(() => null);
            if (msg) await msg.delete().catch(() => {});
          }
        }
      }

      const _wipeIds = Object.keys(db.ratings || {});
      for (const uid of _wipeIds) {
        await clearAllTierRoles(client, uid, "Wipe ratings");
      }

      // мини-карточки в submit должны пропасть, раз тир-лист очищен
      const _miniIds = Object.keys(db.miniCards || {});
      for (const uid of _miniIds) {
        await deleteMiniCardMessage(client, uid);
      }
      db.miniCards = {};

      db.ratings = {};
      saveDB(db);
      await updateIndex(client);
      await refreshGraphicTierlist(client).catch(() => false);

      await logLine(client, `WIPE_RATINGS (${mode}) by ${interaction.user.tag}`);
      await interaction.reply({ content: `Рейтинг очищен. mode=${mode}`, ephemeral: true });
      return;
    }

    return;
  }

  // ---- BUTTONS ----
  if (interaction.isButton()) {
    if (interaction.customId === "graphic_refresh") {
      if (!isModerator(interaction.member)) {
        await interaction.reply({ content: "Нет прав.", ephemeral: true });
        return;
      }
      await interaction.deferReply({ ephemeral: true });
      const ok = await refreshGraphicTierlist(client);
      await interaction.editReply(ok ? "PNG тир-лист обновлён." : "PNG тир-лист ещё не настроен. Сначала /elo graphicsetup.");
      return;
    }

    if (interaction.customId === "graphic_panel") {
      if (!isModerator(interaction.member)) {
        await interaction.reply({ content: "Нет прав.", ephemeral: true });
        return;
      }
      await interaction.reply({ ...buildGraphicPanelPayload(), ephemeral: true });
      return;
    }

    if (interaction.customId.startsWith("graphic_panel_")) {
      if (!isModerator(interaction.member)) {
        await interaction.reply({ content: "Нет прав.", ephemeral: true });
        return;
      }

      const graphic = getGraphicTierlistState();

      if (interaction.customId === "graphic_panel_close") {
        await interaction.update({ content: "Ок.", embeds: [], components: [] });
        return;
      }

      if (interaction.customId === "graphic_panel_fonts") {
        ensureGraphicFonts();
        const files = listGraphicFontFiles();
        const lines = [
          `ttf: ${files.length ? files.map(f => path.basename(f)).join(", ") : "(none)"}`,
          `picked regular: ${GRAPHIC_FONT_INFO.regularFile ? path.basename(GRAPHIC_FONT_INFO.regularFile) : "(null)"}`,
          `picked bold: ${GRAPHIC_FONT_INFO.boldFile ? path.basename(GRAPHIC_FONT_INFO.boldFile) : "(null)"}`,
          `fallback: ${GRAPHIC_FONT_INFO.usedFallback}`
        ];
        await interaction.reply({ content: lines.join("\n"), ephemeral: true });
        return;
      }

      if (interaction.customId === "graphic_panel_title") {
        const graphic = getGraphicTierlistState();
        const modal = new ModalBuilder()
          .setCustomId("graphic_panel_title_modal")
          .setTitle("Название PNG тир-листа");

        const input = new TextInputBuilder()
          .setCustomId("graphic_title")
          .setLabel("Название наверху картинки")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(80)
          .setValue(String(graphic.title || GRAPHIC_TIERLIST_TITLE).slice(0, 80));

        modal.addComponents(new ActionRowBuilder().addComponents(input));
        await interaction.showModal(modal);
        return;
      }

      if (interaction.customId === "graphic_panel_rename") {
        const graphic = getGraphicTierlistState();
        const tierKey = Number(graphic.panel?.selectedTier) || 5;
        const currentName = formatTierTitle(tierKey);

        const modal = new ModalBuilder()
          .setCustomId(`graphic_panel_rename_modal:${tierKey}`)
          .setTitle(`Переименовать тир ${tierKey}`);

        const input = new TextInputBuilder()
          .setCustomId("tier_name")
          .setLabel("Новое название")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(32)
          .setValue(String(currentName).slice(0, 32));

        modal.addComponents(new ActionRowBuilder().addComponents(input));
        await interaction.showModal(modal);
        return;
      }

      if (interaction.customId === "graphic_panel_set_color") {
        const graphic = getGraphicTierlistState();
        const tierKey = Number(graphic.panel?.selectedTier) || 5;
        const currentColor = graphic.tierColors?.[tierKey] || DEFAULT_GRAPHIC_TIER_COLORS[tierKey] || "#cccccc";

        const modal = new ModalBuilder()
          .setCustomId(`graphic_panel_color_modal:${tierKey}`)
          .setTitle(`Цвет тира ${tierKey}`);

        const input = new TextInputBuilder()
          .setCustomId("tier_color")
          .setLabel("HEX цвет. пример #ff6b6b")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(7)
          .setValue(String(currentColor).slice(0, 7));

        modal.addComponents(new ActionRowBuilder().addComponents(input));
        await interaction.showModal(modal);
        return;
      }

      if (interaction.customId === "graphic_panel_refresh") {
        await interaction.deferUpdate();
        await refreshGraphicTierlist(client).catch(() => false);
        await interaction.editReply(buildGraphicPanelPayload());
        return;
      }

      if (interaction.customId === "graphic_panel_icon_minus" || interaction.customId === "graphic_panel_icon_plus") {
        applyGraphicImageDelta("icon", interaction.customId.endsWith("plus") ? 12 : -12);
        saveDB(db);
        await interaction.deferUpdate();
        await refreshGraphicTierlist(client).catch(() => false);
        await interaction.editReply(buildGraphicPanelPayload());
        return;
      }

      if (interaction.customId === "graphic_panel_w_minus" || interaction.customId === "graphic_panel_w_plus") {
        applyGraphicImageDelta("width", interaction.customId.endsWith("plus") ? 200 : -200);
        saveDB(db);
        await interaction.deferUpdate();
        await refreshGraphicTierlist(client).catch(() => false);
        await interaction.editReply(buildGraphicPanelPayload());
        return;
      }

      if (interaction.customId === "graphic_panel_h_minus" || interaction.customId === "graphic_panel_h_plus") {
        applyGraphicImageDelta("height", interaction.customId.endsWith("plus") ? 120 : -120);
        saveDB(db);
        await interaction.deferUpdate();
        await refreshGraphicTierlist(client).catch(() => false);
        await interaction.editReply(buildGraphicPanelPayload());
        return;
      }

      if (interaction.customId === "graphic_panel_reset_img") {
        resetGraphicImageOverrides();
        saveDB(db);
        await interaction.deferUpdate();
        await refreshGraphicTierlist(client).catch(() => false);
        await interaction.editReply(buildGraphicPanelPayload());
        return;
      }

      if (interaction.customId === "graphic_panel_reset_color") {
        const graphic = getGraphicTierlistState();
        resetGraphicTierColor(Number(graphic.panel?.selectedTier) || 5);
        saveDB(db);
        await interaction.deferUpdate();
        await refreshGraphicTierlist(client).catch(() => false);
        await interaction.editReply(buildGraphicPanelPayload());
        return;
      }

      if (interaction.customId === "graphic_panel_reset_colors") {
        resetAllGraphicTierColors();
        saveDB(db);
        await interaction.deferUpdate();
        await refreshGraphicTierlist(client).catch(() => false);
        await interaction.editReply(buildGraphicPanelPayload());
        return;
      }

      if (interaction.customId === "graphic_panel_clear_cache") {
        clearGraphicAvatarCache();
        await interaction.reply({ content: "Кэш аватарок очищен. Следующая пересборка заново подтянет картинки.", ephemeral: true });
        return;
      }
    }

    const [action, submissionId] = interaction.customId.split(":");
    const sub = db.submissions[submissionId];

    if (!isModerator(interaction.member)) {
      await interaction.reply({ content: "Нет прав.", ephemeral: true });
      return;
    }
    if (!sub) {
      await interaction.reply({ content: "Заявка не найдена.", ephemeral: true });
      return;
    }
    if (sub.status !== "pending") {
      await interaction.reply({ content: `Уже обработано: ${sub.status}`, ephemeral: true });
      return;
    }
    if (hoursSince(sub.createdAt) > PENDING_EXPIRE_HOURS) {
      sub.status = "expired";
      saveDB(db);
      const msg = await fetchReviewMessage(client, sub);
      if (msg) await msg.edit({ embeds: [buildReviewEmbed(sub, "expired")], components: [] }).catch(() => {});
      await interaction.reply({ content: "Заявка протухла (expired).", ephemeral: true });
      return;
    }

    // Approve
    if (action === "approve") {
      const tier = tierFor(sub.elo);
      if (!tier) {
        sub.status = "rejected";
        sub.reviewedBy = interaction.user.tag;
        sub.reviewedAt = new Date().toISOString();
        sub.rejectReason = "ELO ниже 15";
        saveDB(db);

        await interaction.message.edit({
          embeds: [buildReviewEmbed(sub, "rejected", [{ name: "Причина", value: sub.rejectReason, inline: false }])],
          components: [],
        }).catch(() => {});
        await interaction.reply({ content: "ELO ниже 15. Отклонено.", ephemeral: true });
        return;
      }

      sub.tier = tier;
      sub.status = "approved";
      sub.reviewedBy = interaction.user.tag;
      sub.reviewedAt = new Date().toISOString();

      const user = await client.users.fetch(sub.userId);
      const rating = db.ratings[sub.userId] || { userId: sub.userId };

      rating.userId = sub.userId;
      rating.name = sub.name;
      rating.elo = sub.elo;
      rating.tier = tier;
      rating.proofUrl = sub.screenshotUrl;
      rating.avatarUrl = normalizeDiscordAvatarUrl(user.displayAvatarURL({ extension: "png", forceStatic: true, size: 256 }));
      rating.updatedAt = new Date().toISOString();

      db.ratings[sub.userId] = rating;
      saveDB(db);

      await upsertCardMessage(client, rating, interaction.user.tag);
      saveDB(db);
      await updateIndex(client);
      await refreshGraphicTierlist(client).catch(() => false);
      await ensureSingleTierRole(client, sub.userId, tier, "Approved tier role");
      await upsertMiniCardMessage(client, rating);

      await interaction.message.edit({ embeds: [buildReviewEmbed(sub, "approved")], components: [] }).catch(() => {});
      await interaction.reply({ content: "Одобрено. Тир-лист обновлён. PNG тоже обновлён, если был настроен.", ephemeral: true });

      await dmUser(client, sub.userId, `Одобрено.\nELO: ${sub.elo}\nТир: ${sub.tier}\nПруф: ${sub.screenshotUrl}`);
      await logLine(client, `APPROVE: <@${sub.userId}> ELO ${sub.elo} -> Tier ${sub.tier} (id ${submissionId}) by ${interaction.user.tag}`);
      saveDB(db);
      return;
    }

    // Edit ELO modal
    if (action === "edit") {
      const modal = new ModalBuilder().setCustomId(`edit_elo:${submissionId}`).setTitle("Edit ELO");
      const input = new TextInputBuilder()
        .setCustomId("elo")
        .setLabel("Новое ELO (минимум 15)")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setValue(String(sub.elo));
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      await interaction.showModal(modal);
      return;
    }

    // Reject reason modal
    if (action === "reject") {
      const modal = new ModalBuilder().setCustomId(`reject_reason:${submissionId}`).setTitle("Reject reason");
      const input = new TextInputBuilder()
        .setCustomId("reason")
        .setLabel("Причина отказа (коротко)")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      await interaction.showModal(modal);
      return;
    }
  }

  if (interaction.isStringSelectMenu()) {
    if (!isModerator(interaction.member)) {
      await interaction.reply({ content: "Нет прав.", ephemeral: true });
      return;
    }

    if (interaction.customId === "graphic_panel_select_tier") {
      const graphic = getGraphicTierlistState();
      graphic.panel.selectedTier = Number(interaction.values?.[0] || 5) || 5;
      saveDB(db);
      await interaction.update(buildGraphicPanelPayload());
      return;
    }
  }

  // ---- MODAL SUBMITS ----
  if (interaction.isModalSubmit()) {
    if (!isModerator(interaction.member)) {
      await interaction.reply({ content: "Нет прав.", ephemeral: true });
      return;
    }

    if (interaction.customId === "graphic_panel_title_modal") {
      const graphic = getGraphicTierlistState();
      const title = (interaction.fields.getTextInputValue("graphic_title") || "").trim().slice(0, 80);
      if (!title) {
        await interaction.reply({ content: "Пустое название.", ephemeral: true });
        return;
      }
      graphic.title = title;
      saveDB(db);
      await interaction.deferReply({ ephemeral: true });
      await refreshGraphicTierlist(client).catch(() => false);
      await interaction.editReply(`Ок. Теперь PNG называется: **${title}**.`);
      return;
    }

    if (interaction.customId.startsWith("graphic_panel_rename_modal:")) {
      const tierKey = Number(interaction.customId.split(":")[1] || 5) || 5;
      const name = (interaction.fields.getTextInputValue("tier_name") || "").trim().slice(0, 32);
      if (!name) {
        await interaction.reply({ content: "Пустое имя.", ephemeral: true });
        return;
      }
      db.config.tierLabels ||= { ...DEFAULT_TIER_LABELS };
      db.config.tierLabels[tierKey] = name;
      saveDB(db);
      await interaction.deferReply({ ephemeral: true });
      await updateIndex(client);
      await refreshGraphicTierlist(client).catch(() => false);
      await interaction.editReply(`Ок. Теперь **${tierKey}** называется: **${name}**.`);
      return;
    }

    if (interaction.customId.startsWith("graphic_panel_color_modal:")) {
      const tierKey = Number(interaction.customId.split(":")[1] || 5) || 5;
      const raw = interaction.fields.getTextInputValue("tier_color");
      const hex = normalizeHexColor(raw);
      if (!hex) {
        await interaction.reply({ content: "Нужен HEX цвет вида #ff6b6b", ephemeral: true });
        return;
      }
      setGraphicTierColor(tierKey, hex);
      saveDB(db);
      await interaction.deferReply({ ephemeral: true });
      await refreshGraphicTierlist(client).catch(() => false);
      await interaction.editReply(`Ок. Цвет тира **${tierKey}** теперь **${hex}**.`);
      return;
    }

    const [kind, submissionId] = interaction.customId.split(":");
    const sub = db.submissions[submissionId];

    if (!sub || sub.status !== "pending") {
      await interaction.reply({ content: "Заявка не найдена или уже обработана.", ephemeral: true });
      return;
    }

    if (hoursSince(sub.createdAt) > PENDING_EXPIRE_HOURS) {
      sub.status = "expired";
      saveDB(db);
      const msg = await fetchReviewMessage(client, sub);
      if (msg) await msg.edit({ embeds: [buildReviewEmbed(sub, "expired")], components: [] }).catch(() => {});
      await interaction.reply({ content: "Заявка протухла (expired).", ephemeral: true });
      return;
    }

    // edit_elo
    if (kind === "edit_elo") {
      const val = interaction.fields.getTextInputValue("elo");
      const newElo = parseElo(val);
      const newTier = newElo ? tierFor(newElo) : null;

      if (!newElo || !newTier) {
        await interaction.reply({ content: "Нужно число ELO минимум 15.", ephemeral: true });
        return;
      }

      sub.elo = newElo;
      sub.tier = newTier;
      saveDB(db);

      const msg = await fetchReviewMessage(client, sub);
      if (msg) {
        await msg.edit({
          embeds: [buildReviewEmbed(sub, "pending", [{ name: "Изменено", value: `ELO исправил: ${interaction.user.tag}`, inline: false }])],
          components: [buildReviewButtons(submissionId)],
        }).catch(() => {});
      }

      await interaction.reply({ content: `ELO обновлено: ${newElo} (тир ${newTier}).`, ephemeral: true });
      return;
    }

    // reject_reason
    if (kind === "reject_reason") {
      const reason = interaction.fields.getTextInputValue("reason").slice(0, 800);

      sub.status = "rejected";
      sub.reviewedBy = interaction.user.tag;
      sub.reviewedAt = new Date().toISOString();
      sub.rejectReason = reason;
      saveDB(db);

      const msg = await fetchReviewMessage(client, sub);
      if (msg) {
        await msg.edit({
          embeds: [buildReviewEmbed(sub, "rejected", [{ name: "Причина", value: reason, inline: false }])],
          components: [],
        }).catch(() => {});
      }

      await interaction.reply({ content: "Отклонено.", ephemeral: true });
      await dmUser(client, sub.userId, `Отклонено.\nПричина: ${reason}\nПруф: ${sub.screenshotUrl}`);
      await logLine(client, `REJECT: <@${sub.userId}> ELO ${sub.elo} (id ${submissionId}) by ${interaction.user.tag} | reason: ${reason}`);
      return;
    }
  }
});

client.login(DISCORD_TOKEN);