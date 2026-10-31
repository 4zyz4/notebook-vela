package com.zyz4.notebook;

import java.util.ArrayList;
import java.util.List;

/**
 * UTF-8 安全切分工具。
 *
 * <p>手机端上传时必须按 UTF-8 字节数分片，且不能把代理对（emoji 等）切成两半；
 * 否则手环端逐片拼接后再按 128 字节建段，会出现 U+FFFD 替换字符。</p>
 */
public final class Utf8Chunks {
    private Utf8Chunks() {
    }

    public static List<String> split(String text, int maxBytes) {
        List<String> chunks = new ArrayList<>();
        if (text == null || text.isEmpty()) {
            chunks.add("");
            return chunks;
        }
        if (maxBytes < 4) {
            maxBytes = 4;
        }
        int start = 0;
        int bytes = 0;
        int i = 0;
        while (i < text.length()) {
            int codePoint = text.codePointAt(i);
            int len = length(codePoint);
            if (bytes + len > maxBytes && i > start) {
                chunks.add(text.substring(start, i));
                start = i;
                bytes = 0;
            }
            bytes += len;
            i += Character.charCount(codePoint);
        }
        if (start < text.length()) {
            chunks.add(text.substring(start));
        }
        if (chunks.isEmpty()) {
            chunks.add("");
        }
        return chunks;
    }

    public static int length(String text) {
        if (text == null) {
            return 0;
        }
        int bytes = 0;
        int i = 0;
        while (i < text.length()) {
            int codePoint = text.codePointAt(i);
            bytes += length(codePoint);
            i += Character.charCount(codePoint);
        }
        return bytes;
    }

    public static int length(int codePoint) {
        if (codePoint <= 0x7F) {
            return 1;
        }
        if (codePoint <= 0x7FF) {
            return 2;
        }
        if (codePoint <= 0xFFFF) {
            return 3;
        }
        return 4;
    }
}
