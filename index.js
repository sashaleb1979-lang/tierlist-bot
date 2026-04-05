require("dotenv").config();

const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");
const { PassThrough } = require("stream");
const PImage = require("pureimage");

const {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  EmbedBuilder,
  AttachmentBuilder,
  PermissionFlagsBits,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle
} = require("discord.js");

// -------------------- ENV --------------------
const {
  DISCORD_TOKEN,
  GUILD_ID,
  DEFAULT_CHANNEL_ID,
  DASHBOARD_TITLE = "Tier List",
  COOLDOWN_HOURS = "24",
  DATA_DIR = "./data",
  ADMIN_ROLE_IDS = "",

  // Influence roles (optional)
  TIER_ROLE_1_ID = "",
  TIER_ROLE_2_ID = "",
  TIER_ROLE_3_ID = "",
  TIER_ROLE_4_ID = "",
  TIER_ROLE_5_ID = "",

  // Image tuning (defaults; can be overridden by /image set)
  IMG_WIDTH = "2000",
  IMG_HEIGHT = "1200",
  ICON_SIZE = "112"
} = process.env;

if (!DISCORD_TOKEN || !GUILD_ID) {
  console.error("Missing DISCORD_TOKEN or GUILD_ID in .env");
  process.exit(1);
}

const COOLDOWN_MS = Number(COOLDOWN_HOURS) * 60 * 60 * 1000;
const ADMIN_ROLE_SET = new Set(
  (ADMIN_ROLE_IDS || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)
);

// -------------------- INFLUENCE (ROLE-BASED) --------------------
// Users can have special tier roles that increase how strongly their personal tier-list affects the global result.
const ROLE_INFLUENCE = new Map([
  [String(TIER_ROLE_1_ID || ""), 2.0],
  [String(TIER_ROLE_2_ID || ""), 2.5],
  [String(TIER_ROLE_3_ID || ""), 3.0],
  [String(TIER_ROLE_4_ID || ""), 3.5],
  [String(TIER_ROLE_5_ID || ""), 4.0]
]);

function resolveInfluenceFromMember(member) {
  try {
    const roles = member?.roles?.cache;
    if (!roles) return { mult: 1, roleId: null };

    let best = 1;
    let bestRole = null;

    for (const [rid, mult] of ROLE_INFLUENCE.entries()) {
      if (!rid) continue;
      if (roles.has(rid) && mult > best) {
        best = mult;
        bestRole = rid;
      }
    }
    return { mult: best, roleId: bestRole };
  } catch {
    return { mult: 1, roleId: null };
  }
}

function getStoredInfluenceMultiplier(userId) {
  const u = state.users?.[userId];
  const mult = Number(u?.influenceMultiplier);
  return Number.isFinite(mult) && mult > 0 ? mult : 1;
}

async function backfillInfluenceForExistingVoters(client, { refresh = true } = {}) {
  // Updates influenceMultiplier for everyone who already has a final vote stored.
  // This makes old (already submitted) votes start using role influence without users re-submitting.
  const voterIds = Object.entries(state.finalVotes || {})
    .filter(([uid, votes]) => votes && Object.keys(votes).length > 0)
    .map(([uid]) => uid);

  if (voterIds.length === 0) return { total: 0, changed: 0 };

  const guild = await client.guilds.fetch(GUILD_ID);
  let changed = 0;

  for (const uid of voterIds) {
    const member = await guild.members.fetch(uid).catch(() => null);
    const inf = resolveInfluenceFromMember(member);

    const u = getUser(uid);
    const prev = Number(u.influenceMultiplier) || 1;

    if (prev !== inf.mult || (u.influenceRoleId || null) !== (inf.roleId || null)) {
      u.influenceMultiplier = inf.mult;
      u.influenceRoleId = inf.roleId;
      u.influenceUpdatedAt = Date.now();
      changed++;
    }
  }

  if (changed > 0) saveState(state);

  const hasDashboard = Boolean(state.settings?.channelId && state.settings?.dashboardMessageId);
  if (refresh && changed > 0 && hasDashboard) {
    await refreshDashboard(client).catch(() => {});
  }

  return { total: voterIds.length, changed };
}

// -------------------- PATHS --------------------
const CONFIG_DIR = path.join(__dirname, "config");
const ASSETS_DIR = path.join(__dirname, "assets");

const CHARACTERS_PATH = path.join(CONFIG_DIR, "characters.json");
const TIERS_DEFAULT_PATH = path.join(CONFIG_DIR, "tiers.default.json");

const STATE_DIR = path.resolve(__dirname, DATA_DIR);
const STATE_PATH = path.join(STATE_DIR, "state.json");
const CUSTOM_CHARACTERS_PATH = path.join(STATE_DIR, "characters.custom.json");
const CUSTOM_CHARACTERS_DIR = path.join(STATE_DIR, "characters");
const MAIN_SELECT_PAGE_SIZE = 25;

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}
function loadJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}
function loadJsonIfExists(p, fallback) {
  try {
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return fallback;
  }
}
function saveJsonAtomic(p, value) {
  ensureDir(path.dirname(p));
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf-8");
  fs.renameSync(tmp, p);
}
function writeBufferAtomic(p, buffer) {
  ensureDir(path.dirname(p));
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, buffer);
  fs.renameSync(tmp, p);
}

let characters = [];
let charById = new Map();
const tierDefaults = loadJson(TIERS_DEFAULT_PATH);

function readCustomCharacters() {
  const raw = loadJsonIfExists(CUSTOM_CHARACTERS_PATH, []);
  return Array.isArray(raw) ? raw : [];
}

function reloadCharacterCatalog() {
  const merged = [];
  const seen = new Set();

  for (const source of [loadJson(CHARACTERS_PATH), readCustomCharacters()]) {
    if (!Array.isArray(source)) continue;
    for (const item of source) {
      const id = String(item?.id || "").trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);

      merged.push({
        id,
        name: String(item?.name || id).trim() || id,
        enabled: item?.enabled !== false
      });
    }
  }

  characters = merged.filter(c => c.enabled);
  charById = new Map(characters.map(c => [c.id, c]));
  return characters;
}

reloadCharacterCatalog();

// -------------------- STATE --------------------
function defaultState() {
  return {
    settings: {
      guildId: GUILD_ID,
      channelId: DEFAULT_CHANNEL_ID || null,
      dashboardMessageId: null,
      lastUpdated: 0,
      image: {
        width: null,
        height: null,
        icon: null
      }
    },
    tiers: tierDefaults,
    users: {
      // userId: { mainId, lockUntil, wizQueue, wizIndex }
    },
    draftVotes: {
      // userId: { characterId: "S|A|B|C|D" }
    },
    finalVotes: {
      // userId: { characterId: "S|A|B|C|D" }
    }
  };
}

function loadState() {
  ensureDir(STATE_DIR);
  if (!fs.existsSync(STATE_PATH)) {
    const st = defaultState();
    saveState(st);
    return st;
  }
  try {
    const st = JSON.parse(fs.readFileSync(STATE_PATH, "utf-8"));
    const def = defaultState();
    st.settings ||= def.settings;
    st.settings.image ||= def.settings.image;
    st.tiers ||= tierDefaults;
    st.users ||= {};
    st.draftVotes ||= {};
    st.finalVotes ||= {};
    return st;
  } catch {
    const st = defaultState();
    saveState(st);
    return st;
  }
}

function saveState(st) {
  ensureDir(STATE_DIR);
  const tmp = STATE_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(st, null, 2), "utf-8");
  fs.renameSync(tmp, STATE_PATH);
}

let state = loadState();

const CYRILLIC_TO_LATIN = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "yo", ж: "zh", з: "z",
  и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r",
  с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sch",
  ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya"
};

function transliterateToLatin(value) {
  return String(value || "")
    .toLowerCase()
    .split("")
    .map(ch => CYRILLIC_TO_LATIN[ch] ?? ch)
    .join("");
}

function normalizeCharacterId(value) {
  return transliterateToLatin(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
}

function getBaseCharacterImagePath(characterId) {
  return path.join(ASSETS_DIR, "characters", `${characterId}.png`);
}

function getCustomCharacterImagePath(characterId) {
  return path.join(CUSTOM_CHARACTERS_DIR, `${characterId}.png`);
}

function resolveCharacterImagePath(characterId) {
  const customPath = getCustomCharacterImagePath(characterId);
  if (fs.existsSync(customPath)) return customPath;

  const basePath = getBaseCharacterImagePath(characterId);
  if (fs.existsSync(basePath)) return basePath;

  return null;
}

function encodePngToBuffer(img) {
  const chunks = [];
  const stream = new PassThrough();
  stream.on("data", c => chunks.push(c));
  return PImage.encodePNGToStream(img, stream).then(() => {
    stream.end();
    return Buffer.concat(chunks);
  });
}

function bufferToStream(buffer) {
  const stream = new PassThrough();
  stream.end(buffer);
  return stream;
}

function detectAttachmentImageType(attachment) {
  const contentType = String(attachment?.contentType || "").toLowerCase();
  const source = `${attachment?.name || ""} ${attachment?.url || ""}`.toLowerCase();

  if (contentType.includes("png") || /\.png(?:$|[?\s])/.test(source)) return "png";
  if (contentType.includes("jpeg") || contentType.includes("jpg") || /\.jpe?g(?:$|[?\s])/.test(source)) return "jpeg";
  return null;
}

function downloadBuffer(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error("Слишком много редиректов при скачивании картинки."));

    const transport = String(url).startsWith("https:") ? https : http;
    const req = transport.get(url, (res) => {
      if (res.statusCode && [301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        const nextUrl = new URL(res.headers.location, url).toString();
        res.resume();
        return resolve(downloadBuffer(nextUrl, redirects + 1));
      }

      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`Не удалось скачать картинку (${res.statusCode || "unknown"}).`));
      }

      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    });

    req.on("error", reject);
  });
}

