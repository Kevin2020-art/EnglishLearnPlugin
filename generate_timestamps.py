#!/usr/bin/env python3
"""
为英文听力目录生成标准双语时间戳文件 (subtitles.srt 与 subtitles.json)
用法:
    python3 generate_timestamps.py [目录路径，默认 ./resources]
"""
import json
import os
import re
import subprocess
import sys
from difflib import SequenceMatcher
from pathlib import Path


def is_chinese_text(text: str) -> bool:
    zh_chars = len(re.findall(r"[\u4e00-\u9fff]", text))
    return zh_chars > len(text) * 0.1


def clean_markdown_line(line: str) -> str:
    """清理 Markdown 语法符号（如 # 标题、**加粗**、> 引用、- 列表等）。"""
    line = re.sub(r"^\s*#{1,6}\s+", "", line)
    line = re.sub(r"^\s*>\s+", "", line)
    line = re.sub(r"^\s*[-*+]\s+", "", line)
    line = re.sub(r"\*\*(.*?)\*\*", r"\1", line)
    line = re.sub(r"__(.*?)__", r"\1", line)
    line = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", line)
    return line.replace("**", "").strip()


def split_english_sentences(text: str):
    """按自然句切分英文文本，保护小数点不切分，自动识别 RAZ 常见引导词。

    返回 [{"text", "line", "para_id", "para_end"}]，para_id 为段落编号，line 为原文件行号。
    """
    sents = []
    para_id = 0
    for line_no, raw_line in enumerate(text.splitlines(), start=1):
        line = clean_markdown_line(raw_line)
        if not line:
            continue
        # 将同行末尾连着的 Math moment / Beyond the book 独立成段，以匹配中文的回车分段
        line = re.sub(
            r"\b([Mm]ath\s+[Mm]oment|[Bb]eyond\s+the\s+[Bb]ook)\.?\s+(?=[A-Z])",
            r"\n\1.\n",
            line,
        )
        for sub_line in line.splitlines():
            sub_line = sub_line.strip()
            if not sub_line:
                continue
            para_id += 1
            sub_line = re.sub(
                r"\b([Ff]ocus\s+[Qq]uestion|[Mm]ath\s+[Mm]oment|[Bb]e\s+a\s+[Ss]cientist|[Bb]eyond\s+the\s+[Bb]ook)\s+(?=[A-Z])",
                r"\1. ",
                sub_line,
            )
            safe_line = re.sub(r"(\d)\.(\d)", r"\1__DOT__\2", sub_line)
            raw_parts = [
                p.replace("__DOT__", ".").strip()
                for p in re.split(r"(?<=[.?!])\s+", safe_line)
                if p.strip()
            ]
            parts = []
            for p in raw_parts:
                if parts and len(p) <= 12 and p.lower() == parts[-1].lower():
                    parts[-1] = f"{parts[-1]} {p}"
                else:
                    parts.append(p)
            for idx, p in enumerate(parts):
                sents.append({
                    "text": p,
                    "line": line_no,
                    "para_id": para_id,
                    "para_end": idx == len(parts) - 1,
                })
    return sents


def split_chinese_sentences(text: str):
    """按自然句切分中文文本，去除 Markdown 语法符号。

    注意：普通冒号（如“作者：”）不作为切句符，只有行首的“聚焦问题：”、“数学时刻：”才切分。
    返回 [{"text", "line", "para_id", "para_end"}]。
    """
    sents = []
    para_id = 0
    for line_no, raw_line in enumerate(text.splitlines(), start=1):
        line = clean_markdown_line(raw_line)
        if not line:
            continue
        para_id += 1
        line = re.sub(r"^(聚焦问题|数学时刻)[：:]\s*", r"\1：|", line)
        parts = []
        for sub in line.split("|"):
            if not sub.strip():
                continue
            ms = re.findall(r"[^。？！]+(?:(?:\d+\.\d+)[^。？！]*)*(?:[。？！]+|$)", sub)
            for m in ms:
                if m.strip():
                    parts.append(m.strip())
        for idx, p in enumerate(parts):
            sents.append({
                "text": p,
                "line": line_no,
                "para_id": para_id,
                "para_end": idx == len(parts) - 1,
            })
    return sents


