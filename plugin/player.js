// 状态管理
let lessonsMap = new Map(); // folderPath -> { folderPath, name, dirHandle, mp3Files, txtFiles, srtFiles, jsonFiles }
let currentLessonFolderPath = null;
let subtitles = []; // [{ index, start, end, en, zh, warn? }]
let currentUnits = []; // 中英对齐后的单元 [{ en, zh, paraEnd, warn, extraBreaks }]
let currentEnSents = [];
let currentZhSents = [];
let currentRawTimedItems = []; // Whisper .srt 或带时间戳 .txt 解析出的原始时间轴条目
let splitMode = "sentence"; // "sentence" (按句，先锁回车段落) | "paragraph" (纯按回车符一段一句)
let currentIndex = 0;
let playState = "stopped"; // "stopped" | "playing" | "paused"
let showEn = true;
let showZh = true;
let stampMode = false;
let currentAudioObjectUrl = null;
let currentAudioFile = null;
let rafId = null;

// DOM 引用
const selectDirBtn = document.getElementById("selectDirBtn");
const dirInput = document.getElementById("dirInput");
const selectFilesBtn = document.getElementById("selectFilesBtn");
const filesInput = document.getElementById("filesInput");
const lessonSelectWrap = document.getElementById("lessonSelectWrap");
const lessonSelect = document.getElementById("lessonSelect");
const statusBadge = document.getElementById("statusBadge");
const toggleSplitModeBtn = document.getElementById("toggleSplitModeBtn");
const toggleStampModeBtn = document.getElementById("toggleStampModeBtn");
const stampToolbar = document.getElementById("stampToolbar");
const stampStartBtn = document.getElementById("stampStartBtn");
const stampEndNextBtn = document.getElementById("stampEndNextBtn");
const autoAlignBtn = document.getElementById("autoAlignBtn");
const exportSrtBtn = document.getElementById("exportSrtBtn");
const exportJsonBtn = document.getElementById("exportJsonBtn");

const currentSentenceIndexEl = document.getElementById("currentSentenceIndex");
const currentSentenceTimeEl = document.getElementById("currentSentenceTime");
const stageEn = document.getElementById("stageEn");
const stageZh = document.getElementById("stageZh");
const subtitleList = document.getElementById("subtitleList");

const audioPlayer = document.getElementById("audioPlayer");
const currentTimeLabel = document.getElementById("currentTimeLabel");
const durationLabel = document.getElementById("durationLabel");
const progressBar = document.getElementById("progressBar");

const playStateDot = document.getElementById("playStateDot");
const playStateText = document.getElementById("playStateText");

const prevBtn = document.getElementById("prevBtn");
const playBtn = document.getElementById("playBtn");
const pauseBtn = document.getElementById("pauseBtn");
const resumeBtn = document.getElementById("resumeBtn");
const stopBtn = document.getElementById("stopBtn");
const nextBtn = document.getElementById("nextBtn");

const toggleEnBtn = document.getElementById("toggleEnBtn");
const toggleZhBtn = document.getElementById("toggleZhBtn");

// ================== IndexedDB 记住上次选择的目录句柄 ==================
const DB_NAME = "EnglishLearnPluginDB";
const STORE_NAME = "handles";

function openHandleDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveLastDirHandle(dirHandle) {
  try {
    const db = await openHandleDB();
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(dirHandle, "lastDir");
  } catch (e) {
    console.warn("无法缓存目录句柄:", e);
  }
}

async function getLastDirHandle() {
  try {
    const db = await openHandleDB();
    return await new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const req = tx.objectStore(STORE_NAME).get("lastDir");
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

// 工具函数：判断文本是否为中文
function isChineseText(text) {
  const matches = text.match(/[\u4e00-\u9fff]/g);
  const zhCount = matches ? matches.length : 0;
  return zhCount > text.length * 0.08;
}

// 工具函数：格式化 mm:ss
function formatShortTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return "00:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

// 工具函数：格式化 mm:ss.xx
function formatPreciseTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return "00:00.00";
  const m = Math.floor(sec / 60);
  const s = (sec % 60).toFixed(2).padStart(5, "0");
  return `${String(m).padStart(2, "0")}:${s}`;
}

// 工具函数：格式化 SRT 时间 00:00:01,360
function formatSrtTime(seconds) {
  const ms = Math.round((seconds - Math.floor(seconds)) * 1000);
  const totalSec = Math.floor(seconds);
  const s = totalSec % 60;
  const m = Math.floor(totalSec / 60) % 60;
  const h = Math.floor(totalSec / 3600);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

// 解析时间字符串（支持 00:00:03,020 / 00:03.02 / 0:03 等格式） -> 秒
function parseSrtTimestamp(ts) {
  const s = ts.trim();
  const m3 = s.match(/(\d+):(\d+):(\d+)(?:[,.](\d+))?/);
  if (m3) {
    return (
      parseInt(m3[1], 10) * 3600 +
      parseInt(m3[2], 10) * 60 +
      parseInt(m3[3], 10) +
      (m3[4] ? parseInt(m3[4].padEnd(3, "0").slice(0, 3), 10) / 1000 : 0)
    );
  }
  const m2 = s.match(/(\d+):(\d+)(?:[,.](\d+))?/);
  if (m2) {
    return (
      parseInt(m2[1], 10) * 60 +
      parseInt(m2[2], 10) +
      (m2[3] ? parseInt(m2[3].padEnd(3, "0").slice(0, 3), 10) / 1000 : 0)
    );
  }
  return 0;
}

// 解析带时间戳的 Whisper TXT（如 [00:03.02 --> 00:07.26] Text 或 [00:03.02 - 00:07.26] Text）
function parseTimestampedTxtContent(txt) {
  const items = [];
  const lines = txt.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(
      /^\[?\s*(\d+:\d+(?::\d+)?(?:[,.]\d+)?)\s*(?:-->|->|-|—)\s*(\d+:\d+(?::\d+)?(?:[,.]\d+)?)\s*\]?\s*(.+)$/
    );
    if (!m) continue;
    const start = Number(parseSrtTimestamp(m[1]).toFixed(2));
    const end = Number(parseSrtTimestamp(m[2]).toFixed(2));
    const text = m[3].trim();
    if (!text) continue;
    items.push({
      index: items.length + 1,
      start,
      end,
      en: isChineseText(text) ? "" : text,
      zh: isChineseText(text) ? text : ""
    });
  }
  return items;
}

// 解析标准 .srt 字幕文件
function parseSrtContent(srtText) {
  const blocks = srtText.replace(/\r\n/g, "\n").trim().split(/\n\s*\n/);
  const items = [];
  for (const block of blocks) {
    const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length < 2) continue;
    let timeLineIdx = lines[0].includes("-->") ? 0 : 1;
    if (!lines[timeLineIdx] || !lines[timeLineIdx].includes("-->")) continue;
    const [startStr, endStr] = lines[timeLineIdx].split("-->");
    const start = Number(parseSrtTimestamp(startStr).toFixed(2));
    const end = Number(parseSrtTimestamp(endStr).toFixed(2));
    const textLines = lines.slice(timeLineIdx + 1);
    let en = "";
    let zh = "";
    for (const tl of textLines) {
      const cleanLine = tl.replace(/\*\*/g, "").trim();
      if (isChineseText(cleanLine)) {
        zh = zh ? `${zh} ${cleanLine}` : cleanLine;
      } else {
        en = en ? `${en} ${cleanLine}` : cleanLine;
      }
    }
    items.push({
      index: items.length + 1,
      start,
      end,
      en,
      zh
    });
  }
  return items;
}

// 清理 Markdown 语法符号（标题 #、加粗 **、引用 >、列表 - 等）
function cleanMarkdownLine(rawLine) {
  return rawLine
    .replace(/^\s*#{1,6}\s+/, "")
    .replace(/^\s*>\s+/, "")
    .replace(/^\s*[-*+]\s+/, "")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/__(.*?)__/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\*\*/g, "")
    .trim();
}