async function normalizeCharacterImageBuffer(buffer, imageType, size = 512) {
  const input = imageType === "png"
    ? await PImage.decodePNGFromStream(bufferToStream(buffer))
    : await PImage.decodeJPEGFromStream(bufferToStream(buffer));

  if (!input?.width || !input?.height) {
    throw new Error("Не удалось прочитать размеры картинки.");
  }

  const canvas = PImage.make(size, size);
  const ctx = canvas.getContext("2d");
  const scale = Math.min(size / input.width, size / input.height);
  const drawW = Math.max(1, Math.round(input.width * scale));
  const drawH = Math.max(1, Math.round(input.height * scale));
  const x = Math.floor((size - drawW) / 2);
  const y = Math.floor((size - drawH) / 2);

  ctx.drawImage(input, x, y, drawW, drawH);
  return encodePngToBuffer(canvas);
}

function appendCharacterToActiveWizards(characterId) {
  for (const userId of Object.keys(state.users || {})) {
    const u = getUser(userId);
    if (!u.mainId || !Array.isArray(u.wizQueue) || wizardDone(userId)) continue;
    if (u.mainId === characterId) continue;
    if (u.wizQueue.includes(characterId)) continue;
    u.wizQueue.push(characterId);
  }
}

// -------------------- MOD CHECK --------------------
function isModerator(interaction) {
  if (!interaction.inGuild()) return false;
  const member = interaction.member;
  if (member.permissions?.has(PermissionFlagsBits.ManageGuild)) return true;
  if (ADMIN_ROLE_SET.size === 0) return false;
  const roles = member.roles?.cache;
  if (!roles) return false;
  for (const rid of ADMIN_ROLE_SET) if (roles.has(rid)) return true;
  return false;
}

// -------------------- TIERS --------------------
const TIER_ORDER = ["S", "A", "B", "C", "D"];
const TIER_OFFSET = { S: +2, A: +1, B: 0, C: -1, D: -2 };

function voteWeight(tierKey) {
  const off = Math.abs(TIER_OFFSET[tierKey]);
  return off === 2 ? 5 : 1;
}

// prior: one virtual B vote
function computeCharacterAvgOffset(characterId) {
  let sum = 0;
  let wsum = 1;

  for (const [uid, votes] of Object.entries(state.finalVotes)) {
    const t = votes?.[characterId];
    if (!t) continue;

    const mult = getStoredInfluenceMultiplier(uid);
    const w = voteWeight(t) * mult;

    sum += TIER_OFFSET[t] * w;
    wsum += w;
  }
  return sum / wsum;
}

function avgToTier(avg) {
  if (avg >= 1.5) return "S";
  if (avg >= 0.5) return "A";
  if (avg > -0.5) return "B";
  if (avg > -1.5) return "C";
  return "D";
}

function computeGlobalBuckets() {
  const buckets = { S: [], A: [], B: [], C: [], D: [] };
  const meta = {};
  const voters = new Set();

  for (const [uid, votes] of Object.entries(state.finalVotes)) {
    if (votes && Object.keys(votes).length > 0) voters.add(uid);
  }

  for (const c of characters) {
    let votesCount = 0;
    for (const votes of Object.values(state.finalVotes)) {
      if (votes?.[c.id]) votesCount++;
    }
    const avg = computeCharacterAvgOffset(c.id);
    const tier = avgToTier(avg);
    buckets[tier].push(c.id);
    meta[c.id] = { avg, votes: votesCount, name: (charById.get(c.id)?.name || c.id) };
  }

  // Sort inside tiers: avg desc, votes desc, name asc (stable feeling)
  for (const k of Object.keys(buckets)) {
    buckets[k].sort((a, b) => {
      const A = meta[a];
      const B = meta[b];
      if (B.avg !== A.avg) return B.avg - A.avg;
      if (B.votes !== A.votes) return B.votes - A.votes;
      return String(A.name).localeCompare(String(B.name), "ru");
    });
  }

  return { buckets, votersCount: voters.size };
}


// -------------------- USER BUCKETS (for panel view + my_status) --------------------
function normalizeTierKey(t) {
  return TIER_OFFSET.hasOwnProperty(t) ? t : "B";
}

function buildBucketsFromVoteMap(voteMap) {
  const buckets = { S: [], A: [], B: [], C: [], D: [] };
  for (const c of characters) {
    const t = normalizeTierKey(voteMap?.[c.id]);
    buckets[t].push(c.id);
  }
  // Sort like global feel: by global avg desc, then name asc
  for (const k of Object.keys(buckets)) {
    buckets[k].sort((a, b) => {
      const av = computeCharacterAvgOffset(a);
      const bv = computeCharacterAvgOffset(b);
      if (bv !== av) return bv - av;
      const an = charById.get(a)?.name || a;
      const bn = charById.get(b)?.name || b;
      return String(an).localeCompare(String(bn), "ru");
    });
  }
  return buckets;
}

async function renderUserFinalTierlistPng(targetUserId, titleSuffix) {
  const votes = state.finalVotes?.[targetUserId] || {};
  const tu = state.users?.[targetUserId] || {};
  const mainId = tu.mainId || null;

  const buckets = buildBucketsFromVoteMap(votes);
  const updated = new Date().toLocaleString("ru-RU");

  return renderTierlistFromBuckets({
    title: `${DASHBOARD_TITLE}${titleSuffix ? " " + titleSuffix : ""}`,
    footerText: `user: ${targetUserId}. updated: ${updated}`,
    buckets,
    lockedId: mainId
  });
}

// -------------------- IMAGE CONFIG --------------------
function getImageConfig() {
  const cfg = state.settings?.image || {};
  const w = Number(cfg.width) || Number(IMG_WIDTH) || 2000;
  const h = Number(cfg.height) || Number(IMG_HEIGHT) || 1200;
  const icon = Number(cfg.icon) || Number(ICON_SIZE) || 112;
  return {
    W: Math.max(1200, w),
    H: Math.max(700, h),
    ICON: Math.max(64, icon)
  };
}

// -------------------- FONTS (FIX FOR "NO TEXT") --------------------
// Your repo has assets/fonts/montserrat-bold.ttf, but earlier code expected NotoSans*.ttf.
// This loader will auto-detect any .ttf in assets/fonts and use it as fallback.
let fontsReady = false;
let FONT_REG = "AppFont";
let FONT_BOLD = "AppFontBold";
let FONT_INFO = { regularFile: null, boldFile: null, usedFallback: false };

function listTtfFiles() {
  const dir = path.join(ASSETS_DIR, "fonts");
  try {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter(f => f.toLowerCase().endsWith(".ttf"))
      .map(f => path.join(dir, f));
  } catch {
    return [];
  }
}

function pickFontFiles() {
  const dir = path.join(ASSETS_DIR, "fonts");
  const notoReg = path.join(dir, "NotoSans-Regular.ttf");
  const notoBold = path.join(dir, "NotoSans-Bold.ttf");

  if (fs.existsSync(notoReg) && fs.existsSync(notoBold)) {
    return { regularFile: notoReg, boldFile: notoBold, usedFallback: false };
  }

  const mont = path.join(dir, "montserrat-bold.ttf");
  if (fs.existsSync(mont)) {
    // Use same file for both to guarantee text renders
    return { regularFile: mont, boldFile: mont, usedFallback: true };
  }

  const any = listTtfFiles();
  if (any.length > 0) {
    return { regularFile: any[0], boldFile: any[0], usedFallback: true };
  }

  return { regularFile: null, boldFile: null, usedFallback: true };
}

function tryRegisterFonts() {
  if (fontsReady) return;

  const picked = pickFontFiles();
  FONT_INFO = picked;

  try {
    if (picked.regularFile) PImage.registerFont(picked.regularFile, FONT_REG).loadSync();
    if (picked.boldFile) PImage.registerFont(picked.boldFile, FONT_BOLD).loadSync();
  } catch {
    // ignore (we'll still proceed; but most likely text won't render without fonts)
  } finally {
    fontsReady = true;
  }
}

// -------------------- IMAGE RENDER --------------------
const iconCache = new Map();

async function loadIcon(characterId) {
  if (iconCache.has(characterId)) return iconCache.get(characterId);

  const p = resolveCharacterImagePath(characterId);
  if (!p || !fs.existsSync(p)) {
    iconCache.set(characterId, null);
    return null;
  }
  try {
    const img = await PImage.decodePNGFromStream(fs.createReadStream(p));
    iconCache.set(characterId, img);
    return img;
  } catch {
    iconCache.set(characterId, null);
    return null;
  }
}