def _text_len(text: str) -> int:
    # 去掉括号里的英文原名注释（如（Rhonda Lucas Donald）），避免中文字数被虚高
    cleaned = re.sub(r"[（(][A-Za-z0-9\s.,'-]+[)）]", "", text)
    return max(1, len(re.sub(r"\s+", "", cleaned)))


def _numbers(text: str):
    """提取文本中的阿拉伯数字（去掉千分位逗号），用作中英对齐的锚点。"""
    return re.findall(r"\d+(?:\.\d+)?", re.sub(r"(?<=\d),(?=\d{3})", "", text))



_NON_END_WORDS = {
    "a", "an", "the", "of", "in", "on", "at", "to", "for", "with", "by", "from",
    "into", "under", "over", "through", "after", "before", "between", "and", "or",
    "but", "so", "as", "if", "than", "that", "this", "these", "those", "my", "your",
    "his", "her", "its", "our", "their", "some", "many", "few", "more", "most",
    "very", "too", "not", "no", "can", "will", "may", "might", "must", "should",
    "would", "could", "is", "are", "was", "were", "be", "been", "have", "has", "had",
    "do", "does", "did", "keep", "keeps", "help", "helps", "make", "makes", "look",
    "looks", "feel", "feels", "live", "lives", "eat", "eats", "grow", "grows",
}

_SENT_STARTERS = {
    "why", "how", "what", "when", "where", "who", "which",
    "the", "they", "it", "this", "these", "there", "then", "now", "later", "after",
    "in", "on", "for", "one", "some", "many", "few", "most", "all",
}


def _auto_split_en_by_zh(en_str: str, zh_list: list) -> list:
    """当 1 句英文对应多句中文（英文漏了句号）时，根据中文长度比例与英文大写/句首词边界自动补句号拆开。"""
    if len(zh_list) <= 1:
        return [en_str]
    zh_lens = [max(1, _text_len(z)) for z in zh_list]
    frac = zh_lens[0] / sum(zh_lens)
    total_len = len(en_str)
    target_pos = frac * total_len

    best_score = 1e9
    best_split = None

    for m in re.finditer(r"\s+", en_str):
        pos, next_pos = m.start(), m.end()
        if pos < 2 or next_pos >= total_len - 2:
            continue
        left_part = en_str[:pos].strip()
        right_part = en_str[next_pos:].strip()
        prev_m = re.search(r"([A-Za-z0-9']+)[,;:]*$", left_part)
        next_m = re.match(r"([A-Za-z0-9']+)", right_part)
        if not prev_m or not next_m:
            continue
        prev_word = prev_m.group(1)
        next_word = next_m.group(1)

        dist_cost = abs(pos - target_pos) / max(1, total_len)
        bonus = 0.0
        if left_part[-1] in ",;:":
            bonus -= 0.15
        if next_word[0].isupper():
            bonus -= 0.45
        elif next_word.lower() in _SENT_STARTERS:
            bonus -= 0.25
        if prev_word.lower() in _NON_END_WORDS:
            bonus += 0.65

        score = dist_cost + bonus
        if score < best_score:
            best_score = score
            best_split = (left_part, right_part)

    if not best_split:
        return [en_str]

    left_s, right_s = best_split
    if left_s[-1] in ",;:":
        left_s = left_s[:-1] + "."
    elif left_s[-1] not in ".?!":
        left_s = left_s + "."

    if right_s and right_s[0].islower():
        right_s = right_s[0].upper() + right_s[1:]

    rest = _auto_split_en_by_zh(right_s, zh_list[1:])
    return [left_s] + rest


def _auto_split_zh_by_en(zh_str: str, en_list: list) -> list:
    """当多句英文对应 1 句中文（中文漏了句号或用了逗号连接）时，按英文长度比例在逗号/空格处自动拆开。"""
    if len(en_list) <= 1:
        return [zh_str]
    en_lens = [max(1, _text_len(e)) for e in en_list]
    frac = en_lens[0] / sum(en_lens)
    total_len = len(zh_str)
    target_pos = frac * total_len

    best_score = 1e9
    best_split = None
    for m in re.finditer(r"[，,；;\s]+", zh_str):
        pos, next_pos = m.start(), m.end()
        if pos < 1 or next_pos >= total_len - 1:
            continue
        dist_cost = abs(pos - target_pos) / max(1, total_len)
        if dist_cost < best_score:
            best_score = dist_cost
            best_split = (zh_str[:pos].strip() + "。", zh_str[next_pos:].strip())

    if not best_split:
        return [zh_str]
    left_z, right_z = best_split
    return [left_z] + _auto_split_zh_by_en(right_z, en_list[1:])