// 按自然句切分英文文本（支持 .txt 与 .md，保护 6.7 等小数点，自动识别 RAZ 常见无标点引导词）
// 返回 [{ text, line, paraId, paraEnd }]，paraId 为按回车符切分的段落序号（从 1 开始）
function splitEnglishSentences(text) {
  const result = [];
  let paraId = 0;
  text.split(/\r?\n/).forEach((rawLine, lineIdx) => {
    let line = cleanMarkdownLine(rawLine);
    if (!line) return;
    // 自动在 Focus Question / Math Moment / Be a Scientist / Beyond the Book 后补齐漏掉的句号
    line = line.replace(
      /\b([Ff]ocus\s+[Qq]uestion|[Mm]ath\s+[Mm]oment|[Bb]e\s+a\s+[Ss]cientist|[Bb]eyond\s+the\s+[Bb]ook)\s+(?=[A-Z])/g,
      "$1. "
    );
    // 如果行内出现 Math moment / Beyond the book 等小标题，拆成独立回车段落（与中文分行保持一致）
    const subParas = line
      .replace(/(?<=[.?!])\s+(?=(?:[Mm]ath\s+[Mm]oment|[Bb]eyond\s+the\s+[Bb]ook|[Bb]e\s+a\s+[Ss]cientist)\b)/g, "\n")
      .split("\n");

    for (const subLine of subParas) {
      const trimmed = subLine.trim();
      if (!trimmed) continue;
      paraId += 1;
      const safeLine = trimmed.replace(/(\d)\.(\d)/g, "$1__DOT__$2");
      const rawParts = safeLine
        .split(/(?<=[.?!])\s+/)
        .map((p) => p.replace(/__DOT__/g, ".").trim())
        .filter(Boolean);

      // 合并像 "And grow." + "And grow." 这样连续重复的极短句（与中文“并且长啊，长啊，长。”和连读音频保持一致）
      const parts = [];
      for (const p of rawParts) {
        if (parts.length > 0 && p.length <= 12 && p.toLowerCase() === parts[parts.length - 1].toLowerCase()) {
          parts[parts.length - 1] = `${parts[parts.length - 1]} ${p}`;
        } else {
          parts.push(p);
        }
      }

      parts.forEach((p, idx) => {
        result.push({ text: p, line: lineIdx + 1, paraId, paraEnd: idx === parts.length - 1 });
      });
    }
  });
  return result;
}

// 按自然句切分中文文本（支持 .txt 与 .md）
// 注意：普通冒号（如“作者：”）不作为切句符，只有行首的“聚焦问题：”、“数学时刻：”才切分
// 返回 [{ text, line, paraId, paraEnd }]
function splitChineseSentences(text) {
  const result = [];
  let paraId = 0;
  text.split(/\r?\n/).forEach((rawLine, lineIdx) => {
    let line = cleanMarkdownLine(rawLine);
    if (!line) return;
    paraId += 1;
    line = line.replace(/^(聚焦问题|数学时刻)[：:]\s*/, "$1：|");
    const parts = [];
    for (const sub of line.split("|")) {
      if (!sub.trim()) continue;
      const matches = sub.match(/[^。？！]+(?:(?:\d+\.\d+)[^。？！]*)*(?:[。？！]+|$)/g) || [];
      for (const m of matches) {
        if (m.trim()) parts.push(m.trim());
      }
    }
    parts.forEach((p, idx) => {
      result.push({ text: p, line: lineIdx + 1, paraId, paraEnd: idx === parts.length - 1 });
    });
  });
  return result;
}