function hexToRgb(hex) {
  const h = (hex || "#cccccc").replace("#", "");
  const n = parseInt(h, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
function fill(ctx, hex) {
  const { r, g, b } = hexToRgb(hex);
  ctx.fillStyle = `rgb(${r},${g},${b})`;
}

async function renderTierlistFromBuckets({
  title,
  footerText,
  buckets,
  lockedId = null,
  highlightId = null
}) {
  tryRegisterFonts();
  const { W, H: H_CFG, ICON } = getImageConfig();

  // Layout constants
  const topY = 110;
  const rows = 5;
  const leftW = Math.floor(W * 0.24);
  const rightPadding = 36;

  // Dynamic wrapping math (so tiers can grow downward when icons are big)
  const gap = Math.max(10, Math.floor(ICON * 0.16));
  const rightW = W - leftW - rightPadding - 24;
  const cols = Math.max(1, Math.floor((rightW + gap) / (ICON + gap)));

  const rowHeights = TIER_ORDER.map((tierKey) => {
    const n = (buckets[tierKey] || []).length;
    const rowsNeeded = Math.max(1, Math.ceil(n / cols));
    const iconsH = rowsNeeded * (ICON + gap) - gap;
    const needed = 18 + iconsH + 22 + 12; // top pad + grid + bottom pad + panel padding
    return Math.max(needed, 160); // minimum so left label text fits
  });

  const footerH = 44;
  const neededH = topY + rowHeights.reduce((a, b) => a + b, 0) + footerH;
  const H = Math.max(H_CFG, neededH);

  const img = PImage.make(W, H);
  const ctx = img.getContext("2d");

  fill(ctx, "#242424");
  ctx.fillRect(0, 0, W, H);

  // Title
  fill(ctx, "#ffffff");
  ctx.font = `64px '${FONT_BOLD}'`;
  ctx.fillText(title, 40, 82);

  // Footer
  fill(ctx, "#cfcfcf");
  ctx.font = `22px '${FONT_REG}'`;
  ctx.fillText(footerText, 40, H - 18);

  let yCursor = topY;

  for (let i = 0; i < rows; i++) {
    const tierKey = TIER_ORDER[i];
    const y = yCursor;
    const rowH = rowHeights[i];
    yCursor += rowH;

    // Right panel background
    fill(ctx, "#2f2f2f");
    ctx.fillRect(leftW, y, W - leftW - rightPadding, rowH - 12);

    // Left label block
    const tierColor = state.tiers?.[tierKey]?.color || "#cccccc";
    fill(ctx, tierColor);
    ctx.fillRect(40, y, leftW - 40, rowH - 12);

    // Tier label
    const tierName = state.tiers?.[tierKey]?.name || tierKey;
    const blockH = rowH - 12;

    fill(ctx, "#111111");
    ctx.font = `56px '${FONT_BOLD}'`;
    ctx.fillText(tierName, 40 + 70, y + Math.floor(blockH / 2) + 18);

    fill(ctx, "#111111");
    ctx.font = `24px '${FONT_REG}'`;
    ctx.fillText(tierKey, 40 + 70, y + blockH - 18);

    // Icons layout (wraps to next line; tier row grows if needed)
    const list = buckets[tierKey] || [];
    const rightX = leftW + 24;
    const rightY = y + 18;

    for (let idx = 0; idx < list.length; idx++) {
      const cid = list[idx];
      const col = idx % cols;
      const row = Math.floor(idx / cols);
      const x = rightX + col * (ICON + gap);
      const yy = rightY + row * (ICON + gap);

      const icon = await loadIcon(cid);

      // frame
      fill(ctx, "#171717");
      ctx.fillRect(x - 3, yy - 3, ICON + 6, ICON + 6);

      // highlight
      if (highlightId && cid === highlightId) {
        ctx.strokeStyle = "rgba(255,255,255,0.95)";
        ctx.lineWidth = 6;
        ctx.strokeRect(x - 5, yy - 5, ICON + 10, ICON + 10);
      }

      if (icon) {
        ctx.drawImage(icon, x, yy, ICON, ICON);
      } else {
        fill(ctx, "#555555");
        ctx.fillRect(x, yy, ICON, ICON);
      }

      // locked main overlay
      if (lockedId && cid === lockedId) {
        ctx.fillStyle = "rgba(0,0,0,0.55)";
        ctx.fillRect(x, yy, ICON, ICON);
        ctx.fillStyle = "rgba(230,230,230,0.95)";
        ctx.font = `22px '${FONT_BOLD}'`;
        ctx.fillText("MAIN", x + 10, yy + 32);
      }
    }
  }

  return encodePngToBuffer(img);
}

async function renderGlobalTierlistPng() {
  const { buckets, votersCount } = computeGlobalBuckets();
  const updated = new Date().toLocaleString("ru-RU");
  return renderTierlistFromBuckets({
    title: DASHBOARD_TITLE,
    footerText: `voters: ${votersCount}. updated: ${updated}`,
    buckets
  });
}

function computeDraftBuckets(userId) {
  const u = getUser(userId);
  const d = getDraft(userId);
  const f = getFinal(userId);
  const useExistingVotes = u.wizMode === "new";

  const buckets = { S: [], A: [], B: [], C: [], D: [] };
  for (const c of characters) {
    const baseTier = useExistingVotes && f[c.id] ? f[c.id] : "B";
    const t = (d[c.id] && TIER_OFFSET[d[c.id]] !== undefined) ? d[c.id] : baseTier;
    buckets[t].push(c.id);
  }

  for (const k of Object.keys(buckets)) {
    buckets[k].sort((a, b) => (charById.get(a)?.name || a).localeCompare(charById.get(b)?.name || b));
  }

  return buckets;
}

async function renderDraftPreviewPng(userId, highlightId) {
  const u = getUser(userId);
  const buckets = computeDraftBuckets(userId);
  const total = u.wizQueue?.length || 0;
  const idx = Math.min(u.wizIndex || 0, total);
  const updated = new Date().toLocaleTimeString("ru-RU");
  return renderTierlistFromBuckets({
    title: `${DASHBOARD_TITLE} (твоя оценка)`,
    footerText: `progress: ${Math.min(idx, total)}/${total}. ${updated}`,
    buckets,
    lockedId: u.mainId || null,
    highlightId: highlightId || null
  });
}

// -------------------- USER HELPERS --------------------
function formatTime(ts) {
  return new Date(ts).toLocaleString("ru-RU");
}

function getUser(userId) {
  state.users[userId] ||= { mainId: null, lockUntil: 0, lastSubmitAt: 0, wizQueue: null, wizIndex: 0, wizMode: null, influenceMultiplier: 1, influenceRoleId: null, influenceUpdatedAt: 0, panelTierKey: "S", panelTab: "config", panelParticipantsPage: 0, panelParticipantId: null, panelDeleteTargetId: null, panelDeleteMode: null, mainSelectPage: 0 };

  const u = state.users[userId];
  if (u.lastSubmitAt == null) u.lastSubmitAt = 0;
  if (!u.panelTierKey) u.panelTierKey = "S";
  if (!u.panelTab) u.panelTab = "config";
  if (u.panelParticipantsPage == null) u.panelParticipantsPage = 0;
  if (u.panelParticipantId == null) u.panelParticipantId = null;
  if (u.mainSelectPage == null) u.mainSelectPage = 0;
  if (u.wizMode == null) u.wizMode = null;

  return u;
}
function getDraft(userId) {
  state.draftVotes[userId] ||= {};
  return state.draftVotes[userId];
}
function getFinal(userId) {
  state.finalVotes[userId] ||= {};
  return state.finalVotes[userId];
}

function isLocked(userId) {
  const u = getUser(userId);
  return u.lockUntil && Date.now() < u.lockUntil;
}

function setMain(userId, mainId) {
  const u = getUser(userId);
  u.mainId = mainId;
  u.mainSelectPage = findCharacterMainPage(mainId);

  // remove main from draft/final if present
  const d = getDraft(userId);
  if (d[mainId]) delete d[mainId];
  const f = getFinal(userId);
  if (f[mainId]) delete f[mainId];
}

function hasSubmittedTierlist(userId) {
  const finalVotes = state.finalVotes?.[userId] || {};
  return Object.keys(finalVotes).length > 0;
}

function getPendingNewCharacterIds(userId) {
  const u = getUser(userId);
  const finalVotes = getFinal(userId);
  return characters
    .map(c => c.id)
    .filter(cid => cid !== u.mainId)
    .filter(cid => !finalVotes[cid]);
}

function canUseCurrentWizard(userId) {
  const u = getUser(userId);
  return !isLocked(userId) || u.wizMode === "new";
}

function startWizard(userId, mode = "full") {
  const u = getUser(userId);
  state.draftVotes[userId] = {};
  u.wizMode = mode;
  u.wizQueue = mode === "new"
    ? getPendingNewCharacterIds(userId)
    : characters.map(c => c.id).filter(cid => cid !== u.mainId);
  u.wizIndex = 0;
}

function currentWizardChar(userId) {
  const u = getUser(userId);
  const q = u.wizQueue || [];
  const idx = Math.max(0, Math.min(u.wizIndex || 0, q.length));
  return q[idx] || null;
}

function wizardDone(userId) {
  const u = getUser(userId);
  const q = u.wizQueue || [];
  return (u.wizIndex || 0) >= q.length;
}

function setDraftTier(userId, cid, tierKey) {
  const u = getUser(userId);
  if (!cid) return;
  if (cid === u.mainId) return;
  if (!TIER_OFFSET.hasOwnProperty(tierKey)) return;
  const d = getDraft(userId);
  d[cid] = tierKey;
}

function wizardNext(userId) {
  const u = getUser(userId);
  const q = u.wizQueue || [];
  u.wizIndex = Math.min((u.wizIndex || 0) + 1, q.length);
}

function wizardBack(userId) {
  const u = getUser(userId);
  u.wizIndex = Math.max((u.wizIndex || 0) - 1, 0);
}

function submitWizardVotes(userId) {
  const u = getUser(userId);
  const q = u.wizQueue || [];
  const d = getDraft(userId);
  const f = getFinal(userId);

  for (const cid of q) {
    const t = (d[cid] && TIER_OFFSET[d[cid]] !== undefined) ? d[cid] : "B";
    f[cid] = t;
  }
  if (u.mainId && f[u.mainId]) delete f[u.mainId];
}

function lockUser(userId) {
  const u = getUser(userId);
  u.lockUntil = Date.now() + COOLDOWN_MS;
}

// -------------------- UI BUILDERS --------------------
function getMainSelectPageCount() {
  return Math.max(1, Math.ceil(characters.length / MAIN_SELECT_PAGE_SIZE));
}

function findCharacterMainPage(characterId) {
  const idx = characters.findIndex(c => c.id === characterId);
  if (idx < 0) return 0;
  return Math.floor(idx / MAIN_SELECT_PAGE_SIZE);
}

function clampMainSelectPage(page) {
  return Math.max(0, Math.min(Number(page) || 0, getMainSelectPageCount() - 1));
}

function buildMainSelectRows(userId) {
  const u = getUser(userId);
  const page = clampMainSelectPage(u.mainSelectPage);
  const start = page * MAIN_SELECT_PAGE_SIZE;
  const slice = characters.slice(start, start + MAIN_SELECT_PAGE_SIZE);
  u.mainSelectPage = page;

  const menu = new StringSelectMenuBuilder()
    .setCustomId("select_main")
    .setPlaceholder(`Выбери своего main (${page + 1}/${getMainSelectPageCount()})`)
    .setMinValues(1)
    .setMaxValues(1);

  for (const c of slice) {
    menu.addOptions({
      label: c.name.slice(0, 100),
      value: c.id,
      default: u.mainId === c.id
    });
  }

  const rows = [new ActionRowBuilder().addComponents(menu)];
  if (getMainSelectPageCount() > 1) {
    rows.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("main_page_prev")
          .setLabel(`Персонажи ${page + 1}/${getMainSelectPageCount()} <-`)
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(page <= 0),
        new ButtonBuilder()
          .setCustomId("main_page_next")
          .setLabel("->")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(page >= getMainSelectPageCount() - 1)
      )
    );
  }

  return rows;
}