# 中英句子组合方式及其惩罚：(英文句数, 中文句数) -> 额外代价
_BEAD_PENALTY = {
    (1, 1): 0.0,
    (1, 2): 2.5,
    (2, 1): 2.5,
    (1, 3): 5.0,
    (3, 1): 5.0,
    (1, 0): 6.0,
    (0, 1): 6.0,
}


def _align_bilingual_block(en_sents, zh_sents, ratio):
    """对单个段落或全局的英中句子列表做动态规划对齐。"""
    if not zh_sents:
        return [
            {"en": e["text"], "zh": "", "para_end": e["para_end"], "warn": "", "extra_breaks": 0}
            for e in en_sents
        ]
    if not en_sents:
        return [
            {"en": "", "zh": z["text"], "para_end": z["para_end"], "warn": "", "extra_breaks": 0}
            for z in zh_sents
        ]

    en_len = [_text_len(e["text"]) for e in en_sents]
    zh_len = [_text_len(z["text"]) for z in zh_sents]
    en_nums_list = [_numbers(e["text"]) for e in en_sents]
    zh_nums_list = [_numbers(z["text"]) for z in zh_sents]

    N, K = len(en_sents), len(zh_sents)
    INF = float("inf")
    dp = [[INF] * (K + 1) for _ in range(N + 1)]
    back = [[None] * (K + 1) for _ in range(N + 1)]
    dp[0][0] = 0.0

    def group_cost(i0, a, j0, b):
        le = sum(en_len[i0:i0 + a])
        lz = sum(zh_len[j0:j0 + b])
        expected = ratio * le
        cost = (lz - expected) ** 2 / (expected + 6.0)
        cost += _BEAD_PENALTY[(a, b)]
        # 一组内跨越了原文的段落（回车换行）边界，给予高额惩罚
        for k in range(i0, i0 + a - 1):
            if en_sents[k]["para_end"]:
                cost += 8.0
        for k in range(j0, j0 + b - 1):
            if zh_sents[k]["para_end"]:
                cost += 8.0
        # 数字锚点：两边出现的数字应该落在同一组里
        en_nums = [n for k in range(i0, i0 + a) for n in en_nums_list[k]]
        zh_nums = [n for k in range(j0, j0 + b) for n in zh_nums_list[k]]
        if en_nums or zh_nums:
            unmatched = len(set(en_nums) ^ set(zh_nums))
            cost += 2.0 * min(unmatched, 3)
        # 段落末尾应该同时结束
        if a and b and en_sents[i0 + a - 1]["para_end"] != zh_sents[j0 + b - 1]["para_end"]:
            cost += 4.0
        return cost

    for i in range(N + 1):
        for j in range(K + 1):
            if dp[i][j] == INF:
                continue
            for (a, b) in _BEAD_PENALTY:
                if i + a > N or j + b > K:
                    continue
                c = dp[i][j] + group_cost(i, a, j, b)
                if c < dp[i + a][j + b]:
                    dp[i + a][j + b] = c
                    back[i + a][j + b] = (a, b)

    units = []
    i, j = N, K
    while i > 0 or j > 0:
        a, b = back[i][j]
        ens = en_sents[i - a:i]
        zhs = zh_sents[j - b:j]

        # 情况 1: 1 句英文对应多句中文（英文漏了句号） -> 直接自动补句号拆成 b 句
        if a == 1 and b >= 2:
            split_ens = _auto_split_en_by_zh(ens[0]["text"], [z["text"] for z in zhs])
            if len(split_ens) == b:
                for idx in range(b - 1, -1, -1):
                    units.append({
                        "en": split_ens[idx],
                        "zh": zhs[idx]["text"],
                        "para_end": ens[0]["para_end"] if idx == b - 1 else False,
                        "warn": "",
                        "extra_breaks": 0,
                    })
                i, j = i - a, j - b
                continue

        # 情况 2: 多句英文对应 1 句中文（中文用逗号合句或漏了句号） -> 自动在逗号/空格处拆成 a 句
        if a >= 2 and b == 1:
            split_zhs = _auto_split_zh_by_en(zhs[0]["text"], [e["text"] for e in ens])
            if len(split_zhs) == a:
                for idx in range(a - 1, -1, -1):
                    units.append({
                        "en": ens[idx]["text"],
                        "zh": split_zhs[idx],
                        "para_end": ens[idx]["para_end"],
                        "warn": "",
                        "extra_breaks": 0,
                    })
                i, j = i - a, j - b
                continue

        warn = ""
        if (a, b) != (1, 1):
            en_lines = sorted({e["line"] for e in ens})
            zh_lines = sorted({z["line"] for z in zhs})
            warn = (
                f"英文 {a} 句 ↔ 中文 {b} 句"
                + (f"（英文第 {','.join(map(str, en_lines))} 行" if en_lines else "（英文无对应")
                + (f"，中文第 {','.join(map(str, zh_lines))} 行）" if zh_lines else "，中文无对应）")
                + "，可能漏了标点"
            )
        units.append({
            "en": " ".join(e["text"] for e in ens),
            "zh": "".join(z["text"] for z in zhs),
            "para_end": (ens[-1]["para_end"] if ens else zhs[-1]["para_end"]),
            "warn": warn,
            "extra_breaks": max(a, b) - 1,
        })
        i, j = i - a, j - b
    units.reverse()
    return units


