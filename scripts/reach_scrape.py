"""Scrapling 抓取脚本：URL -> 正文提取，stdout 输出 JSON。

用法:
    python reach_scrape.py <url> [--timeout 25] [--max-chars 4000]

输出（单行 JSON）:
    {"ok": true,  "title": "...", "text": "..."}
    {"ok": false, "error": "..."}

依赖（bot 运行不强制要求；未安装时 bot 侧自动跳过该层）:
    pip install "scrapling[fetchers]" markdownify

说明: 只用 Scrapling 的 Fetcher（curl_cffi TLS 指纹伪装的 HTTP 层，无需下载浏览器）。
StealthyFetcher/DynamicFetcher（Camoufox/Playwright 浏览器渲染）留作可选增强，
需要时 bot 侧的 L4 patchright 层承担渲染职责。
"""

import argparse
import json
import sys


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("url")
    ap.add_argument("--timeout", type=int, default=25)
    ap.add_argument("--max-chars", type=int, default=4000)
    args = ap.parse_args()

    try:
        from scrapling.fetchers import Fetcher
    except ImportError:
        print(json.dumps({"ok": False, "error": "scrapling-not-installed"}, ensure_ascii=False))
        return

    try:
        page = Fetcher.get(
            args.url,
            timeout=args.timeout,
            stealthy_headers=True,
            follow_redirects=True,
        )
    except Exception as exc:  # 网络/TLS/解析异常统一按失败处理
        print(json.dumps({"ok": False, "error": str(exc)[:200]}, ensure_ascii=False))
        return

    status = getattr(page, "status", 0)
    if status and status >= 400:
        print(json.dumps({"ok": False, "error": "HTTP %s" % status}, ensure_ascii=False))
        return

    # 标题
    title = ""
    try:
        nodes = page.css("title")
        if nodes:
            title = (nodes[0].text or "").strip()[:200]
    except Exception:
        pass

    # 正文：优先 markdown（保留结构，AI 总结更稳），退化为纯文本
    text = ""
    try:
        text = page.markdown() or ""
    except Exception:
        try:
            text = page.get_all_text() or ""
        except Exception:
            text = ""

    text = " ".join(str(text).split())
    if not text:
        print(json.dumps({"ok": False, "error": "empty-content"}, ensure_ascii=False))
        return

    print(json.dumps({"ok": True, "title": title, "text": text[: args.max_chars]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