function buildStartButtons(userId) {
  const u = getUser(userId);
  const row = new ActionRowBuilder();
  if (u.mainId) {
    const nm = charById.get(u.mainId)?.name || u.mainId;
    row.addComponents(
      new ButtonBuilder()
        .setCustomId("wiz_use_current_main")
        .setLabel(`Продолжить с main: ${nm}`.slice(0, 80))
        .setStyle(ButtonStyle.Primary)
    );
  }
  row.addComponents(
    new ButtonBuilder().setCustomId("wiz_cancel").setLabel("Закрыть").setStyle(ButtonStyle.Secondary)
  );
  return row;
}

function buildTierButtons(disabled = false) {
  const make = (k) =>
    new ButtonBuilder()
      .setCustomId(`wiz_rate_${k}`)
      .setLabel(`${k}`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled);

  return new ActionRowBuilder().addComponents(make("S"), make("A"), make("B"), make("C"), make("D"));
}

function buildWizardNavRow(userId) {
  const u = getUser(userId);
  const backDisabled = (u.wizIndex || 0) <= 0;

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("wiz_back").setLabel("Назад").setStyle(ButtonStyle.Secondary).setDisabled(backDisabled),
    new ButtonBuilder().setCustomId("wiz_cancel").setLabel("Закрыть").setStyle(ButtonStyle.Danger)
  );

  if (wizardDone(userId)) {
    row.addComponents(new ButtonBuilder().setCustomId("wiz_submit").setLabel("Отправить").setStyle(ButtonStyle.Success));
  }
  return row;
}

function buildStartEmbed(userId) {
  const u = getUser(userId);
  const locked = isLocked(userId);
  const main = u.mainId ? (charById.get(u.mainId)?.name || u.mainId) : "не выбран";
  const hasFinal = hasSubmittedTierlist(userId);

  const e = new EmbedBuilder()
    .setTitle("Оценка персонажей")
    .setDescription(
      [
        "1) выбери своего main.",
        "2) появится твой личный тир-лист.",
        "3) оценивай персонажей по одному кнопками S A B C D.",
        "main будет серым и заблокированным.",
        hasFinal ? "Для новых персонажей на дашборде есть кнопка **Оценить новых**." : "После первой отправки новые персонажи можно будет дооценивать кнопкой **Оценить новых**."
      ].join("\n")
    )
    .addFields({ name: "Main", value: `**${main}**`, inline: true });

  if (locked) e.addFields({ name: "Кулдаун", value: `До **${formatTime(u.lockUntil)}**`, inline: false });
  else e.addFields({ name: "Кулдаун", value: "Можно отправлять сейчас.", inline: false });

  return e;
}

async function buildWizardPayload(userId) {
  const u = getUser(userId);
  const q = u.wizQueue || [];
  const total = q.length;
  const done = Math.min(u.wizIndex || 0, total);

  const currentId = currentWizardChar(userId);
  const currentName = currentId ? (charById.get(currentId)?.name || currentId) : "—";
  const lockedMain = u.mainId ? (charById.get(u.mainId)?.name || u.mainId) : "не выбран";
  const finished = wizardDone(userId);

  // 1) Preview tierlist (always)
  const preview = await renderDraftPreviewPng(userId, finished ? null : currentId);
  const files = [new AttachmentBuilder(preview, { name: "preview.png" })];

  // 2) Current character image (if exists)
  let hasCharImage = false;
  if (!finished && currentId) {
    const iconPath = resolveCharacterImagePath(currentId);
    if (iconPath && fs.existsSync(iconPath)) {
      files.push(new AttachmentBuilder(fs.readFileSync(iconPath), { name: "character.png" }));
      hasCharImage = true;
    }
  }

  const eChar = new EmbedBuilder()
    .setTitle(finished ? "Готово" : `Сейчас: ${currentName}`)
    .setDescription(
      finished
        ? "готово. проверь свой тир-лист ниже и нажми **отправить**."
        : (u.wizMode === "new"
            ? "доставь оценку только для новых персонажей кнопками S A B C D."
            : "выбери тир для текущего персонажа кнопками S A B C D.")
    )
    .addFields(
      { name: "Main", value: `⬛ **${lockedMain}** (locked)`, inline: true },
      { name: "Прогресс", value: `${done}/${total}`, inline: true },
      { name: "Сейчас", value: finished ? "—" : `**${currentName}**`, inline: false }
    );

  if (hasCharImage) {
    eChar.setImage("attachment://character.png");
  }

  const ePreview = new EmbedBuilder()
    .setTitle("Твой тир-лист")
    .setDescription("обновляется после каждого клика.")
    .setImage("attachment://preview.png");

  const rows = [buildTierButtons(finished), buildWizardNavRow(userId)];
  return { embeds: [eChar, ePreview], components: rows, files, attachments: [] };
}

// -------------------- DASHBOARD --------------------
function dashboardComponents() {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("start_rating").setLabel("Начать оценку").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("rate_new_characters").setLabel("Оценить новых").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("my_status").setLabel("Мой статус").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("refresh_tierlist").setLabel("Обновить тир-лист").setStyle(ButtonStyle.Secondary)
  );
  return [row];
}

async function ensureDashboardMessage(client, channelId) {
  const guild = await client.guilds.fetch(GUILD_ID);
  const channel = await guild.channels.fetch(channelId);
  if (!channel || !channel.isTextBased()) throw new Error("Channel is not text based");

  const mid = state.settings.dashboardMessageId;
  let msg = null;

  if (mid) {
    try { msg = await channel.messages.fetch(mid); } catch { msg = null; }
  }

  const png = await renderGlobalTierlistPng();
  const attachment = new AttachmentBuilder(png, { name: "tierlist.png" });

  const embed = new EmbedBuilder()
    .setTitle(DASHBOARD_TITLE)
    .setDescription("кнопка **начать оценку** откроет полный опрос. **оценить новых** позволит дооценить только что добавленных персонажей без сброса твоего тир-листа.")
    .setImage("attachment://tierlist.png");

  if (!msg) {
    msg = await channel.send({ embeds: [embed], files: [attachment], components: dashboardComponents() });
    try { await msg.pin(); } catch {}
    state.settings.channelId = channelId;
    state.settings.dashboardMessageId = msg.id;
    state.settings.lastUpdated = Date.now();
    saveState(state);
    return msg;
  }

  await msg.edit({ embeds: [embed], files: [attachment], components: dashboardComponents(), attachments: [] });
  state.settings.lastUpdated = Date.now();
  saveState(state);
  return msg;
}

async function refreshDashboard(client) {
  const channelId = state.settings.channelId;
  const msgId = state.settings.dashboardMessageId;
  if (!channelId || !msgId) return false;

  const guild = await client.guilds.fetch(GUILD_ID);
  const channel = await guild.channels.fetch(channelId);
  if (!channel || !channel.isTextBased()) return false;

  let msg;
  try { msg = await channel.messages.fetch(msgId); } catch { return false; }

  const png = await renderGlobalTierlistPng();
  const attachment = new AttachmentBuilder(png, { name: "tierlist.png" });

  const embed = new EmbedBuilder()
    .setTitle(DASHBOARD_TITLE)
    .setDescription("кнопка **начать оценку** откроет полный опрос. **оценить новых** позволит дооценить только что добавленных персонажей без сброса твоего тир-листа.")
    .setImage("attachment://tierlist.png");

  await msg.edit({ embeds: [embed], files: [attachment], components: dashboardComponents(), attachments: [] });

  state.settings.lastUpdated = Date.now();
  saveState(state);
  return true;
}


// -------------------- MOD PANEL (ephemeral control window) --------------------
function buildPanelTierSelect(userId) {
  const u = getUser(userId);
  const selected = u.panelTierKey || "S";

  const menu = new StringSelectMenuBuilder()
    .setCustomId("panel_select_tier")
    .setPlaceholder("Выбери тир для переименования")
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      { label: "S", value: "S", default: selected === "S" },
      { label: "A", value: "A", default: selected === "A" },
      { label: "B", value: "B", default: selected === "B" },
      { label: "C", value: "C", default: selected === "C" },
      { label: "D", value: "D", default: selected === "D" }
    );

  return new ActionRowBuilder().addComponents(menu);
}

