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

    返回 [{"text", "line", "para_end"}]，line 为原文件行号（从 1 开始）。
    """
    sents = []
    for line_no, raw_line in enumerate(text.splitlines(), start=1):
        line = clean_markdown_line(raw_line)
        if not line:
            continue
        # 关键词不区分大小写，但后面必须是大写字母开头的新句子
        line = re.sub(
            r"\b([Ff]ocus\s+[Qq]uestion|[Mm]ath\s+[Mm]oment|[Bb]e\s+a\s+[Ss]cientist|[Bb]eyond\s+the\s+[Bb]ook)\s+(?=[A-Z])",
            r"\1. ",
            line,
        )
        safe_line = re.sub(r"(\d)\.(\d)", r"\1__DOT__\2", line)
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
            sents.append({"text": p, "line": line_no, "para_end": idx == len(parts) - 1})
    return sents


def split_chinese_sentences(text: str):
    """按自然句切分中文文本，去除 Markdown 语法符号。

    返回 [{"text", "line", "para_end"}]，line 为原文件行号（从 1 开始）。
    """
    sents = []
    for line_no, raw_line in enumerate(text.splitlines(), start=1):
        line = clean_markdown_line(raw_line)
        if not line:
            continue
        parts = [
            p.strip()
            for p in re.findall(r"[^。？！：]+(?:(?:\d+\.\d+)[^。？！：]*)*(?:[。？！：]+|$)", line)
            if p.strip()
        ]
        for idx, p in enumerate(parts):
            sents.append({"text": p, "line": line_no, "para_end": idx == len(parts) - 1})
    return sents


def _text_len(text: str) -> int:
    return len(re.sub(r"\s+", "", text))


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


def align_bilingual(en_sents, zh_sents):
    """把英文句子和中文句子做双语对齐（类似 Gale-Church 算法）。

    不再按序号硬配，而是用动态规划允许 1:1 / 1:2 / 2:1 / 1:3 / 3:1 / 1:0 / 0:1 的组合，
    依据中英文长度比例和段落边界打分。某处漏了标点只会让那一处变成 1:2 或 2:1，
    不会让后面的句子一路错开。

    返回 [{"en", "zh", "para_end", "warn"}]，warn 非空表示这里中英句数对不上。
    """
    if not zh_sents:
        return [{"en": e["text"], "zh": "", "para_end": e["para_end"], "warn": ""} for e in en_sents]
    if not en_sents:
        return [{"en": "", "zh": z["text"], "para_end": z["para_end"], "warn": ""} for z in zh_sents]

    en_len = [_text_len(e["text"]) for e in en_sents]
    zh_len = [_text_len(z["text"]) for z in zh_sents]
    ratio = sum(zh_len) / max(1, sum(en_len))  # 每个英文字符大约对应多少中文字符
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
        # 一组内跨越了原文的段落（行）边界，说明合并得不太合理
        for k in range(i0, i0 + a - 1):
            if en_sents[k]["para_end"]:
                cost += 2.0
        for k in range(j0, j0 + b - 1):
            if zh_sents[k]["para_end"]:
                cost += 2.0
        # 数字锚点：两边出现的数字应该落在同一组里
        en_nums = [n for k in range(i0, i0 + a) for n in en_nums_list[k]]
        zh_nums = [n for k in range(j0, j0 + b) for n in zh_nums_list[k]]
        if en_nums or zh_nums:
            unmatched = len(set(en_nums) ^ set(zh_nums))
            cost += 2.0 * min(unmatched, 3)
        # 段落末尾应该同时结束
        if a and b and en_sents[i0 + a - 1]["para_end"] != zh_sents[j0 + b - 1]["para_end"]:
            cost += 0.8
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
        exp_dur = max(0.7, 0.25 + lens[i - 1] * sec_per_char * 0.92)
        for j in range(i, M - (N - i) + 1):
            for k in range(max(i - 1, j - 8), j):
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
                    if gap > 0.75:
                        internal_gap_cost += ((gap - 0.5) / 0.3) ** 2 * 2.5
                    else:
                        internal_gap_cost += (gap / 0.6) ** 2 * 0.5

                boundary_cost = 0.0
                if j < M:
                    gap_after = chunks[j][0] - chunks[j - 1][1]
                    if gap_after < 0.75:
                        boundary_cost += ((0.75 - gap_after) / 0.12) ** 2
                    if is_para_end and gap_after < 1.1:
                        boundary_cost += 6.0

                cost = dp[i - 1][k] + dur_cost + internal_gap_cost + boundary_cost
                if cost < dp[i][j]:
                    dp[i][j] = cost
                    parent[i][j] = k

    aligned = []
    curr = M
    for i in range(N, 0, -1):
        prev = parent[i][curr]
        aligned.append((chunks[prev][0], chunks[curr - 1][1]))
        curr = prev
    aligned.reverse()

    return [make_item(idx, s, e) for idx, (s, e) in enumerate(aligned)]


def format_srt_time(seconds: float) -> str:
    ms = int(round((seconds - int(seconds)) * 1000))
    total_sec = int(seconds)
    s = total_sec % 60
    m = (total_sec // 60) % 60
    h = total_sec // 3600
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def process_directory(folder: Path):
    mp3_files = sorted(folder.glob("*.mp3"))
    txt_files = [
        p for p in sorted(list(folder.glob("*.txt")) + list(folder.glob("*.md")))
        if p.name.lower() not in ("subtitles.txt", "readme.md")
    ]
    if not mp3_files or len(txt_files) < 1:
        print(f"跳过 {folder}: 未找到 mp3 或 txt/md 文件")
        return

    mp3_path = mp3_files[0]
    en_text, zh_text = "", ""
    for txt_path in txt_files:
        content = txt_path.read_text(encoding="utf-8", errors="ignore")
        if is_chinese_text(content):
            zh_text = content
        else:
            en_text = content

    en_sents = split_english_sentences(en_text)
    zh_sents = split_chinese_sentences(zh_text)
    units = align_bilingual(en_sents, zh_sents)
    chunks = detect_audio_chunks(mp3_path)
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
    target = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).parent / "resources"
    if target.is_dir():
        process_directory(target)
        for sub in sorted(target.iterdir()):
            if sub.is_dir():
                process_directory(sub)