function textLen(text) {
  // 去掉括号里的英文原名注释（如（Rhonda Lucas Donald）），避免中文字数被虚高
  const cleaned = text.replace(/[（(][A-Za-z0-9\s.,'-]+[)）]/g, "");
  return Math.max(1, cleaned.replace(/\s+/g, "").length);
}

// 提取文本中的阿拉伯数字（去掉千分位逗号），用作中英对齐的锚点
function extractNumbers(text) {
  return text.replace(/(?<=\d),(?=\d{3})/g, "").match(/\d+(?:\.\d+)?/g) || [];
}

const NON_END_WORDS = new Set([
  "a", "an", "the", "of", "in", "on", "at", "to", "for", "with", "by", "from",
  "into", "under", "over", "through", "after", "before", "between", "and", "or",
  "but", "so", "as", "if", "than", "that", "this", "these", "those", "my", "your",
  "his", "her", "its", "our", "their", "some", "many", "few", "more", "most",
  "very", "too", "not", "no", "can", "will", "may", "might", "must", "should",
  "would", "could", "is", "are", "was", "were", "be", "been", "have", "has", "had",
  "do", "does", "did", "keep", "keeps", "help", "helps", "make", "makes", "look",
  "looks", "feel", "feels", "live", "lives", "eat", "eats", "grow", "grows"
]);

const SENT_STARTERS = new Set([
  "why", "how", "what", "when", "where", "who", "which",
  "the", "they", "it", "this", "these", "there", "then", "now", "later", "after",
  "in", "on", "for", "one", "some", "many", "few", "most", "all"
]);

// 当 1 句英文对应多句中文（英文漏了句号）时，根据中文长度比例与英文大写/句首词边界自动补句号拆开
function autoSplitEnByZh(enStr, zhList) {
  if (zhList.length <= 1) return [enStr];
  const zhLens = zhList.map((z) => Math.max(1, textLen(z)));
  const totalZh = zhLens.reduce((a, b) => a + b, 0);
  const frac = zhLens[0] / totalZh;
  const totalLen = enStr.length;
  const targetPos = frac * totalLen;

  let bestScore = 1e9;
  let bestSplit = null;

  const re = /\s+/g;
  let m;
  while ((m = re.exec(enStr)) !== null) {
    const pos = m.index;
    const nextPos = pos + m[0].length;
    if (pos < 2 || nextPos >= totalLen - 2) continue;

    const leftPart = enStr.slice(0, pos).trim();
    const rightPart = enStr.slice(nextPos).trim();
    const prevM = leftPart.match(/([A-Za-z0-9']+)[,;:]*$/);
    const nextM = rightPart.match(/^([A-Za-z0-9']+)/);
    if (!prevM || !nextM) continue;

    const prevWord = prevM[1];
    const nextWord = nextM[1];

    const distCost = Math.abs(pos - targetPos) / Math.max(1, totalLen);
    let bonus = 0.0;
    const lastCh = leftPart[leftPart.length - 1];
    if (lastCh === "," || lastCh === ";" || lastCh === ":") {
      bonus -= 0.15;
    }
    if (nextWord[0] >= "A" && nextWord[0] <= "Z") {
      bonus -= 0.45;
    } else if (SENT_STARTERS.has(nextWord.toLowerCase())) {
      bonus -= 0.25;
    }
    if (NON_END_WORDS.has(prevWord.toLowerCase())) {
      bonus += 0.65;
    }

    const score = distCost + bonus;
    if (score < bestScore) {
      bestScore = score;
      bestSplit = [leftPart, rightPart];
    }
  }

  if (!bestSplit) return [enStr];

  let [leftS, rightS] = bestSplit;
  const lastCh = leftS[leftS.length - 1];
  if (lastCh === "," || lastCh === ";" || lastCh === ":") {
    leftS = `${leftS.slice(0, -1)}.`;
  } else if (lastCh !== "." && lastCh !== "?" && lastCh !== "!") {
    leftS = `${leftS}.`;
  }

  if (rightS && rightS[0] >= "a" && rightS[0] <= "z") {
    rightS = rightS[0].toUpperCase() + rightS.slice(1);
  }

  return [leftS, ...autoSplitEnByZh(rightS, zhList.slice(1))];
}

// 当多句英文对应 1 句中文（中文用逗号合句或漏了句号）时，按英文长度比例在逗号/空格处自动拆开
function autoSplitZhByEn(zhStr, enList) {
  if (enList.length <= 1) return [zhStr];
  const enLens = enList.map((e) => Math.max(1, textLen(e)));
  const totalEn = enLens.reduce((a, b) => a + b, 0);
  const frac = enLens[0] / totalEn;
  const totalLen = zhStr.length;
  const targetPos = frac * totalLen;

  let bestScore = 1e9;
  let bestSplit = null;
  const re = /[，,；;\s]+/g;
  let m;
  while ((m = re.exec(zhStr)) !== null) {
    const pos = m.index;
    const nextPos = pos + m[0].length;
    if (pos < 1 || nextPos >= totalLen - 1) continue;
    const distCost = Math.abs(pos - targetPos) / Math.max(1, totalLen);
    if (distCost < bestScore) {
      bestScore = distCost;
      bestSplit = [`${zhStr.slice(0, pos).trim()}。`, zhStr.slice(nextPos).trim()];
    }
  }

  if (!bestSplit) return [zhStr];
  const [leftZ, rightZ] = bestSplit;
  return [leftZ, ...autoSplitZhByEn(rightZ, enList.slice(1))];
}

// 中英句子组合方式及其惩罚：[英文句数, 中文句数, 额外代价]
const BEAD_TYPES = [
  [1, 1, 0.0],
  [1, 2, 2.5],
  [2, 1, 2.5],
  [1, 3, 5.0],
  [3, 1, 5.0],
  [1, 0, 6.0],
  [0, 1, 6.0]
];

// 对单个段落或全局的英中句子列表做动态规划对齐
function alignBilingualBlock(enSents, zhSents, ratio) {
  if (zhSents.length === 0) {
    return enSents.map((e) => ({ en: e.text, zh: "", paraEnd: e.paraEnd, warn: "", extraBreaks: 0 }));
  }
  if (enSents.length === 0) {
    return zhSents.map((z) => ({ en: "", zh: z.text, paraEnd: z.paraEnd, warn: "", extraBreaks: 0 }));
  }

  const enLen = enSents.map((e) => textLen(e.text));
  const zhLen = zhSents.map((z) => textLen(z.text));
  const enNums = enSents.map((e) => extractNumbers(e.text));
  const zhNums = zhSents.map((z) => extractNumbers(z.text));

  const N = enSents.length;
  const K = zhSents.length;
  const dp = Array.from({ length: N + 1 }, () => new Array(K + 1).fill(Infinity));
  const back = Array.from({ length: N + 1 }, () => new Array(K + 1).fill(null));
  dp[0][0] = 0;

  function groupCost(i0, a, j0, b, penalty) {
    let le = 0;
    let lz = 0;
    for (let k = i0; k < i0 + a; k++) le += enLen[k];
    for (let k = j0; k < j0 + b; k++) lz += zhLen[k];
    const expected = ratio * le;
    let cost = Math.pow(lz - expected, 2) / (expected + 6.0) + penalty;

    // 一组内跨越了原文的段落（回车换行）边界，给予高额惩罚
    for (let k = i0; k < i0 + a - 1; k++) if (enSents[k].paraEnd) cost += 8.0;
    for (let k = j0; k < j0 + b - 1; k++) if (zhSents[k].paraEnd) cost += 8.0;

    // 数字锚点：两边出现的数字应该落在同一组里
    const en = new Set();
    const zh = new Set();
    for (let k = i0; k < i0 + a; k++) enNums[k].forEach((n) => en.add(n));
    for (let k = j0; k < j0 + b; k++) zhNums[k].forEach((n) => zh.add(n));
    if (en.size || zh.size) {
      let unmatched = 0;
      en.forEach((n) => { if (!zh.has(n)) unmatched++; });
      zh.forEach((n) => { if (!en.has(n)) unmatched++; });
      cost += 2.0 * Math.min(unmatched, 3);
    }

    // 段落末尾应该同时结束
    if (a && b && enSents[i0 + a - 1].paraEnd !== zhSents[j0 + b - 1].paraEnd) cost += 4.0;
    return cost;
  }

  for (let i = 0; i <= N; i++) {
    for (let j = 0; j <= K; j++) {
      if (dp[i][j] === Infinity) continue;
      for (const [a, b, penalty] of BEAD_TYPES) {
        if (i + a > N || j + b > K) continue;
        const c = dp[i][j] + groupCost(i, a, j, b, penalty);
        if (c < dp[i + a][j + b]) {
          dp[i + a][j + b] = c;
          back[i + a][j + b] = [a, b];
        }
      }
    }
  }

  const units = [];
  let i = N;
  let j = K;
  while (i > 0 || j > 0) {
    const [a, b] = back[i][j];
    const ens = enSents.slice(i - a, i);
    const zhs = zhSents.slice(j - b, j);

    // 情况 1: 1 句英文对应多句中文（英文漏了句号） -> 直接自动补句号拆成 b 句
    if (a === 1 && b >= 2) {
      const splitEns = autoSplitEnByZh(
        ens[0].text,
        zhs.map((z) => z.text)
      );
      if (splitEns.length === b) {
        for (let idx = b - 1; idx >= 0; idx--) {
          units.push({
            en: splitEns[idx],
            zh: zhs[idx].text,
            paraEnd: idx === b - 1 ? ens[0].paraEnd : false,
            warn: "",
            extraBreaks: 0
          });
        }
        i -= a;
        j -= b;
        continue;
      }
    }

    // 情况 2: 多句英文对应 1 句中文（中文用逗号合句或漏了句号） -> 自动在逗号/空格处拆成 a 句
    if (a >= 2 && b === 1) {
      const splitZhs = autoSplitZhByEn(
        zhs[0].text,
        ens.map((e) => e.text)
      );
      if (splitZhs.length === a) {
        for (let idx = a - 1; idx >= 0; idx--) {
          units.push({
            en: ens[idx].text,
            zh: splitZhs[idx],
            paraEnd: ens[idx].paraEnd,
            warn: "",
            extraBreaks: 0
          });
        }
        i -= a;
        j -= b;
        continue;
      }
    }

    let warn = "";
    if (!(a === 1 && b === 1)) {
      const enLines = [...new Set(ens.map((e) => e.line))];
      const zhLines = [...new Set(zhs.map((z) => z.line))];
      warn =
        `英文 ${a} 句 ↔ 中文 ${b} 句` +
        (enLines.length ? `（英文第 ${enLines.join(",")} 行` : "（英文无对应") +
        (zhLines.length ? `，中文第 ${zhLines.join(",")} 行）` : "，中文无对应）") +
        "，可能漏了标点";
    }
    units.push({
      en: ens.map((e) => e.text).join(" "),
      zh: zhs.map((z) => z.text).join(""),
      paraEnd: ens.length ? ens[ens.length - 1].paraEnd : zhs[zhs.length - 1].paraEnd,
      warn,
      extraBreaks: Math.max(a, b) - 1
    });
    i -= a;
    j -= b;
  }
  units.reverse();
  return units;
}

// 中英双语句子对齐（优先按回车符锁定段落边界，段内再按句对齐）
function alignBilingual(enSents, zhSents) {
  if (zhSents.length === 0) {
    return enSents.map((e) => ({ en: e.text, zh: "", paraEnd: e.paraEnd, warn: "", extraBreaks: 0 }));
  }
  if (enSents.length === 0) {
    return zhSents.map((z) => ({ en: "", zh: z.text, paraEnd: z.paraEnd, warn: "", extraBreaks: 0 }));
  }

  const totalEnLen = enSents.reduce((acc, e) => acc + textLen(e.text), 0);
  const totalZhLen = zhSents.reduce((acc, z) => acc + textLen(z.text), 0);
  const ratio = totalZhLen / Math.max(1, totalEnLen);

  const enMaxPara = enSents[enSents.length - 1].paraId || 0;
  const zhMaxPara = zhSents[zhSents.length - 1].paraId || 0;

  // 当英中非空段落数一致（回车符一一对应）时，严格在每个回车段落内部独立对齐，绝不跨段串行
  if (enMaxPara > 0 && enMaxPara === zhMaxPara) {
    const units = [];
    for (let pid = 1; pid <= enMaxPara; pid++) {
      const enP = enSents.filter((e) => e.paraId === pid);
      const zhP = zhSents.filter((z) => z.paraId === pid);
      units.push(...alignBilingualBlock(enP, zhP, ratio));
    }
    return units;
  }

  return alignBilingualBlock(enSents, zhSents, ratio);
}

// 将 Whisper 导出的单语英文 SRT（或带时间戳 TXT）整理并与中文句子智能对齐，100% 保留 Whisper 原生时间戳
function alignWhisperSrtWithChinese(rawSrtItems, zhSents, mode = "sentence") {
  if (!rawSrtItems || rawSrtItems.length === 0) return [];
  const hasZhAlready = rawSrtItems.some((it) => it.zh && it.zh.trim().length > 0);
  if (hasZhAlready && mode === "sentence") {
    return rawSrtItems;
  }

  // 1. 合并 Whisper 在逗号处拆断的半句（末尾没有 .?! 且与下一块间隔 < 1.8s）
  const merged = [];
  for (const item of rawSrtItems) {
    const prev = merged.length > 0 ? merged[merged.length - 1] : null;
    if (
      prev &&
      !hasZhAlready &&
      !/[.?!]["'”’)]*$/.test(prev.en.trim()) &&
      item.start - prev.end < 1.8
    ) {
      prev.end = item.end;
      prev.en = `${prev.en.trim()} ${item.en.trim()}`;
    } else {
      merged.push({ ...item });
    }
  }

  // 2. 如果是“按回车(整段)”模式，将翻页长停顿（>= 1.5s）之内的句子合并为整段
  let timedEnBlocks = [];
  if (mode === "paragraph") {
    for (let i = 0; i < merged.length; i++) {
      const cur = merged[i];
      if (timedEnBlocks.length === 0) {
        timedEnBlocks.push({ ...cur, paraId: 1, paraEnd: true });
      } else {
        const last = timedEnBlocks[timedEnBlocks.length - 1];
        if (cur.start - last.end < 1.5) {
          last.end = cur.end;
          last.en = `${last.en} ${cur.en}`.trim();
          if (cur.zh) last.zh = `${last.zh}${cur.zh}`;
        } else {
          timedEnBlocks.push({
            ...cur,
            paraId: timedEnBlocks.length + 1,
            paraEnd: true
          });
        }
      }
    }
    if (hasZhAlready || zhSents.length === 0) {
      return timedEnBlocks.map((it, idx) => ({ ...it, index: idx + 1 }));
    }
    const maxP = timedEnBlocks.length;
    return timedEnBlocks.map((it, idx) => {
      const pid = idx + 1;
      const zp = zhSents.filter((z) => z.paraId === pid).map((z) => z.text);
      return {
        index: pid,
        start: Number(it.start.toFixed(2)),
        end: Number(it.end.toFixed(2)),
        en: it.en,
        zh: zp.join("") || (zhSents[idx] ? zhSents[idx].text : "")
      };
    });
  }

  // 3. 按句模式：如果 Whisper 把同页的两句话合成了一个 SRT 块，按句切开并按字符比例分配该块内部时间戳
  let paraId = 1;
  for (let i = 0; i < merged.length; i++) {
    const blk = merged[i];
    const nextBlk = i + 1 < merged.length ? merged[i + 1] : null;
    const isBlockParaEnd = !nextBlk || nextBlk.start - blk.end >= 1.5;
    const subSents = splitEnglishSentences(blk.en);
    if (subSents.length <= 1) {
      timedEnBlocks.push({
        text: blk.en,
        line: i + 1,
        paraId,
        paraEnd: isBlockParaEnd,
        start: blk.start,
        end: blk.end
      });
    } else {
      const totalChars = subSents.reduce((acc, s) => acc + Math.max(1, s.text.length), 0);
      const totalDur = Math.max(0.1, blk.end - blk.start);
      let curTime = blk.start;
      subSents.forEach((s, idx) => {
        const dur = (totalDur * Math.max(1, s.text.length)) / totalChars;
        const nextTime = idx === subSents.length - 1 ? blk.end : curTime + dur;
        timedEnBlocks.push({
          text: s.text,
          line: i + 1,
          paraId,
          paraEnd: idx === subSents.length - 1 ? isBlockParaEnd : false,
          start: Number(curTime.toFixed(2)),
          end: Number(nextTime.toFixed(2))
        });
        curTime = nextTime;
      });
    }
    if (isBlockParaEnd) paraId += 1;
  }

  if (zhSents.length === 0) {
    return timedEnBlocks.map((b, idx) => ({
      index: idx + 1,
      start: b.start,
      end: b.end,
      en: b.text,
      zh: ""
    }));
  }

  // 4. 用双语对齐将中文句子挂到带 Whisper 时间戳的英文句子上
  const alignedUnits = alignBilingual(timedEnBlocks, zhSents);
  // 若句数完全一致，直接一对一赋上 Whisper 时间戳
  if (alignedUnits.length === timedEnBlocks.length) {
    return alignedUnits.map((u, idx) => ({
      index: idx + 1,
      start: timedEnBlocks[idx].start,
      end: timedEnBlocks[idx].end,
      en: u.en,
      zh: u.zh,
      ...(u.warn ? { warn: u.warn } : {})
    }));
  }
  // 若有少量合并/拆分，按顺序映射对应的时间区间
  return alignedUnits.map((u, idx) => {
    const mappedIdx = Math.min(
      timedEnBlocks.length - 1,
      Math.floor((idx * timedEnBlocks.length) / Math.max(1, alignedUnits.length))
    );
    return {
      index: idx + 1,
      start: timedEnBlocks[mappedIdx].start,
      end: timedEnBlocks[mappedIdx].end,
      en: u.en,
      zh: u.zh,
      ...(u.warn ? { warn: u.warn } : {})
    };
  });
}

// 纯按回车符（段落）一对一对齐，每一段（绘本每一页）作为一个字幕单元
function alignParagraphsByNewline(enSents, zhSents) {
  const maxP = Math.max(
    enSents.length ? enSents[enSents.length - 1].paraId || 0 : 0,
    zhSents.length ? zhSents[zhSents.length - 1].paraId || 0 : 0
  );
  const units = [];
  for (let pid = 1; pid <= maxP; pid++) {
    const ep = enSents.filter((e) => e.paraId === pid).map((e) => e.text);
    const zp = zhSents.filter((z) => z.paraId === pid).map((z) => z.text);
    if (!ep.length && !zp.length) continue;
    units.push({
      en: ep.join(" "),
      zh: zp.join(""),
      paraEnd: true,
      warn: "",
      extraBreaks: Math.max(ep.length, zp.length) - 1
    });
  }
  return units;
}

// 使用 Web Audio API 提取音频中的人声片段，并用动态规划把人声片段对齐到双语单元
async function autoDetectTimestampsFromAudio(mp3File, units) {
  const arrayBuffer = await mp3File.arrayBuffer();
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
  const sampleRate = audioBuffer.sampleRate;
  const ch0 = audioBuffer.getChannelData(0);
  const ch1 = audioBuffer.numberOfChannels > 1 ? audioBuffer.getChannelData(1) : ch0;

  const frameSize = Math.floor(sampleRate * 0.01);
  const totalFrames = Math.floor(ch0.length / frameSize);
  const threshold = Math.pow(10, -35 / 20); // -35dB
  const minSilenceFrames = 35; // 0.35s

  const silences = [];
  let silenceStartFrame = null;

  for (let f = 0; f < totalFrames; f++) {
    let sumSq = 0;
    const offset = f * frameSize;
    for (let i = 0; i < frameSize; i++) {
      const sample = 0.5 * (ch0[offset + i] + ch1[offset + i]);
      sumSq += sample * sample;
    }
    const rms = Math.sqrt(sumSq / frameSize);
    if (rms < threshold) {
      if (silenceStartFrame === null) silenceStartFrame = f;
    } else {
      if (silenceStartFrame !== null) {
        if (f - silenceStartFrame >= minSilenceFrames) {
          silences.push([silenceStartFrame * 0.01, f * 0.01]);
        }
        silenceStartFrame = null;
      }
    }
  }
  if (silenceStartFrame !== null && totalFrames - silenceStartFrame >= minSilenceFrames) {
    silences.push([silenceStartFrame * 0.01, totalFrames * 0.01]);
  }

  await audioCtx.close();

  const chunks = [];
  if (silences.length === 0) {
    chunks.push([0, audioBuffer.duration]);
  } else {
    if (silences[0][0] > 0.2) {
      chunks.push([0, Number(silences[0][0].toFixed(2))]);
    }
    for (let i = 0; i < silences.length; i++) {
      const sEnd = silences[i][1];
      const sNext = i + 1 < silences.length ? silences[i + 1][0] : audioBuffer.duration;
      if (sNext - sEnd > 0.2) {
        chunks.push([Number(sEnd.toFixed(2)), Number(sNext.toFixed(2))]);
      }
    }
  }

  const N = units.length;
  const M = chunks.length;
  // 没有英文时用中文长度折算（中文 1 字约等于英文 3 个字符）
  const lens = units.map((u) => Math.max(1, u.en ? u.en.length : textLen(u.zh) * 3));

  const makeItem = (idx, s, e) => {
    const item = {
      index: idx + 1,
      start: Number(s.toFixed(2)),
      end: Number(e.toFixed(2)),
      en: units[idx].en,
      zh: units[idx].zh
    };
    if (units[idx].warn) item.warn = units[idx].warn;
    return item;
  };

  if (N === 0) return [];
  if (M < N) {
    const start0 = chunks.length ? chunks[0][0] : 0;
    const endAll = chunks.length ? chunks[chunks.length - 1][1] : audioBuffer.duration;
    const totalChars = lens.reduce((a, b) => a + b, 0);
    let cur = start0;
    return units.map((_, idx) => {
      const dur = ((endAll - start0) * lens[idx]) / totalChars;
      const item = makeItem(idx, cur, cur + dur);
      cur += dur;
      return item;
    });
  }

  const totalSpeech = chunks.reduce((acc, c) => acc + (c[1] - c[0]), 0);
  const secPerChar = totalSpeech / Math.max(1, lens.reduce((a, b) => a + b, 0));

  const INF = 1e18;
  const dp = Array.from({ length: N + 1 }, () => new Array(M + 1).fill(INF));
  const parent = Array.from({ length: N + 1 }, () => new Array(M + 1).fill(0));
  dp[0][0] = 0;

  for (let i = 1; i <= N; i++) {
    const isParaEnd = units[i - 1].paraEnd;
    const extraBreaks = units[i - 1].extraBreaks || 0;
    const expDur = Math.max(0.35, 0.15 + lens[i - 1] * secPerChar * 0.92);
    for (let j = i; j <= M - (N - i); j++) {
      const kMin = Math.max(i - 1, j - 16);
      for (let k = kMin; k < j; k++) {
        if (dp[i - 1][k] >= INF) continue;
        let speechDur = 0;
        for (let c = k; c < j; c++) speechDur += chunks[c][1] - chunks[c][0];
        const ratio = Math.max(speechDur / expDur, expDur / Math.max(0.1, speechDur));
        const durCost =
          Math.pow((speechDur - expDur) / 0.9, 2) + Math.pow((ratio - 1.0) * 3.5, 2);

        // 合并单元允许若干个最长的停顿不计罚分
        const gaps = [];
        for (let c = k; c < j - 1; c++) gaps.push(chunks[c + 1][0] - chunks[c][1]);
        gaps.sort((x, y) => y - x);
        let internalGapCost = 0;
        for (const gap of gaps.slice(extraBreaks)) {
          if (gap > 1.8) {
            internalGapCost += 40.0 + Math.pow((gap - 0.5) / 0.3, 2) * 2.5;
          } else if (gap > 0.75) {
            internalGapCost += Math.pow((gap - 0.5) / 0.3, 2) * 2.5;
          } else {
            internalGapCost += Math.pow(gap / 0.6, 2) * 0.5;
          }
        }

        let boundaryCost = 0;
        if (j < M) {
          const gapAfter = chunks[j][0] - chunks[j - 1][1];
          if (gapAfter < 0.75) {
            boundaryCost += Math.pow((0.75 - gapAfter) / 0.12, 2);
          }
          if (isParaEnd) {
            if (gapAfter < 1.1) {
              boundaryCost += 10.0;
            } else if (gapAfter >= 1.5) {
              boundaryCost -= 4.0;
            }
          } else if (gapAfter >= 2.0) {
            boundaryCost += 12.0;
          }
        }

        const cost = dp[i - 1][k] + durCost + internalGapCost + boundaryCost;
        if (cost < dp[i][j]) {
          dp[i][j] = cost;
          parent[i][j] = k;
        }
      }
    }
  }

  const aligned = new Array(N);
  let curr = M;
  for (let i = N; i >= 1; i--) {
    const prev = parent[i][curr];
    aligned[i - 1] = [chunks[prev][0], chunks[curr - 1][1]];
    curr = prev;
  }

  return units.map((_, idx) => makeItem(idx, aligned[idx][0], aligned[idx][1]));
}

// ================== 目录扫描与加载（优先使用 window.showDirectoryPicker） ==================
async function scanDirectoryHandle(dirHandle, parentPath = "") {
  const currentPath = parentPath ? `${parentPath}/${dirHandle.name}` : dirHandle.name;
  const group = {
    folderPath: currentPath,
    name: dirHandle.name,
    dirHandle,
    mp3Files: [],
    txtFiles: [],
    srtFiles: [],
    jsonFiles: []
  };

  const subDirs = [];
  for await (const entry of dirHandle.values()) {
    if (entry.kind === "file") {
      if (entry.name.startsWith(".")) continue;
      const lower = entry.name.toLowerCase();
      if (
        lower.endsWith(".mp3") ||
        lower.endsWith(".srt") ||
        lower.endsWith(".json") ||
        lower.endsWith(".txt") ||
        (lower.endsWith(".md") && lower !== "readme.md")
      ) {
        const file = await entry.getFile();
        if (lower.endsWith(".mp3")) group.mp3Files.push(file);
        else if (lower.endsWith(".srt")) group.srtFiles.push(file);
        else if (lower.endsWith(".json")) group.jsonFiles.push(file);
        else if (lower.endsWith(".txt") || lower.endsWith(".md")) group.txtFiles.push(file);
      }
    } else if (entry.kind === "directory" && !entry.name.startsWith(".")) {
      subDirs.push(entry);
    }
  }

  // 按文件名排序保证稳定性
  group.mp3Files.sort((a, b) => a.name.localeCompare(b.name));
  group.srtFiles.sort((a, b) => a.name.localeCompare(b.name));
  group.jsonFiles.sort((a, b) => a.name.localeCompare(b.name));
  group.txtFiles.sort((a, b) => a.name.localeCompare(b.name));

  if (group.mp3Files.length > 0) {
    lessonsMap.set(currentPath, group);
  }

  subDirs.sort((a, b) => a.name.localeCompare(b.name));
  for (const sub of subDirs) {
    await scanDirectoryHandle(sub, currentPath);
  }
}

async function applyScannedLessons() {
  if (lessonsMap.size === 0) {
    statusBadge.textContent = "⚠️ 所选目录中未找到 .mp3 文件";
    return;
  }

  lessonSelect.innerHTML = "";
  for (const [folderPath, group] of lessonsMap.entries()) {
    const opt = document.createElement("option");
    opt.value = folderPath;
    opt.textContent = `${group.name} (${group.mp3Files[0].name})`;
    lessonSelect.appendChild(opt);
  }

  if (lessonsMap.size > 1) {
    lessonSelectWrap.classList.remove("hidden");
  } else {
    lessonSelectWrap.classList.add("hidden");
  }

  const firstFolderPath = lessonsMap.keys().next().value;
  await loadLesson(firstFolderPath);
}

// 点击“选择目录 (电脑)”：桌面端使用现代 File System Access API，iOS 设备自动转为多选文件
selectDirBtn.addEventListener("click", async () => {
  const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
  if (isIOS) {
    filesInput.click();
    return;
  }
  if (typeof window.showDirectoryPicker === "function") {
    try {
      const dirHandle = await window.showDirectoryPicker({ mode: "read" });
      lessonsMap.clear();
      statusBadge.textContent = `正在扫描目录 ${dirHandle.name}...`;
      await scanDirectoryHandle(dirHandle);
      await saveLastDirHandle(dirHandle);
      await applyScannedLessons();
    } catch (err) {
      if (err && err.name !== "AbortError") {
        console.error("目录选择失败:", err);
        statusBadge.textContent = "⚠️ 目录读取失败，请重试";
      }
    }
  } else {
    dirInput.click();
  }
});

// 点击“选文件 (iPhone/iCloud)”：直接多选同一课文的 mp3 + txt/md/srt/json
selectFilesBtn.addEventListener("click", () => {
  filesInput.value = "";
  filesInput.click();
});

filesInput.addEventListener("change", async (e) => {
  const files = Array.from(e.target.files || []);
  if (files.length === 0) return;

  lessonsMap.clear();
  const group = {
    folderPath: "iCloud所选课文",
    name: "所选课文",
    dirHandle: null,
    mp3Files: [],
    txtFiles: [],
    srtFiles: [],
    jsonFiles: []
  };

  for (const file of files) {
    const lower = file.name.toLowerCase();
    if (lower.endsWith(".mp3")) {
      group.mp3Files.push(file);
      group.name = file.name.replace(/\.mp3$/i, "");
    } else if (lower.endsWith(".srt")) {
      group.srtFiles.push(file);
    } else if (lower.endsWith(".json")) {
      group.jsonFiles.push(file);
    } else if (lower.endsWith(".txt") || (lower.endsWith(".md") && lower !== "readme.md")) {
      group.txtFiles.push(file);
    }
  }

  if (group.mp3Files.length === 0) {
    statusBadge.textContent = "⚠️ 请同时勾选至少 1 个 .mp3 文件和对应的 .txt/.md 字幕文件";
    return;
  }

  lessonsMap.set(group.folderPath, group);
  await applyScannedLessons();
});

// 兼容兜底：传统 input[webkitdirectory]
dirInput.addEventListener("change", async (e) => {
  const files = Array.from(e.target.files || []);
  if (files.length === 0) return;

  lessonsMap.clear();

  for (const file of files) {
    const relPath = file.webkitRelativePath || file.name;
    const parts = relPath.split("/");
    const folderPath = parts.length > 1 ? parts.slice(0, -1).join("/") : "默认目录";
    const folderName = parts.length > 1 ? parts[parts.length - 2] : "默认目录";

    if (!lessonsMap.has(folderPath)) {
      lessonsMap.set(folderPath, {
        folderPath,
        name: folderName,
        dirHandle: null,
        mp3Files: [],
        txtFiles: [],
        srtFiles: [],
        jsonFiles: []
      });
    }

    const group = lessonsMap.get(folderPath);
    const lower = file.name.toLowerCase();
    if (lower.endsWith(".mp3")) group.mp3Files.push(file);
    else if (lower.endsWith(".srt")) group.srtFiles.push(file);
    else if (lower.endsWith(".json")) group.jsonFiles.push(file);
    else if (lower.endsWith(".txt") || (lower.endsWith(".md") && lower !== "readme.md")) group.txtFiles.push(file);
  }

  for (const [key, val] of lessonsMap.entries()) {
    if (val.mp3Files.length === 0) lessonsMap.delete(key);
  }

  await applyScannedLessons();
});

lessonSelect.addEventListener("change", async () => {
  if (lessonSelect.value) {
    await loadLesson(lessonSelect.value);
  }
});

// 加载指定目录的课程
async function loadLesson(folderPath) {
  const group = lessonsMap.get(folderPath);
  if (!group) return;

  currentLessonFolderPath = folderPath;
  stopPlayback();
  statusBadge.textContent = `正在加载 ${group.name}...`;

  const mp3File = group.mp3Files[0];
  currentAudioFile = mp3File;
  if (currentAudioObjectUrl) {
    URL.revokeObjectURL(currentAudioObjectUrl);
  }
  currentAudioObjectUrl = URL.createObjectURL(mp3File);
  audioPlayer.src = currentAudioObjectUrl;

  // 先读取中英文 txt（备用或补充）
  let enText = "";
  let zhText = "";
  for (const tf of group.txtFiles) {
    const content = await tf.text();
    if (isChineseText(content)) {
      zhText = content;
    } else {
      enText = content;
    }
  }
  const enSents = enText ? splitEnglishSentences(enText) : [];
  const zhSents = zhText ? splitChineseSentences(zhText) : [];
  currentEnSents = enSents;
  currentZhSents = zhSents;
  currentRawTimedItems = [];

  // 按当前切分模式（按句锁回车 / 纯按回车整段）生成对齐单元
  const units =
    splitMode === "paragraph"
      ? alignParagraphsByNewline(enSents, zhSents)
      : alignBilingual(enSents, zhSents);
  currentUnits = units;

  let loadedSubtitles = [];
  let sourceDesc = "";

  // 1. 优先读取 .srt 时间戳文件（支持双语 subtitles.srt，也支持 Whisper Transcription 直接导出的纯英文 .srt + 中文 .txt）
  if (group.srtFiles.length > 0) {
    const srtFile = group.srtFiles[0];
    const srtContent = await srtFile.text();
    const rawSrt = parseSrtContent(srtContent);
    currentRawTimedItems = rawSrt;
    loadedSubtitles = alignWhisperSrtWithChinese(rawSrt, zhSents, splitMode);
    sourceDesc = `已加载 Whisper/SRT 时间戳 ${srtFile.name} (${loadedSubtitles.length} 句/段)`;
  } else if (group.jsonFiles.length > 0 && (splitMode === "sentence" || units.length === 0)) {
    // 2. 其次读取 subtitles.json 时间戳文件
    const jsonFile = group.jsonFiles[0];
    try {
      const parsed = JSON.parse(await jsonFile.text());
      if (Array.isArray(parsed) && parsed.length > 0) {
        loadedSubtitles = parsed.map((it, idx) => ({
          index: idx + 1,
          start: Number(it.start) || 0,
          end: Number(it.end) || 0,
          en: it.en || (units[idx] ? units[idx].en : ""),
          zh: it.zh || (units[idx] ? units[idx].zh : ""),
          ...(it.warn ? { warn: it.warn } : {})
        }));
        sourceDesc = `已加载时间戳文件 ${jsonFile.name} (${loadedSubtitles.length} 句)`;
      }
    } catch (err) {
      console.error("解析 JSON 字幕失败:", err);
    }
  } else if (enText) {
    // 3. 检查英文 .txt 是否本身带有 Whisper 导出的时间戳（如 [00:03.02 --> 00:07.26] ...）
    const timedTxtItems = parseTimestampedTxtContent(enText);
    if (timedTxtItems.length > 0) {
      currentRawTimedItems = timedTxtItems;
      loadedSubtitles = alignWhisperSrtWithChinese(timedTxtItems, zhSents, splitMode);
      sourceDesc = `已从带时间戳的 Whisper TXT 直接加载 (${loadedSubtitles.length} 句/段)`;
    }
  }

  // 4. 如果目录里只有 mp3 + 纯文本 txt，自动分析音频波形生成时间戳
  if (loadedSubtitles.length === 0 && units.length > 0) {
    statusBadge.textContent = "⏳ 正在根据音频波形与回车段落生成时间戳...";
    loadedSubtitles = await autoDetectTimestampsFromAudio(mp3File, units);
    const modeLabel = splitMode === "paragraph" ? "按回车整段" : "按句(锁回车)";
    sourceDesc = `已从 TXT 自动对齐时间戳 [${modeLabel}] (${loadedSubtitles.length} 段/句，可点击右侧打时间戳微调并保存)`;
  }

  subtitles = loadedSubtitles;
  currentIndex = 0;

  const warnCount = subtitles.filter((s) => s.warn).length;
  if (warnCount > 0) {
    sourceDesc += `，⚠️ 有 ${warnCount} 处中英句数对不上（已标黄，可能漏了标点）`;
  }
  statusBadge.textContent = sourceDesc || `已加载音频 ${mp3File.name}`;
  if (toggleSplitModeBtn) {
    toggleSplitModeBtn.disabled =
      enSents.length === 0 && zhSents.length === 0 && currentRawTimedItems.length === 0;
  }
  toggleStampModeBtn.disabled = subtitles.length === 0;
  enableTransportControls(subtitles.length > 0);

  renderSubtitleList();
  updateStageDisplay();
}

// 切换“按句(锁回车)”与“按回车(整段)”对齐模式
if (toggleSplitModeBtn) {
  toggleSplitModeBtn.addEventListener("click", async () => {
    if (
      !currentAudioFile ||
      (currentEnSents.length === 0 &&
        currentZhSents.length === 0 &&
        currentRawTimedItems.length === 0)
    ) {
      return;
    }
    splitMode = splitMode === "sentence" ? "paragraph" : "sentence";
    toggleSplitModeBtn.textContent =
      splitMode === "paragraph" ? "📏 切分：按回车(整段)" : "📏 切分：按句(锁回车)";
    stopPlayback();

    const modeLabel = splitMode === "paragraph" ? "按回车整段" : "按句(锁回车)";
    if (currentRawTimedItems.length > 0) {
      subtitles = alignWhisperSrtWithChinese(currentRawTimedItems, currentZhSents, splitMode);
      currentIndex = 0;
      statusBadge.textContent = `✅ 已切换为 [${modeLabel}] 对齐 (${subtitles.length} 段/句，使用 Whisper 原生时间戳)`;
      renderSubtitleList();
      updateStageDisplay();
      return;
    }

    statusBadge.textContent =
      splitMode === "paragraph"
        ? "⏳ 正在切换为「按回车符（整段）」对齐音频..."
        : "⏳ 正在切换为「按句（先锁回车段）」对齐音频...";
    currentUnits =
      splitMode === "paragraph"
        ? alignParagraphsByNewline(currentEnSents, currentZhSents)
        : alignBilingual(currentEnSents, currentZhSents);
    subtitles = await autoDetectTimestampsFromAudio(currentAudioFile, currentUnits);
    currentIndex = 0;
    statusBadge.textContent = `✅ 已切换为 [${modeLabel}] 对齐 (${subtitles.length} 段/句)`;
    renderSubtitleList();
    updateStageDisplay();
  });
}

function enableTransportControls(enabled) {
  progressBar.disabled = !enabled;
  prevBtn.disabled = !enabled;
  playBtn.disabled = !enabled;
  pauseBtn.disabled = !enabled;
  resumeBtn.disabled = !enabled;
  stopBtn.disabled = !enabled;
  nextBtn.disabled = !enabled;
}

// 渲染全文双语字幕列表
function renderSubtitleList() {
  subtitleList.innerHTML = "";
  if (subtitles.length === 0) {
    subtitleList.innerHTML = `<div class="empty-state"><p>当前目录未找到有效字幕内容</p></div>`;
    return;
  }

  subtitles.forEach((item, idx) => {
    const row = document.createElement("div");
    row.className = `subtitle-item${idx === currentIndex ? " active" : ""}${item.warn ? " has-warn" : ""}`;
    row.dataset.index = idx;

    const indexCol = document.createElement("div");
    indexCol.className = "sub-index-col";
    indexCol.innerHTML = `
      <span class="sub-idx">#${String(idx + 1).padStart(2, "0")}</span>
      <span class="sub-time-badge" id="time-badge-${idx}">${formatPreciseTime(item.start)} - ${formatPreciseTime(item.end)}</span>
    `;

    const contentCol = document.createElement("div");
    contentCol.className = "sub-content-col";

    const enDiv = document.createElement("div");
    enDiv.className = `sub-en${showEn ? "" : " hidden-text"}`;
    enDiv.textContent = item.en;

    const zhDiv = document.createElement("div");
    zhDiv.className = `sub-zh${showZh ? "" : " hidden-text"}`;
    zhDiv.textContent = item.zh;

    contentCol.appendChild(enDiv);
    contentCol.appendChild(zhDiv);

    if (item.warn) {
      const warnDiv = document.createElement("div");
      warnDiv.className = "sub-warn";
      warnDiv.textContent = `⚠️ ${item.warn}`;
      contentCol.appendChild(warnDiv);
    }

    row.appendChild(indexCol);
    row.appendChild(contentCol);

    if (stampMode) {
      const stampCol = document.createElement("div");
      stampCol.className = "sub-stamp-col";
      stampCol.innerHTML = `
        <div class="time-input-group">
          <span>起</span>
          <input type="number" step="0.05" min="0" class="time-input start-input" value="${item.start.toFixed(2)}" />
        </div>
        <div class="time-input-group">
          <span>止</span>
          <input type="number" step="0.05" min="0" class="time-input end-input" value="${item.end.toFixed(2)}" />
        </div>
      `;
      stampCol.addEventListener("click", (ev) => ev.stopPropagation());

      const startInput = stampCol.querySelector(".start-input");
      const endInput = stampCol.querySelector(".end-input");

      startInput.addEventListener("change", () => {
        item.start = Math.max(0, Number(parseFloat(startInput.value).toFixed(2)) || 0);
        updateRowTimestampBadge(idx);
        if (idx === currentIndex) updateStageDisplay();
      });

      endInput.addEventListener("change", () => {
        item.end = Math.max(item.start, Number(parseFloat(endInput.value).toFixed(2)) || 0);
        updateRowTimestampBadge(idx);
        if (idx === currentIndex) updateStageDisplay();
      });

      row.appendChild(stampCol);
    }

    row.addEventListener("click", () => {
      jumpToSentence(idx, true);
    });

    subtitleList.appendChild(row);
  });
}

function updateRowTimestampBadge(idx) {
  const badge = document.getElementById(`time-badge-${idx}`);
  if (badge && subtitles[idx]) {
    badge.textContent = `${formatPreciseTime(subtitles[idx].start)} - ${formatPreciseTime(subtitles[idx].end)}`;
  }
}

// 更新顶部当前句大舞台与列表高亮
function updateStageDisplay(scrollIntoView = true) {
  if (subtitles.length === 0) {
    currentSentenceIndexEl.textContent = "第 0 / 0 句";
    currentSentenceTimeEl.textContent = "00:00.00 - 00:00.00";
    return;
  }

  const cur = subtitles[currentIndex] || subtitles[0];
  currentSentenceIndexEl.textContent = `第 ${currentIndex + 1} / ${subtitles.length} 句`;
  currentSentenceTimeEl.textContent = `${formatPreciseTime(cur.start)} - ${formatPreciseTime(cur.end)}`;
  stageEn.textContent = cur.en || "";
  stageZh.textContent = cur.zh || "";

  stageEn.classList.toggle("hidden-text", !showEn);
  stageZh.classList.toggle("hidden-text", !showZh);

  const rows = subtitleList.querySelectorAll(".subtitle-item");
  rows.forEach((r, idx) => {
    if (idx === currentIndex) {
      r.classList.add("active");
      if (scrollIntoView) {
        r.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
    } else {
      r.classList.remove("active");
    }
  });
}

// 更新播放状态指示灯与按钮可用状态
function setPlayState(newState) {
  playState = newState;
  playStateDot.className = `state-dot ${newState}`;
  if (newState === "playing") {
    playStateText.textContent = "正在播放";
    pauseBtn.disabled = false;
    resumeBtn.disabled = true;
    startSyncLoop();
  } else if (newState === "paused") {
    playStateText.textContent = "已暂停";
    pauseBtn.disabled = true;
    resumeBtn.disabled = false;
    stopSyncLoop();
  } else {
    playStateText.textContent = "已停止";
    pauseBtn.disabled = true;
    resumeBtn.disabled = true;
    stopSyncLoop();
  }
}

// 跳转到指定句子
function jumpToSentence(idx, autoPlay = true) {
  if (subtitles.length === 0) return;
  const targetIdx = Math.max(0, Math.min(subtitles.length - 1, idx));
  currentIndex = targetIdx;
  const targetStart = subtitles[currentIndex].start;
  audioPlayer.currentTime = targetStart;
  updateStageDisplay(true);

  if (autoPlay) {
    audioPlayer.play();
    setPlayState("playing");
  }
}

// 1. 播放按钮
playBtn.addEventListener("click", () => {
  if (subtitles.length === 0) return;
  if (playState === "stopped") {
    audioPlayer.currentTime = subtitles[currentIndex].start;
  }
  audioPlayer.play();
  setPlayState("playing");
});

// 2. 暂停按钮
pauseBtn.addEventListener("click", () => {
  if (!audioPlayer.paused) {
    audioPlayer.pause();
    setPlayState("paused");
  }
});

// 3. 继续按钮
resumeBtn.addEventListener("click", () => {
  if (audioPlayer.paused && subtitles.length > 0) {
    audioPlayer.play();
    setPlayState("playing");
  }
});

// 4. 停止按钮
function stopPlayback() {
  audioPlayer.pause();
  audioPlayer.currentTime = 0;
  currentIndex = 0;
  progressBar.value = 0;
  currentTimeLabel.textContent = "00:00";
  setPlayState("stopped");
  if (subtitles.length > 0) {
    updateStageDisplay(true);
  }
}

stopBtn.addEventListener("click", stopPlayback);

// 5. 上一句按钮
prevBtn.addEventListener("click", () => {
  if (subtitles.length === 0) return;
  const nextIdx = Math.max(0, currentIndex - 1);
  jumpToSentence(nextIdx, true);
});

// 6. 下一句按钮
nextBtn.addEventListener("click", () => {
  if (subtitles.length === 0) return;
  const nextIdx = Math.min(subtitles.length - 1, currentIndex + 1);
  jumpToSentence(nextIdx, true);
});

// 7. 显示/隐藏英文
toggleEnBtn.addEventListener("click", () => {
  showEn = !showEn;
  toggleEnBtn.textContent = showEn ? "👁️ 隐藏英文" : "👁️ 显示英文";
  toggleEnBtn.classList.toggle("active", showEn);
  stageEn.classList.toggle("hidden-text", !showEn);
  subtitleList.querySelectorAll(".sub-en").forEach((el) => {
    el.classList.toggle("hidden-text", !showEn);
  });
});

// 8. 显示/隐藏中文
toggleZhBtn.addEventListener("click", () => {
  showZh = !showZh;
  toggleZhBtn.textContent = showZh ? "👁️ 隐藏中文" : "👁️ 显示中文";
  toggleZhBtn.classList.toggle("active", showZh);
  stageZh.classList.toggle("hidden-text", !showZh);
  subtitleList.querySelectorAll(".sub-zh").forEach((el) => {
    el.classList.toggle("hidden-text", !showZh);
  });
});

// 音频进度条与时间同步
audioPlayer.addEventListener("loadedmetadata", () => {
  durationLabel.textContent = formatShortTime(audioPlayer.duration);
  progressBar.max = audioPlayer.duration || 100;
});

progressBar.addEventListener("input", () => {
  const t = parseFloat(progressBar.value);
  audioPlayer.currentTime = t;
  currentTimeLabel.textContent = formatShortTime(t);
  syncSentenceByTime(t);
});

audioPlayer.addEventListener("ended", () => {
  setPlayState("stopped");
});

function syncSentenceByTime(t) {
  if (subtitles.length === 0) return;
  let matchedIdx = currentIndex;
  for (let i = 0; i < subtitles.length; i++) {
    const s = subtitles[i].start;
    const nextS = i + 1 < subtitles.length ? subtitles[i + 1].start : Infinity;
    if (t >= s - 0.05 && t < nextS - 0.05) {
      matchedIdx = i;
      break;
    }
  }

  if (matchedIdx !== currentIndex) {
    currentIndex = matchedIdx;
    updateStageDisplay(true);
  }
}

function startSyncLoop() {
  stopSyncLoop();
  function tick() {
    const t = audioPlayer.currentTime;
    progressBar.value = t;
    currentTimeLabel.textContent = formatShortTime(t);
    syncSentenceByTime(t);
    if (!audioPlayer.paused) {
      rafId = requestAnimationFrame(tick);
    }
  }
  rafId = requestAnimationFrame(tick);
}

function stopSyncLoop() {
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
}

// ================== 打时间戳 / 微调与直接写入文件夹 ==================
toggleStampModeBtn.addEventListener("click", () => {
  stampMode = !stampMode;
  stampToolbar.classList.toggle("hidden", !stampMode);
  toggleStampModeBtn.textContent = stampMode ? "✖ 关闭打时间戳面板" : "⏱️ 打时间戳 / 微调";
  renderSubtitleList();
});

function stampCurrentStart() {
  if (subtitles.length === 0) return;
  const now = Number(audioPlayer.currentTime.toFixed(2));
  subtitles[currentIndex].start = now;
  if (subtitles[currentIndex].end < now) {
    subtitles[currentIndex].end = Number((now + 2.0).toFixed(2));
  }
  renderSubtitleList();
  updateStageDisplay(false);
}

function stampCurrentEndAndAdvance() {
  if (subtitles.length === 0) return;
  const now = Number(audioPlayer.currentTime.toFixed(2));
  subtitles[currentIndex].end = Math.max(subtitles[currentIndex].start, now);
  if (currentIndex + 1 < subtitles.length) {
    currentIndex += 1;
    if (subtitles[currentIndex].start < now) {
      subtitles[currentIndex].start = now;
      if (subtitles[currentIndex].end <= now) {
        subtitles[currentIndex].end = Number((now + 2.5).toFixed(2));
      }
    }
  }
  renderSubtitleList();
  updateStageDisplay(true);
}

stampStartBtn.addEventListener("click", stampCurrentStart);
stampEndNextBtn.addEventListener("click", stampCurrentEndAndAdvance);

autoAlignBtn.addEventListener("click", async () => {
  if (!currentAudioFile || subtitles.length === 0) return;
  statusBadge.textContent = "⏳ 正在重新自动识别时间戳...";
  // 优先用加载时算好的双语单元（带段落和合并信息），否则从当前字幕重建
  const units =
    currentUnits.length === subtitles.length
      ? currentUnits
      : subtitles.map((s) => ({ en: s.en, zh: s.zh, paraEnd: false, warn: s.warn || "", extraBreaks: 0 }));
  subtitles = await autoDetectTimestampsFromAudio(currentAudioFile, units);
  renderSubtitleList();
  updateStageDisplay(false);
  statusBadge.textContent = `✅ 已重新对齐 ${subtitles.length} 句时间戳`;
});

// 优先直接写入当前课程目录句柄，若无句柄则触发浏览器下载
async function saveFileToCurrentDirOrDownload(content, filename, mimeType) {
  const group = currentLessonFolderPath ? lessonsMap.get(currentLessonFolderPath) : null;
  if (group && group.dirHandle && typeof group.dirHandle.getFileHandle === "function") {
    try {
      const fileHandle = await group.dirHandle.getFileHandle(filename, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(content);
      await writable.close();
      statusBadge.textContent = `✅ 已直接保存到目录: ${group.name}/${filename}`;
      return;
    } catch (err) {
      console.warn("直接写入目录未成功，改为下载保存:", err);
    }
  }
  downloadTextFile(content, filename, mimeType);
}

exportSrtBtn.addEventListener("click", async () => {
  if (subtitles.length === 0) return;
  const lines = [];
  subtitles.forEach((item, idx) => {
    lines.push(String(idx + 1));
    lines.push(`${formatSrtTime(item.start)} --> ${formatSrtTime(item.end)}`);
    if (item.en) lines.push(item.en);
    if (item.zh) lines.push(item.zh);
    lines.push("");
  });
  await saveFileToCurrentDirOrDownload(lines.join("\n"), "subtitles.srt", "text/plain;charset=utf-8");
});

exportJsonBtn.addEventListener("click", async () => {
  if (subtitles.length === 0) return;
  const content = JSON.stringify(subtitles, null, 2);
  await saveFileToCurrentDirOrDownload(content, "subtitles.json", "application/json;charset=utf-8");
});

function downloadTextFile(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// 键盘快捷键支持
document.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
  if (subtitles.length === 0) return;

  if (stampMode && (e.key === "s" || e.key === "S")) {
    e.preventDefault();
    stampCurrentStart();
  } else if (stampMode && (e.key === "d" || e.key === "D")) {
    e.preventDefault();
    stampCurrentEndAndAdvance();
  } else if (e.key === "ArrowLeft") {
    e.preventDefault();
    prevBtn.click();
  } else if (e.key === "ArrowRight") {
    e.preventDefault();
    nextBtn.click();
  }
});

// 启动时检查是否有上次记住的目录
(async function initCheckLastDir() {
  const lastHandle = await getLastDirHandle();
  if (lastHandle) {
    statusBadge.textContent = `上次目录: ${lastHandle.name}（点击「选择要播放的目录」可重新加载或切换）`;
  }
})();