function buildPanelConfigPayload(userId) {
  const cfg = getImageConfig();
  const tierKey = (getUser(userId).panelTierKey || "S");
  const tierName = state.tiers?.[tierKey]?.name || tierKey;

  const e = new EmbedBuilder()
    .setTitle("Tierlist Panel (mods)")
    .setDescription(
      [
        `**Картинка:** ${cfg.W}×${cfg.H}`,
        `**Иконки:** ${cfg.ICON}px`,
        `**Переименование:** выбран **${tierKey}** → *${tierName}*`,
        "",
        "Кнопки ниже меняют параметры и сразу пересобирают PNG."
      ].join("\\n")
    );

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("panel_refresh").setLabel("Пересобрать").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("panel_icon_minus").setLabel("Иконки -").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("panel_icon_plus").setLabel("Иконки +").setStyle(ButtonStyle.Secondary)
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("panel_w_minus").setLabel("Ширина -").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("panel_w_plus").setLabel("Ширина +").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("panel_h_minus").setLabel("Высота -").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("panel_h_plus").setLabel("Высота +").setStyle(ButtonStyle.Secondary)
  );

  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("panel_rename").setLabel("Переименовать тир").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("panel_reset_img").setLabel("Сбросить размеры").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("panel_fonts").setLabel("Шрифты").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("panel_close").setLabel("Закрыть").setStyle(ButtonStyle.Danger)
  );

  return { embeds: [e], components: [row1, row2, buildPanelTierSelect(userId), row3] };
}


// -------------------- PANEL TABS + PARTICIPANTS (1-4) --------------------
function buildPanelTabsRow(userId) {
  const u = getUser(userId);
  const tab = u.panelTab || "config";

  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("panel_tab_config")
      .setLabel("Настройки")
      .setStyle(tab === "config" ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("panel_tab_participants")
      .setLabel("Участники")
      .setStyle(tab === "participants" ? ButtonStyle.Primary : ButtonStyle.Secondary)
  );
}

function getParticipantsList() {
  const out = [];
  for (const [uid, votes] of Object.entries(state.finalVotes || {})) {
    if (!votes || Object.keys(votes).length === 0) continue;

    const u = state.users?.[uid] || {};
    const inferredSubmit = (u.lockUntil && Number.isFinite(u.lockUntil)) ? (u.lockUntil - COOLDOWN_MS) : 0;
    const lastSubmitAt = Number(u.lastSubmitAt) || inferredSubmit || 0;

    out.push({
      userId: uid,
      mainId: u.mainId || null,
      lastSubmitAt
    });
  }

  out.sort((a, b) => {
    if (b.lastSubmitAt !== a.lastSubmitAt) return b.lastSubmitAt - a.lastSubmitAt;
    return String(a.userId).localeCompare(String(b.userId));
  });
  return out;
}

function buildParticipantsSelectRow(userId, participants) {
  const u = getUser(userId);
  const pageSize = 25;
  const maxPage = Math.max(0, Math.ceil(participants.length / pageSize) - 1);
  const page = Math.min(maxPage, Math.max(0, Number(u.panelParticipantsPage) || 0));
  const start = page * pageSize;
  const slice = participants.slice(start, start + pageSize);

  const menu = new StringSelectMenuBuilder()
    .setCustomId("panel_part_select_user")
    .setPlaceholder(slice.length ? "Выбери участника" : "Нет участников")
    .setMinValues(1)
    .setMaxValues(1)
    .setDisabled(slice.length === 0);

  for (const p of slice) {
    const mainName = p.mainId ? (charById.get(p.mainId)?.name || p.mainId) : "—";
    menu.addOptions({
      label: String(p.userId).slice(0, 100),
      value: p.userId,
      description: `main: ${mainName}`.slice(0, 100),
      default: u.panelParticipantId === p.userId
    });
  }

  return new ActionRowBuilder().addComponents(menu);
}

function buildParticipantsNavRow(userId, participants) {
  const u = getUser(userId);
  const pageSize = 25;
  const maxPage = Math.max(0, Math.ceil(participants.length / pageSize) - 1);
  const page = Math.min(maxPage, Math.max(0, Number(u.panelParticipantsPage) || 0));

  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("panel_part_prev").setLabel("⟵").setStyle(ButtonStyle.Secondary).setDisabled(page <= 0),
    new ButtonBuilder().setCustomId("panel_part_next").setLabel("⟶").setStyle(ButtonStyle.Secondary).setDisabled(page >= maxPage),
    new ButtonBuilder().setCustomId("panel_part_refresh").setLabel("Обновить").setStyle(ButtonStyle.Secondary)
  );
}

function buildParticipantsListPayload(userId) {
  const u = getUser(userId);
  const participants = getParticipantsList();

  const pageSize = 25;
  const maxPage = Math.max(0, Math.ceil(participants.length / pageSize) - 1);
  const page = Math.min(maxPage, Math.max(0, Number(u.panelParticipantsPage) || 0));

  const start = page * pageSize;
  const slice = participants.slice(start, start + pageSize);
  const preview = slice.slice(0, 12).map((p, i) => {
    const mainName = p.mainId ? (charById.get(p.mainId)?.name || p.mainId) : "—";
    const when = p.lastSubmitAt ? formatTime(p.lastSubmitAt) : "—";
    return `${start + i + 1}) <@${p.userId}>  main: **${mainName}**  submit: ${when}`;
  });

  const e = new EmbedBuilder()
    .setTitle("Участники тир-листа")
    .setDescription(
      [
        `Всего: **${participants.length}**`,
        `Страница: **${page + 1}/${maxPage + 1}**`,
        "",
        preview.length ? preview.join("\n") : "Пока никто не отправлял тир-лист."
      ].join("\n")
    );

  const actions = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("panel_close").setLabel("Закрыть").setStyle(ButtonStyle.Danger)
  );

  return {
    embeds: [e],
    components: [
      buildPanelTabsRow(userId),
      buildParticipantsSelectRow(userId, participants),
      buildParticipantsNavRow(userId, participants),
      actions
    ]
  };
}

function getUserTierCounts(votesObj) {
  const counts = { S: 0, A: 0, B: 0, C: 0, D: 0 };
  if (!votesObj) return counts;
  for (const t of Object.values(votesObj)) {
    if (counts[t] != null) counts[t]++;
  }
  return counts;
}

function buildParticipantsDetailPayload(userId) {
  const u = getUser(userId);
  const targetId = u.panelParticipantId;
  const votes = targetId ? (state.finalVotes?.[targetId] || null) : null;

  if (!targetId || !votes || Object.keys(votes).length === 0) {
    u.panelParticipantId = null;
    u.panelDeleteTargetId = null;
    u.panelDeleteMode = null;
    saveState(state);
    return buildParticipantsListPayload(userId);
  }

  const tu = state.users?.[targetId] || {};
  const mainName = tu.mainId ? (charById.get(tu.mainId)?.name || tu.mainId) : "—";
  const inferredSubmit = (tu.lockUntil && Number.isFinite(tu.lockUntil)) ? (tu.lockUntil - COOLDOWN_MS) : 0;
  const lastSubmitAt = Number(tu.lastSubmitAt) || inferredSubmit || 0;
  const when = lastSubmitAt ? formatTime(lastSubmitAt) : "—";
  const counts = getUserTierCounts(votes);

  const e = new EmbedBuilder()
    .setTitle("Участник")
    .setDescription(`<@${targetId}>`)
    .addFields(
      { name: "Main", value: `**${mainName}**`, inline: true },
      { name: "Submit", value: `${when}`, inline: true },
      { name: "S/A/B/C/D", value: `${counts.S}/${counts.A}/${counts.B}/${counts.C}/${counts.D}`, inline: false }
    );

  const pending = (u.panelDeleteTargetId === targetId) ? u.panelDeleteMode : null;
  if (pending) {
    e.addFields({
      name: "Подтверждение удаления",
      value: pending === "full"
        ? "⚠️ **Полный сброс пользователя** (удалит голос + user record + черновики). Нажми **Подтвердить** или **Отмена**."
        : "⚠️ **Удаление голоса** (уберёт вклад в общий тир-лист). Нажми **Подтвердить** или **Отмена**.",
      inline: false
    });
  }

  const components = [buildPanelTabsRow(userId)];

  if (!pending) {
    const row1 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("panel_part_view_png").setLabel("Показать PNG").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("panel_part_delete_votes").setLabel("Удалить голос").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("panel_part_delete_full").setLabel("Полный сброс").setStyle(ButtonStyle.Danger)
    );
    const row2 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("panel_part_back").setLabel("Назад").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("panel_close").setLabel("Закрыть").setStyle(ButtonStyle.Secondary)
    );
    components.push(row1, row2);
  } else {
    const row1 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("panel_part_confirm_delete").setLabel("Подтвердить").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("panel_part_cancel_delete").setLabel("Отмена").setStyle(ButtonStyle.Secondary)
    );
    const row2 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("panel_part_back").setLabel("Назад").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("panel_close").setLabel("Закрыть").setStyle(ButtonStyle.Secondary)
    );
    components.push(row1, row2);
  }

  return { embeds: [e], components };
}

function buildParticipantsPayload(userId) {
  const u = getUser(userId);
  if (u.panelParticipantId) return buildParticipantsDetailPayload(userId);
  return buildParticipantsListPayload(userId);
}

function buildPanelPayload(userId) {
  const u = getUser(userId);
  const tab = u.panelTab || "config";

  if (tab === "participants") {
    return buildParticipantsPayload(userId);
  }

  const base = buildPanelConfigPayload(userId);
  base.components = [buildPanelTabsRow(userId), ...(base.components || [])];
  return base;
}