def align_bilingual(en_sents, zh_sents):
    """把英文句子和中文句子做双语对齐（优先按回车符段落锁定，段内再按句对齐）。"""
    if not zh_sents:
        return [{"en": e["text"], "zh": "", "para_end": e["para_end"], "warn": "", "extra_breaks": 0} for e in en_sents]
    if not en_sents:
        return [{"en": "", "zh": z["text"], "para_end": z["para_end"], "warn": "", "extra_breaks": 0} for z in zh_sents]

    total_en_len = sum(_text_len(e["text"]) for e in en_sents)
    total_zh_len = sum(_text_len(z["text"]) for z in zh_sents)
    ratio = total_zh_len / max(1, total_en_len)

    en_max_para = en_sents[-1].get("para_id", 0)
    zh_max_para = zh_sents[-1].get("para_id", 0)

    # 当英中非空段落数一致（回车符一一对应）时，严格按每个回车段落独立对齐，绝不跨段串行
    if en_max_para > 0 and en_max_para == zh_max_para:
        units = []
        for pid in range(1, en_max_para + 1):
            en_p = [e for e in en_sents if e.get("para_id") == pid]
            zh_p = [z for z in zh_sents if z.get("para_id") == pid]
            units.extend(_align_bilingual_block(en_p, zh_p, ratio))
        return units

    return _align_bilingual_block(en_sents, zh_sents, ratio)


def align_paragraphs_by_newline(en_sents, zh_sents):
    """直接按回车符（段落）一对一对齐，每一段（绘本每一页）作为一个字幕单元。"""
    max_p = max(
        en_sents[-1].get("para_id", 0) if en_sents else 0,
        zh_sents[-1].get("para_id", 0) if zh_sents else 0,
    )
    units = []
    for pid in range(1, max_p + 1):
        ep = [e["text"] for e in en_sents if e.get("para_id") == pid]
        zp = [z["text"] for z in zh_sents if z.get("para_id") == pid]
        if not ep and not zp:
            continue
        units.append({
            "en": " ".join(ep),
            "zh": "".join(zp),
            "para_end": True,
            "warn": "",
            "extra_breaks": max(len(ep), len(zp)) - 1,
        })
    return units


