package com.zyz4.notebook;

/**
 * 手机端使用的笔记预览模型。
 *
 * <p>字段来自手环的 {@code notes_preview} 消息；时间戳为 0 表示旧版手环没有提供。</p>
 */
public final class NotePreview {
    public final String id;
    public final String preview;
    public final long createTime;
    public final long modifyTime;

    public NotePreview(String id, String preview, long createTime, long modifyTime) {
        this.id = id == null ? "" : id;
        this.preview = preview == null ? "" : preview;
        this.createTime = createTime;
        this.modifyTime = modifyTime;
    }
}