function applyImageDelta(kind, delta) {
  state.settings.image ||= { width: null, height: null, icon: null };

  const cfg = getImageConfig();

  if (kind === "icon") {
    const minV = 64, maxV = 256;
    const next = Math.max(minV, Math.min(maxV, cfg.ICON + delta));
    state.settings.image.icon = next;
  } else if (kind === "width") {
    const minV = 1200, maxV = 4096;
    const next = Math.max(minV, Math.min(maxV, cfg.W + delta));
    state.settings.image.width = next;
  } else if (kind === "height") {
    const minV = 700, maxV = 2160;
    const next = Math.max(minV, Math.min(maxV, cfg.H + delta));
    state.settings.image.height = next;
  }
}

function resetImageOverrides() {
  state.settings.image ||= { width: null, height: null, icon: null };
  state.settings.image.width = null;
  state.settings.image.height = null;
  state.settings.image.icon = null;
}


// -------------------- SAFE REPLY HELPERS --------------------
async function safeRespond(interaction, payload) {
  try {
    if (interaction.deferred || interaction.replied) {
      return await interaction.editReply(payload);
    }
    return await interaction.reply(payload);
  } catch (e) {
    try {
      return await interaction.followUp({ ...payload, ephemeral: true });
    } catch {}
  }
}

// -------------------- CLIENT --------------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers
  ]
});

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);
  // Print font diagnostics once on startup
  tryRegisterFonts();
  console.log("[fonts] regular:", FONT_INFO.regularFile, "bold:", FONT_INFO.boldFile, "fallback:", FONT_INFO.usedFallback);

  if ((!state.settings.channelId || !state.settings.dashboardMessageId) && DEFAULT_CHANNEL_ID) {
    try {
      await ensureDashboardMessage(client, DEFAULT_CHANNEL_ID);
      console.log("Dashboard created/updated in DEFAULT_CHANNEL_ID");
    } catch (e) {
      console.error("Auto-setup failed:", e.message);
    }
  }
  // A) realtime influence: refresh existing voters once on startup
  try {
    const res = await backfillInfluenceForExistingVoters(client, { refresh: true });
    if (res.total > 0) {
      console.log(`[influence] startup backfill: changed ${res.changed}/${res.total}`);
    }
  } catch (e) {
    console.error("[influence] startup backfill failed:", e?.message || e);
  }

});


client.on("guildMemberUpdate", async (oldMember, newMember) => {
  // realtime influence update when tier roles are changed
  try {
    const uid = newMember.id;

    const hasVote = Boolean(state.finalVotes?.[uid] && Object.keys(state.finalVotes[uid] || {}).length > 0);
    const isTracked = Boolean(state.users?.[uid]);

    // Avoid tracking everyone in the server; only update if this user matters to our state.
    if (!hasVote && !isTracked) return;

    const inf = resolveInfluenceFromMember(newMember);
    const u = getUser(uid);

    const prev = Number(u.influenceMultiplier) || 1;
    const prevRole = u.influenceRoleId || null;

    if (prev === inf.mult && prevRole === (inf.roleId || null)) return;

    u.influenceMultiplier = inf.mult;
    u.influenceRoleId = inf.roleId;
    u.influenceUpdatedAt = Date.now();
    saveState(state);

    if (hasVote) {
      // their weight affects global tierlist -> refresh image
      await refreshDashboard(client).catch(() => {});
    }
  } catch {
    // ignore
  }
});