def detect_audio_chunks(mp3_path: Path, noise_db: int = -35, min_silence: float = 0.35):
    """使用 ffmpeg silencedetect 提取音频中的人声发音片段。"""
    cmd = [
        "ffmpeg",
        "-i",
        str(mp3_path),
        "-af",
        f"silencedetect=noise={noise_db}dB:d={min_silence}",
        "-f",
        "null",
        "-",
    ]
    out = subprocess.check_output(cmd, stderr=subprocess.STDOUT).decode("utf-8", errors="ignore")

    dur_match = re.search(r"Duration:\s*(\d+):(\d+):(\d+\.\d+)", out)
    total_duration = 0.0
    if dur_match:
        h, m, s = int(dur_match.group(1)), int(dur_match.group(2)), float(dur_match.group(3))
        total_duration = h * 3600 + m * 60 + s

    starts = [float(x) for x in re.findall(r"silence_start:\s*([0-9.]+)", out)]
    ends = [float(x) for x in re.findall(r"silence_end:\s*([0-9.]+)", out)]

    chunks = []
    # 如果音频一开头就有声音（第一个 silence_start > 0.2 且在第一个 silence_end 之前）
    if starts and (not ends or starts[0] < ends[0] - 0.1) and starts[0] > 0.2:
        chunks.append((0.0, starts[0]))

    for i, s_end in enumerate(ends):
        # 找下一个 silence_start
        next_starts = [st for st in starts if st > s_end + 0.05]
        s_next = next_starts[0] if next_starts else total_duration
        if s_next - s_end > 0.2:
            chunks.append((round(s_end, 2), round(s_next, 2)))

    return chunks


def align_units_to_chunks(units, chunks):
    """使用动态规划将 M 个原子语音块对齐到 N 个双语单元（以英文长度估算时长）。"""
    N = len(units)
    M = len(chunks)
    # 没有英文时用中文长度折算（中文 1 字约等于英文 3 个字符）
    lens = [max(1, len(u["en"]) if u["en"] else _text_len(u["zh"]) * 3) for u in units]

    def make_item(idx, s, e):
        u = units[idx]
        item = {"index": idx + 1, "start": round(s, 2), "end": round(e, 2), "en": u["en"], "zh": u["zh"]}
        if u.get("warn"):
            item["warn"] = u["warn"]
        return item

    if N == 0:
        return []
    if M < N:
        # 若原子块少于句子数，按字数比例线性分配
        total_start = chunks[0][0] if chunks else 0.0
        total_end = chunks[-1][1] if chunks else N * 3.0
        total_chars = sum(lens)
        cur = total_start
        result = []
        for idx in range(N):
            dur = (total_end - total_start) * lens[idx] / total_chars
            result.append(make_item(idx, cur, cur + dur))
            cur += dur
        return result

    total_speech = sum(e - s for s, e in chunks)
    sec_per_char = total_speech / max(1, sum(lens))

    INF = 1e18
    dp = [[INF] * (M + 1) for _ in range(N + 1)]
    parent = [[0] * (M + 1) for _ in range(N + 1)]
    dp[0][0] = 0.0

    for i in range(1, N + 1):
        is_para_end = units[i - 1]["para_end"]
        extra_breaks = units[i - 1].get("extra_breaks", 0)
        exp_dur = max(0.35, 0.15 + lens[i - 1] * sec_per_char * 0.92)
        for j in range(i, M - (N - i) + 1):
            for k in range(max(i - 1, j - 16), j):
                if dp[i - 1][k] >= INF:
                    continue
                speech_dur = sum(chunks[c][1] - chunks[c][0] for c in range(k, j))
                ratio = max(speech_dur / exp_dur, exp_dur / max(0.1, speech_dur))
                dur_cost = ((speech_dur - exp_dur) / 0.9) ** 2 + ((ratio - 1.0) * 3.5) ** 2

                internal_gaps = sorted(
                    (chunks[c + 1][0] - chunks[c][1] for c in range(k, j - 1)), reverse=True
                )
                # 合并单元允许若干个最长的停顿不计罚分
                internal_gaps = internal_gaps[extra_breaks:]
                internal_gap_cost = 0.0
                for gap in internal_gaps:
                    if gap > 1.8:
                        internal_gap_cost += 40.0 + ((gap - 0.5) / 0.3) ** 2 * 2.5
                    elif gap > 0.75:
                        internal_gap_cost += ((gap - 0.5) / 0.3) ** 2 * 2.5
                    else:
                        internal_gap_cost += (gap / 0.6) ** 2 * 0.5

                boundary_cost = 0.0
                if j < M:
                    gap_after = chunks[j][0] - chunks[j - 1][1]
                    if gap_after < 0.75:
                        boundary_cost += ((0.75 - gap_after) / 0.12) ** 2
                    if is_para_end:
                        if gap_after < 1.1:
                            boundary_cost += 10.0
                        elif gap_after >= 1.5:
                            boundary_cost -= 4.0
                    elif gap_after >= 2.0:
                        boundary_cost += 12.0

                cost = dp[i - 1][k] + dur_cost + internal_gap_cost + boundary_cost
                if cost < dp[i][j]:
                    dp[i][j] = cost
                    parent[i][j] = k

    aligned = []
    curr = M
    for i in range(N, 0, -1):
        prev = parent[i][curr]
        raw_s = chunks[prev][0]
        raw_e = chunks[curr - 1][1]
        # 前瞻 0.50s 保护声头气流，延展 0.18s 保护弱读尾音
        padded_s = max(0.0, raw_s - 0.50)
        padded_e = raw_e + 0.18
        aligned.append((padded_s, padded_e))
        curr = prev
    aligned.reverse()

    # 边界防重叠保护（防止当前句提前侵入上一句的尾部）
    sanitized = []
    last_e = 0.0
    for s, e in aligned:
        cur_s = max(last_e, s)
        cur_e = max(cur_s + 0.35, e)
        sanitized.append((cur_s, cur_e))
        last_e = cur_e

    return [make_item(idx, s, e) for idx, (s, e) in enumerate(sanitized)]