client.on("interactionCreate", async (interaction) => {
  try {

    // ---------------- MODAL SUBMITS ----------------
    if (interaction.isModalSubmit()) {
      if (!isModerator(interaction)) return interaction.reply({ content: "Нет прав.", ephemeral: true });

      if (interaction.customId.startsWith("panel_rename_modal:")) {
        const tierKey = interaction.customId.split(":")[1] || "S";
        const name = (interaction.fields.getTextInputValue("tier_name") || "").trim().slice(0, 24);
        if (!name) return interaction.reply({ content: "Пустое имя.", ephemeral: true });

        state.tiers[tierKey] ||= {};
        state.tiers[tierKey].name = name;
        saveState(state);

        await interaction.deferReply({ ephemeral: true });
        await refreshDashboard(client);
        return interaction.editReply(`Ок. Теперь **${tierKey}** называется: **${name}**.`);
      }

      return interaction.reply({ content: "Неизвестная модалка.", ephemeral: true });
    }

    // ---------------- SLASH COMMANDS ----------------
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === "setup") {
  if (!isModerator(interaction)) return interaction.reply({ content: "Нет прав (нужно Manage Guild).", ephemeral: true });
  const ch = interaction.options.getChannel("channel", true);
  await interaction.deferReply({ ephemeral: true });
  try {
    await ensureDashboardMessage(client, ch.id);
    return interaction.editReply("Готово. Dashboard создан/обновлён (и закреплён, если бот смог).");
  } catch (e) {
    console.error("setup failed:", e);
    return interaction.editReply(`Setup failed: ${e?.message || "unknown"}`);
  }
}

      if (interaction.commandName === "tiers") {
        if (!isModerator(interaction)) return interaction.reply({ content: "Нет прав (нужно Manage Guild).", ephemeral: true });
        const sub = interaction.options.getSubcommand();
        if (sub === "set") {
          const tier = interaction.options.getString("tier", true);
          const name = interaction.options.getString("name", true).slice(0, 24);
          state.tiers[tier] ||= {};
          state.tiers[tier].name = name;
          saveState(state);

          await interaction.deferReply({ ephemeral: true });
          await refreshDashboard(client);
          return interaction.editReply(`Ок. Теперь **${tier}** называется: **${name}** (картинка обновлена).`);
        }
      }

      if (interaction.commandName === "rebuild") {
        if (!isModerator(interaction)) return interaction.reply({ content: "Нет прав (нужно Manage Guild).", ephemeral: true });
        await interaction.deferReply({ ephemeral: true });
        const ok = await refreshDashboard(client);
        return interaction.editReply(ok ? "Картинка обновлена." : "Не нашёл dashboard. Сначала /setup.");
      }

      if (interaction.commandName === "character") {
        if (!isModerator(interaction)) return interaction.reply({ content: "Нет прав (нужно Manage Guild).", ephemeral: true });
        const sub = interaction.options.getSubcommand();

        if (sub === "add") {
          const name = (interaction.options.getString("name", true) || "").trim().slice(0, 100);
          const image = interaction.options.getAttachment("image", true);
          const requestedId = interaction.options.getString("id");
          const characterId = normalizeCharacterId(requestedId || name);

          if (!name) {
            return interaction.reply({ content: "Имя персонажа пустое.", ephemeral: true });
          }
          if (!characterId) {
            return interaction.reply({ content: "Не удалось получить id. Укажи `id` латиницей или дай имя попроще.", ephemeral: true });
          }
          if (charById.has(characterId)) {
            return interaction.reply({ content: `Персонаж с id \`${characterId}\` уже существует.`, ephemeral: true });
          }

          const imageType = detectAttachmentImageType(image);
          if (!imageType) {
            return interaction.reply({ content: "Поддерживаются только PNG и JPG/JPEG.", ephemeral: true });
          }

          await interaction.deferReply({ ephemeral: true });

          const imageBuffer = await downloadBuffer(image.url);
          const normalizedPng = await normalizeCharacterImageBuffer(imageBuffer, imageType, 512);
          const customCharacters = readCustomCharacters();

          if (customCharacters.some(c => c?.id === characterId) || charById.has(characterId)) {
            return interaction.editReply(`Персонаж с id \`${characterId}\` уже существует.`);
          }

          const entry = { id: characterId, name, enabled: true };
          const nextCustomCharacters = [...customCharacters, entry];
          const imagePath = getCustomCharacterImagePath(characterId);
          let imageWritten = false;

          try {
            writeBufferAtomic(imagePath, normalizedPng);
            imageWritten = true;
            saveJsonAtomic(CUSTOM_CHARACTERS_PATH, nextCustomCharacters);
          } catch (e) {
            if (imageWritten) {
              try { fs.unlinkSync(imagePath); } catch {}
            }
            throw e;
          }

          reloadCharacterCatalog();
          iconCache.delete(characterId);
          appendCharacterToActiveWizards(characterId);
          saveState(state);

          let dashboardMessage = "Dashboard обновлён.";
          try {
            const dashboardUpdated = await refreshDashboard(client);
            if (!dashboardUpdated) {
              dashboardMessage = "Персонаж сохранён, но dashboard пока не найден. Сначала /setup.";
            }
          } catch (e) {
            dashboardMessage = `Персонаж сохранён, но dashboard не обновился: ${e?.message || "unknown"}`;
          }

          const replyLines = [
            `Персонаж **${name}** добавлен.`,
            `id: \`${characterId}\``,
            dashboardMessage
          ];
          return interaction.editReply(replyLines.join("\n"));
        }
      }

      if (interaction.commandName === "stats") {
        if (!isModerator(interaction)) return interaction.reply({ content: "Нет прав.", ephemeral: true });
        const { votersCount } = computeGlobalBuckets();
        const cfg = getImageConfig();
        const lines = [
          `channelId: ${state.settings.channelId || "—"}`,
          `dashboardMessageId: ${state.settings.dashboardMessageId || "—"}`,
          `voters: ${votersCount}`,
          `lastUpdated: ${state.settings.lastUpdated ? formatTime(state.settings.lastUpdated) : "—"}`,
          `img: ${cfg.W}x${cfg.H}, icon=${cfg.ICON}`
        ];
        return interaction.reply({ content: lines.join("\n"), ephemeral: true });
      }

      if (interaction.commandName === "debug") {
        if (!isModerator(interaction)) return interaction.reply({ content: "Нет прав.", ephemeral: true });
        const sub = interaction.options.getSubcommand();
        if (sub === "fonts") {
          tryRegisterFonts();
          const files = listTtfFiles();
          const lines = [
            `assets/fonts ttf files:`,
            files.length ? files.map(f => `- ${path.basename(f)}`).join("\n") : "- (none)",
            "",
            `picked regular: ${FONT_INFO.regularFile ? path.basename(FONT_INFO.regularFile) : "(null)"}`,
            `picked bold: ${FONT_INFO.boldFile ? path.basename(FONT_INFO.boldFile) : "(null)"}`,
            `fallback: ${FONT_INFO.usedFallback}`
          ];
          return interaction.reply({ content: lines.join("\n"), ephemeral: true });
        }
      }

      if (interaction.commandName === "image") {
        if (!isModerator(interaction)) return interaction.reply({ content: "Нет прав.", ephemeral: true });
        const sub = interaction.options.getSubcommand();

        if (sub === "show") {
          const cfg = getImageConfig();
          return interaction.reply({ content: `img: ${cfg.W}x${cfg.H}, icon=${cfg.ICON}`, ephemeral: true });
        }

        if (sub === "set") {
          const width = interaction.options.getInteger("width");
          const height = interaction.options.getInteger("height");
          const icon = interaction.options.getInteger("icon");

          if (width) state.settings.image.width = width;
          if (height) state.settings.image.height = height;
          if (icon) state.settings.image.icon = icon;
          saveState(state);

          await interaction.deferReply({ ephemeral: true });
          await refreshDashboard(client);
          const cfg = getImageConfig();
          return interaction.editReply(`Ок. Теперь img: ${cfg.W}x${cfg.H}, icon=${cfg.ICON} (картинка обновлена).`);
        }
      }
      if (interaction.commandName === "panel") {
        if (!isModerator(interaction)) return interaction.reply({ content: "Нет прав (mods).", ephemeral: true });
        const payload = buildPanelPayload(interaction.user.id);
        return interaction.reply({ ...payload, ephemeral: true });
      }

    }

    // ---------------- BUTTONS ----------------
    if (interaction.isButton()) {
      const userId = interaction.user.id;
      const u = getUser(userId);

if (interaction.customId === "refresh_tierlist") {
  if (!isModerator(interaction)) {
    return interaction.reply({ content: "Нет прав (нужно Manage Guild).", ephemeral: true });
  }
  await interaction.deferReply({ ephemeral: true });
  const ok = await refreshDashboard(client);
  return interaction.editReply(ok ? "Ок. Тир-лист обновлён." : "Не нашёл dashboard. Сначала /setup.");
}

      if (interaction.customId === "my_status") {
        const main = u.mainId ? (charById.get(u.mainId)?.name || u.mainId) : "не выбран";
        const locked = isLocked(userId);
        const votes = state.finalVotes?.[userId] || null;

        // If user has submitted, show their submitted tierlist PNG (same settings as main)
        if (votes && Object.keys(votes).length > 0) {
          await interaction.deferReply({ ephemeral: true });

          const png = await renderUserFinalTierlistPng(userId, "(твой тир-лист)");
          const attachment = new AttachmentBuilder(png, { name: "my-tierlist.png" });

          const lastSubmitAt = u.lastSubmitAt ? formatTime(u.lastSubmitAt) : "—";
          const counts = getUserTierCounts(votes);

          const emb = new EmbedBuilder()
            .setTitle("Твой статус")
            .setDescription(
              [
                `Main: **${main}**`,
                `Submit: ${lastSubmitAt}`,
                `S/A/B/C/D: ${counts.S}/${counts.A}/${counts.B}/${counts.C}/${counts.D}`,
                locked ? `Кулдаун до: **${formatTime(u.lockUntil)}**` : "Можно отправлять оценку: **да**"
              ].join("\n")
            )
            .setImage("attachment://my-tierlist.png");

          return interaction.editReply({ embeds: [emb], files: [attachment] });
        }

        const lines = [
          `Main: **${main}**`,
          "Ты ещё не отправлял тир-лист.",
          locked ? `Кулдаун до: **${formatTime(u.lockUntil)}**` : "Можно отправлять оценку: **да**"
        ];
        return interaction.reply({ content: lines.join("\n"), ephemeral: true });
      }


      // Panel controls (mods) - works in /panel window, not in pinned dashboard
      if (interaction.customId.startsWith("panel_")) {
        if (!isModerator(interaction)) return interaction.reply({ content: "Нет прав.", ephemeral: true });
        const userId = interaction.user.id;

        const uPanel = getUser(userId);

        // Tabs
        if (interaction.customId === "panel_tab_config") {
          uPanel.panelTab = "config";
          uPanel.panelParticipantId = null;
          saveState(state);
          return interaction.update(buildPanelPayload(userId));
        }
        if (interaction.customId === "panel_tab_participants") {
          uPanel.panelTab = "participants";
          uPanel.panelParticipantId = null;
          uPanel.panelParticipantsPage = 0;
          saveState(state);
          return interaction.update(buildPanelPayload(userId));
        }

        // Participants navigation
        if (interaction.customId === "panel_part_prev") {
          uPanel.panelTab = "participants";
          uPanel.panelParticipantId = null;
          uPanel.panelParticipantsPage = Math.max(0, (Number(uPanel.panelParticipantsPage) || 0) - 1);
          saveState(state);
          return interaction.update(buildPanelPayload(userId));
        }
        if (interaction.customId === "panel_part_next") {
          uPanel.panelTab = "participants";
          uPanel.panelParticipantId = null;
          uPanel.panelParticipantsPage = (Number(uPanel.panelParticipantsPage) || 0) + 1;
          saveState(state);
          return interaction.update(buildPanelPayload(userId));
        }
        if (interaction.customId === "panel_part_refresh") {
          uPanel.panelTab = "participants";
          saveState(state);
          return interaction.update(buildPanelPayload(userId));
        }
        if (interaction.customId === "panel_part_back") {
          uPanel.panelTab = "participants";
          uPanel.panelParticipantId = null;
          uPanel.panelDeleteTargetId = null;
          uPanel.panelDeleteMode = null;
          saveState(state);
          return interaction.update(buildPanelPayload(userId));
        }

        // Step 5: View user's tierlist as PNG (same settings as main)
        if (interaction.customId === "panel_part_view_png") {
          const targetId = uPanel.panelParticipantId;
          const votes = targetId ? state.finalVotes?.[targetId] : null;
          if (!targetId || !votes || Object.keys(votes).length === 0) {
            return interaction.reply({ content: "У этого пользователя нет сохранённого тир-листа.", ephemeral: true });
          }

          await interaction.deferReply({ ephemeral: true });
          const png = await renderUserFinalTierlistPng(targetId, "(его тир-лист)");
          const attachment = new AttachmentBuilder(png, { name: "user-tierlist.png" });

          const emb = new EmbedBuilder()
            .setTitle("Tierlist пользователя")
            .setDescription(`<@${targetId}>`)
            .setImage("attachment://user-tierlist.png");

          return interaction.editReply({ embeds: [emb], files: [attachment] });
        }

        // Step 6: Delete actions with confirm (safe delete vs full reset)
        if (interaction.customId === "panel_part_delete_votes") {
          const targetId = uPanel.panelParticipantId;
          if (!targetId) return interaction.reply({ content: "Не выбран участник.", ephemeral: true });

          uPanel.panelDeleteTargetId = targetId;
          uPanel.panelDeleteMode = "votes";
          saveState(state);
          return interaction.update(buildPanelPayload(userId));
        }

        if (interaction.customId === "panel_part_delete_full") {
          const targetId = uPanel.panelParticipantId;
          if (!targetId) return interaction.reply({ content: "Не выбран участник.", ephemeral: true });

          uPanel.panelDeleteTargetId = targetId;
          uPanel.panelDeleteMode = "full";
          saveState(state);
          return interaction.update(buildPanelPayload(userId));
        }

        if (interaction.customId === "panel_part_cancel_delete") {
          uPanel.panelDeleteTargetId = null;
          uPanel.panelDeleteMode = null;
          saveState(state);
          return interaction.update(buildPanelPayload(userId));
        }

        if (interaction.customId === "panel_part_confirm_delete") {
          const targetId = uPanel.panelDeleteTargetId;
          const mode = uPanel.panelDeleteMode;

          if (!targetId || !mode) {
            return interaction.reply({ content: "Нечего подтверждать.", ephemeral: true });
          }

          // perform deletion
          if (mode === "votes") {
            delete state.finalVotes[targetId];
          } else if (mode === "full") {
            delete state.finalVotes[targetId];
            delete state.draftVotes[targetId];
            delete state.users[targetId];
          }

          // clear pending + go back to list
          uPanel.panelDeleteTargetId = null;
          uPanel.panelDeleteMode = null;
          uPanel.panelParticipantId = null;
          saveState(state);

          await interaction.deferUpdate();
          await refreshDashboard(client);
          return interaction.editReply(buildPanelPayload(userId));
        }


        if (interaction.customId === "panel_close") {
          return interaction.update({ content: "Ок.", embeds: [], components: [] });
        }

        if (interaction.customId === "panel_refresh") {
          await interaction.deferUpdate();
          await refreshDashboard(client);
          return interaction.editReply(buildPanelPayload(userId));
        }

        if (interaction.customId === "panel_icon_minus" || interaction.customId === "panel_icon_plus") {
          const step = 12;
          applyImageDelta("icon", interaction.customId === "panel_icon_plus" ? step : -step);
          saveState(state);
          await interaction.deferUpdate();
          await refreshDashboard(client);
          return interaction.editReply(buildPanelPayload(userId));
        }

        if (interaction.customId === "panel_w_minus" || interaction.customId === "panel_w_plus") {
          const step = 200;
          applyImageDelta("width", interaction.customId === "panel_w_plus" ? step : -step);
          saveState(state);
          await interaction.deferUpdate();
          await refreshDashboard(client);
          return interaction.editReply(buildPanelPayload(userId));
        }

        if (interaction.customId === "panel_h_minus" || interaction.customId === "panel_h_plus") {
          const step = 120;
          applyImageDelta("height", interaction.customId === "panel_h_plus" ? step : -step);
          saveState(state);
          await interaction.deferUpdate();
          await refreshDashboard(client);
          return interaction.editReply(buildPanelPayload(userId));
        }

        if (interaction.customId === "panel_reset_img") {
          resetImageOverrides();
          saveState(state);
          await interaction.deferUpdate();
          await refreshDashboard(client);
          return interaction.editReply(buildPanelPayload(userId));
        }

        if (interaction.customId === "panel_fonts") {
          tryRegisterFonts();
          const files = listTtfFiles();
          const info = [
            `ttf: ${files.length ? files.map(f => path.basename(f)).join(", ") : "(none)"}`,
            `picked regular: ${FONT_INFO.regularFile ? path.basename(FONT_INFO.regularFile) : "(null)"}`,
            `picked bold: ${FONT_INFO.boldFile ? path.basename(FONT_INFO.boldFile) : "(null)"}`,
            `fallback: ${FONT_INFO.usedFallback}`
          ].join("\n");
          return interaction.reply({ content: info, ephemeral: true });
        }

        if (interaction.customId === "panel_rename") {
          const tierKey = getUser(userId).panelTierKey || "S";
          const currentName = state.tiers?.[tierKey]?.name || tierKey;

          const modal = new ModalBuilder()
            .setCustomId(`panel_rename_modal:${tierKey}`)
            .setTitle(`Переименовать тир ${tierKey}`);

          const input = new TextInputBuilder()
            .setCustomId("tier_name")
            .setLabel("Новое название (на картинке)")
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(24)
            .setValue(String(currentName).slice(0, 24));

          modal.addComponents(new ActionRowBuilder().addComponents(input));
          return interaction.showModal(modal);
        }

        return interaction.reply({ content: "Неизвестная кнопка панели.", ephemeral: true });
      }


      if (interaction.customId === "start_rating") {
        if (isLocked(userId)) {
          return interaction.reply({
            content: `Ты уже отправлял оценки. Следующая попытка после **${formatTime(u.lockUntil)}**.`,
            ephemeral: true
          });
        }

        // resume wizard if started
        if (u.mainId && u.wizQueue && !wizardDone(userId)) {
          const payload = await buildWizardPayload(userId);
          return interaction.reply({ ...payload, ephemeral: true });
        }

        const embed = buildStartEmbed(userId);
        const rows = [...buildMainSelectRows(userId), buildStartButtons(userId)];
        return interaction.reply({ embeds: [embed], components: rows, ephemeral: true });
      }

      if (interaction.customId === "rate_new_characters") {
        if (!hasSubmittedTierlist(userId)) {
          return interaction.reply({
            content: "Сначала отправь обычный тир-лист через кнопку **Начать оценку**.",
            ephemeral: true
          });
        }

        if (u.wizMode === "new" && u.mainId && u.wizQueue && !wizardDone(userId)) {
          const payload = await buildWizardPayload(userId);
          return interaction.reply({ ...payload, ephemeral: true });
        }

        if (u.wizMode === "full" && u.mainId && u.wizQueue && !wizardDone(userId)) {
          return interaction.reply({
            content: "У тебя уже идёт обычная оценка. Сначала закончи её или закрой текущее окно.",
            ephemeral: true
          });
        }

        const pendingIds = getPendingNewCharacterIds(userId);
        if (pendingIds.length === 0) {
          return interaction.reply({
            content: "Новых персонажей для дооценки пока нет.",
            ephemeral: true
          });
        }

        startWizard(userId, "new");
        saveState(state);

        const payload = await buildWizardPayload(userId);
        return interaction.reply({ ...payload, ephemeral: true });
      }

      if (interaction.customId === "main_page_prev" || interaction.customId === "main_page_next") {
        if (isLocked(userId)) return interaction.reply({ content: `Заблокировано до **${formatTime(u.lockUntil)}**.`, ephemeral: true });

        u.mainSelectPage = clampMainSelectPage((u.mainSelectPage || 0) + (interaction.customId === "main_page_next" ? 1 : -1));
        saveState(state);

        const embed = buildStartEmbed(userId);
        const rows = [...buildMainSelectRows(userId), buildStartButtons(userId)];
        return interaction.update({ embeds: [embed], components: rows });
      }

      if (interaction.customId === "wiz_use_current_main") {
        if (isLocked(userId)) return interaction.reply({ content: `Заблокировано до **${formatTime(u.lockUntil)}**.`, ephemeral: true });
        if (!u.mainId) return interaction.reply({ content: "Сначала выбери main.", ephemeral: true });

        startWizard(userId, "full");
        saveState(state);

        await interaction.deferUpdate();
        const payload = await buildWizardPayload(userId);
        return interaction.editReply(payload);
      }

      if (interaction.customId === "wiz_cancel") {
        return interaction.update({ content: "Ок.", embeds: [], components: [], files: [], attachments: [] });
      }

      if (interaction.customId === "wiz_back") {
        if (!canUseCurrentWizard(userId)) return interaction.reply({ content: `Заблокировано до **${formatTime(u.lockUntil)}**.`, ephemeral: true });
        if (!u.wizQueue) return interaction.reply({ content: "Сначала нажми начать оценку.", ephemeral: true });

        wizardBack(userId);
        saveState(state);

        await interaction.deferUpdate();
        const payload = await buildWizardPayload(userId);
        return interaction.editReply(payload);
      }

      if (interaction.customId.startsWith("wiz_rate_")) {
        if (!canUseCurrentWizard(userId)) return interaction.reply({ content: `Заблокировано до **${formatTime(u.lockUntil)}**.`, ephemeral: true });
        if (!u.mainId || !u.wizQueue) return interaction.reply({ content: "Сначала выбери main.", ephemeral: true });
        if (wizardDone(userId)) return interaction.reply({ content: "Уже всё оценено. Нажми Отправить.", ephemeral: true });

        const tierKey = interaction.customId.replace("wiz_rate_", "");
        const cid = currentWizardChar(userId);
        if (!cid) return interaction.reply({ content: "Не удалось определить персонажа.", ephemeral: true });

        setDraftTier(userId, cid, tierKey);
        wizardNext(userId);
        saveState(state);

        await interaction.deferUpdate();
        const payload = await buildWizardPayload(userId);
        return interaction.editReply(payload);
      }

      if (interaction.customId === "wiz_submit") {
        if (!canUseCurrentWizard(userId)) return interaction.reply({ content: `Заблокировано до **${formatTime(u.lockUntil)}**.`, ephemeral: true });
        if (!u.mainId || !u.wizQueue) return interaction.reply({ content: "Сначала выбери main.", ephemeral: true });
        if (!wizardDone(userId)) return interaction.reply({ content: "Сначала оцени всех персонажей.", ephemeral: true });

        await interaction.deferUpdate();

        submitWizardVotes(userId);

        // store influence multiplier based on tier roles at submit time
        const inf = resolveInfluenceFromMember(interaction.member);
        u.influenceMultiplier = inf.mult;
        u.influenceRoleId = inf.roleId;
        u.influenceUpdatedAt = Date.now();

        const submittedMode = u.wizMode;
        u.lastSubmitAt = Date.now();
        if (submittedMode !== "new") {
          lockUser(userId);
        }
        const nextAllowedAt = getUser(userId).lockUntil;
        u.wizQueue = null;
        u.wizIndex = 0;
        u.wizMode = null;
        saveState(state);

        await refreshDashboard(client);

        const doneMsg = new EmbedBuilder()
          .setTitle("Готово")
          .setDescription(
            submittedMode === "new"
              ? "Новые персонажи дооценены. Твой прошлый тир-лист сохранён и обновлён."
              : `Оценки сохранены. Следующая попытка после **${formatTime(nextAllowedAt)}**.`
          );

        return interaction.editReply({ embeds: [doneMsg], components: [], files: [], attachments: [] });
      }
    }

    // ---------------- SELECT MENUS ----------------
    if (interaction.isStringSelectMenu()) {
      const userId = interaction.user.id;
      const u = getUser(userId);
if (interaction.customId === "panel_select_tier") {
        if (!isModerator(interaction)) return interaction.reply({ content: "Нет прав.", ephemeral: true });
        const tier = interaction.values[0];
        u.panelTierKey = tier;
        saveState(state);
        return interaction.update(buildPanelPayload(userId));
      }


      if (interaction.customId === "panel_part_select_user") {
        if (!isModerator(interaction)) return interaction.reply({ content: "Нет прав.", ephemeral: true });
        const targetId = interaction.values[0];
        u.panelTab = "participants";
        u.panelParticipantId = targetId;
        u.panelDeleteTargetId = null;
        u.panelDeleteMode = null;
        saveState(state);
        return interaction.update(buildPanelPayload(userId));
      }

      if (interaction.customId === "select_main") {
        if (isLocked(userId)) return interaction.reply({ content: `Заблокировано до **${formatTime(u.lockUntil)}**.`, ephemeral: true });

        const mainId = interaction.values[0];
        setMain(userId, mainId);
        startWizard(userId, "full");
        saveState(state);

        await interaction.deferUpdate();
        const payload = await buildWizardPayload(userId);
        return interaction.editReply(payload);
      }
    }
  } catch (e) {
    console.error(e);
    if (interaction.isRepliable()) {
      return safeRespond(interaction, { content: `Ошибка: ${e?.message || "unknown"}`, ephemeral: true });
    }
  }
});

process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e));

client.login(DISCORD_TOKEN);