def try_whisper_word_timestamps(mp3_path: Path):
    """尝试使用本地免费开源的 mlx_whisper / faster_whisper / openai-whisper 提取每个单词的毫秒级时间戳。

    返回 (words, full_text) 或 (None, None)。
    words: [{"word": str, "norm": str, "start": float, "end": float}]
    """
    # 1. 优先尝试 Apple Silicon 专属加速的 mlx_whisper
    try:
        import mlx_whisper  # type: ignore

        print(f"🎙️ 正在使用 Apple Silicon 免费开源 mlx-whisper 识别词级时间戳: {mp3_path.name} ...")
        res = mlx_whisper.transcribe(
            str(mp3_path),
            path_or_hf_repo="mlx-community/whisper-base.en-mlx",
            word_timestamps=True,
        )
        words = []
        paras = []
        cur_para = []
        prev_end = None
        for seg in res.get("segments", []):
            seg_t = seg.get("text", "").strip()
            seg_s = float(seg.get("start", 0.0))
            seg_e = float(seg.get("end", 0.0))
            if seg_t:
                if prev_end is not None and (seg_s - prev_end) >= 1.5 and cur_para:
                    paras.append(" ".join(cur_para))
                    cur_para = []
                cur_para.append(seg_t)
                prev_end = seg_e
            for w in seg.get("words", []):
                norm = re.sub(r"[^a-z0-9]", "", w.get("word", "").lower())
                if norm:
                    words.append({
                        "word": w["word"].strip(),
                        "norm": norm,
                        "start": float(w["start"]),
                        "end": float(w["end"]),
                    })
        if cur_para:
            paras.append(" ".join(cur_para))
        if words:
            return words, "\n\n".join(paras)
    except ImportError:
        pass
    except Exception as e:
        print(f"⚠️ mlx-whisper 运行出错，回退静音对齐: {e}")

    # 2. 尝试 faster_whisper
    try:
        from faster_whisper import WhisperModel  # type: ignore

        print(f"🎙️ 正在使用免费开源 faster-whisper 识别词级时间戳: {mp3_path.name} ...")
        model = WhisperModel("base.en", device="cpu", compute_type="int8")
        segments, _ = model.transcribe(str(mp3_path), word_timestamps=True)
        words = []
        seg_texts = []
        for seg in segments:
            if seg.text.strip():
                seg_texts.append(seg.text.strip())
            for w in seg.words or []:
                norm = re.sub(r"[^a-z0-9]", "", w.word.lower())
                if norm:
                    words.append({
                        "word": w.word.strip(),
                        "norm": norm,
                        "start": float(w.start),
                        "end": float(w.end),
                    })
        if words:
            return words, "\n".join(seg_texts)
    except ImportError:
        pass
    except Exception as e:
        print(f"⚠️ faster-whisper 运行出错，回退静音对齐: {e}")

    return None, None


def align_units_with_whisper_words(units, whisper_words, chunks=None):
    """利用 Whisper 识别出的词级时间戳，将每个双语单元精确对齐到对应英文首尾单词的发音时间，
    并结合静音检测 chunks 消除 Whisper 将句前静音算入句首单词 start 的偏差。
    """
    unit_tokens = []
    flat_unit_norms = []
    token_to_unit = []

    for u_idx, u in enumerate(units):
        raw_words = re.findall(r"[A-Za-z0-9']+", u.get("en", ""))
        norms = [re.sub(r"[^a-z0-9]", "", w.lower()) for w in raw_words]
        norms = [n for n in norms if n]
        unit_tokens.append(norms)
        for n in norms:
            flat_unit_norms.append(n)
            token_to_unit.append(u_idx)

    if not flat_unit_norms or not whisper_words:
        return None

    whisper_norms = [w["norm"] for w in whisper_words]
    matcher = SequenceMatcher(None, flat_unit_norms, whisper_norms, autojunk=False)

    # 为每个 flat_unit_norms 索引映射对应的 whisper_words 索引
    mapped_w_idx = [None] * len(flat_unit_norms)
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            for offset in range(i2 - i1):
                mapped_w_idx[i1 + offset] = j1 + offset
        elif tag == "replace" and (i2 - i1) > 0 and (j2 - j1) > 0:
            for offset in range(i2 - i1):
                mapped_j = j1 + int(offset * (j2 - j1) / (i2 - i1))
                mapped_w_idx[i1 + offset] = min(j2 - 1, mapped_j)

    # 线性插补未直接匹配上的词索引
    last_valid = 0
    for idx in range(len(mapped_w_idx)):
        if mapped_w_idx[idx] is not None:
            last_valid = mapped_w_idx[idx]
        else:
            mapped_w_idx[idx] = last_valid

    # 汇总每个句子的起止词索引
    unit_word_ranges = [[] for _ in range(len(units))]
    for tok_idx, u_idx in enumerate(token_to_unit):
        unit_word_ranges[u_idx].append(mapped_w_idx[tok_idx])

    items = []
    prev_end = 0.0
    for idx, u in enumerate(units):
        w_indices = unit_word_ranges[idx]
        if w_indices:
            w_start = min(w_indices)
            w_end = max(w_indices)
            first_w = whisper_words[w_start]
            last_w = whisper_words[w_end]
            start_t = first_w["start"]
            end_t = last_w["end"]

            # Whisper 词级时间戳 + 句首前瞻保护（Padding）
            # 增加 0.50s 前瞻垫音（同时有 prev_end 保护绝不侵入上一句），彻底保留所有微弱声头/送气音
            raw_start = first_w["start"]
            padded_start = max(0.0, raw_start - 0.50)
            start_t = max(prev_end, padded_start)

            # 句尾微延展 0.18s，保留轻读尾音（d/t/s等）
            end_t = last_w["end"] + 0.18

            # 如果 chunks 显示发音段落，且当前句是段落/音频首句，确保不晚于实际开口
            if chunks:
                for cs, ce in chunks:
                    if cs <= raw_start + 0.15 and ce > raw_start:
                        # 句首提前到静音刚结束、人声刚开始的瞬间（留 0.20s 气流缓冲）
                        onset = max(prev_end, max(0.0, cs - 0.20))
                        if onset < start_t:
                            start_t = onset
                        break
                for cs, ce in reversed(chunks):
                    if last_w["start"] < ce <= end_t + 0.35 and cs < last_w["end"]:
                        if ce > end_t:
                            end_t = ce
                        break

            start_t = round(start_t, 2)
            end_t = round(end_t, 2)
            if end_t <= start_t:
                end_t = round(start_t + 0.4, 2)
            prev_end = end_t
        else:
            start_t = prev_end
            end_t = round(prev_end + 1.5, 2)
            prev_end = end_t

        item = {
            "index": idx + 1,
            "start": start_t,
            "end": end_t,
            "en": u["en"],
            "zh": u["zh"],
        }
        if u.get("warn"):
            item["warn"] = u["warn"]
        items.append(item)

    return items


def format_srt_time(seconds: float) -> str:
    ms = int(round((seconds - int(seconds)) * 1000))
    total_sec = int(seconds)
    s = total_sec % 60
    m = (total_sec // 60) % 60
    h = total_sec // 3600
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def process_directory(folder: Path, by_newline: bool = False):
    mp3_files = sorted(folder.glob("*.mp3"))
    txt_files = [
        p for p in sorted(list(folder.glob("*.txt")) + list(folder.glob("*.md")))
        if p.name.lower() not in ("subtitles.txt", "readme.md")
    ]
    if not mp3_files:
        print(f"跳过 {folder}: 未找到 mp3 文件")
        return

    mp3_path = mp3_files[0]
    en_text, zh_text = "", ""
    for txt_path in txt_files:
        content = txt_path.read_text(encoding="utf-8", errors="ignore")
        if is_chinese_text(content):
            zh_text = content
        else:
            en_text = content

    # 优先尝试使用免费开源 Whisper 词级时间戳对齐；若目录连英文 txt 都没有，还能自动转写生成英文 txt
    whisper_words, whisper_en_text = try_whisper_word_timestamps(mp3_path)
    if not en_text and whisper_en_text:
        en_text = whisper_en_text
        auto_en_path = folder / f"{mp3_path.stem}.txt"
        auto_en_path.write_text(en_text, encoding="utf-8")
        print(f"📝 已自动从音频转写生成英文文本: {auto_en_path}")

    if not en_text and not zh_text:
        print(f"跳过 {folder}: 未找到字幕文本，且未安装 mlx-whisper / faster-whisper")
        return

    en_sents = split_english_sentences(en_text)
    zh_sents = split_chinese_sentences(zh_text)
    units = align_paragraphs_by_newline(en_sents, zh_sents) if by_newline else align_bilingual(en_sents, zh_sents)

    chunks = detect_audio_chunks(mp3_path)
    items = None
    if whisper_words:
        items = align_units_with_whisper_words(units, whisper_words, chunks=chunks)
    if not items:
        items = align_units_to_chunks(units, chunks)

    # 1. 保存 subtitles.json
    json_path = folder / "subtitles.json"
    json_path.write_text(json.dumps(items, ensure_ascii=False, indent=2), encoding="utf-8")

    # 2. 保存标准双语 subtitles.srt
    srt_lines = []
    for item in items:
        srt_lines.append(str(item["index"]))
        srt_lines.append(f"{format_srt_time(item['start'])} --> {format_srt_time(item['end'])}")
        if item["en"]:
            srt_lines.append(item["en"])
        if item["zh"]:
            srt_lines.append(item["zh"])
        srt_lines.append("")
    srt_path = folder / "subtitles.srt"
    srt_path.write_text("\n".join(srt_lines), encoding="utf-8")

    print(f"✅ 已生成时间戳文件 ({len(items)} 句):")
    print(f"   - {srt_path}")
    print(f"   - {json_path}")
    warns = [it for it in items if it.get("warn")]
    if warns:
        print(f"⚠️  有 {len(warns)} 处中英句数对不上，建议检查原文标点:")
        for it in warns:
            print(f"   第 {it['index']} 句: {it['warn']}")
            print(f"      EN: {it['en']}")
            print(f"      ZH: {it['zh']}")


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if a != "--by-newline"]
    use_newline = "--by-newline" in sys.argv[1:]
    raw_path = args[0] if args else str(Path(__file__).parent / "resources")
    # 去除两端可能多余的引号与转义
    raw_path = raw_path.strip("\"'“”‘’")
    target = Path(os.path.expanduser(raw_path)).resolve()

    if target.is_file():
        # 如果用户传的是 mp3 文件路径，自动取其所在文件夹
        process_directory(target.parent, by_newline=use_newline)
    elif target.is_dir():
        process_directory(target, by_newline=use_newline)
        for sub in sorted(target.iterdir()):
            if sub.is_dir():
                process_directory(sub, by_newline=use_newline)
    else:
        print(f"❌ 路径不存在: {target}")

