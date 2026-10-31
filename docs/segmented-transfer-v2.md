# 笔记同步协议 v2（文本分段架构）

## 1. 背景

手环端从 2.1.0 开始把笔记按 **128 字节一个文本段** 存储：

```
internal://files/note_<id>.txt        纯 UTF-8 文本（兼容旧路径）
internal://files/note_<id>.txt.idx    段表：每段的 byteLen / charLen
```

编辑器只加载当前窗口内的段，保存时流式重写。旧 Android 端一次性收发整篇
`content`，在长笔记上会导致：

1. 手环端为了回一个 JSON 又要把整篇拼出来，分段失去意义；
2. 单条 interconnect 消息过大，容易超时/失败；
3. 旧 `saveNoteFile` 使用整篇 `writeText`，会让 `.idx` 失效。

协议 v2 改为 **按字符区间读取 + 按 UTF-8 安全分片上写**。手环端内部仍然使用
128 字节段，Android 端不需要知道段表，只需要总字符数和一段一段的文本。

## 2. 能力发现

手环在 `notes_preview` 中带上：

```json
{
  "type": "notes_preview",
  "protocol": 2,
  "previews": [
    {
      "id": "1720000000000",
      "preview": "第一行预览",
      "createTime": 1720000000000,
      "modifyTime": 1720000000000
    }
  ]
}
```

Android 收到 `protocol >= 2` 时使用 v2；没有该字段时按旧协议处理。

`createTime` / `modifyTime` 为毫秒时间戳。Android 首页会为每条笔记同时显示这两个时间；
旧版手环未提供时显示“未记录”。

握手保持不变：

```json
{"tag":"__hs__","count":0}
```

## 3. 读取

```
Android                         手环
  |  note_open {requestId,noteId}  |
  |------------------------------->|
  |  note_meta {charCount,...}     |
  |<-------------------------------|
  |  note_read {from,count}        |
  |------------------------------->|
  |  note_chunk {from,text,done}   |
  |<-------------------------------|
  |  ...循环直到 done=true...       |
  |  note_close {requestId}        |
  |------------------------------->|
```

### note_meta

```json
{
  "type": "note_meta",
  "requestId": "dl_...",
  "noteId": "1720000000000",
  "segBytes": 128,
  "totalBytes": 1234,
  "charCount": 456,
  "segmentCount": 10
}
```

- `charCount` 是 UTF-16 code unit 数，与 Android `String.length()` 一致。
- `segmentCount` 只用于展示/调试，Android 不依赖段表。

### note_read

```json
{"type":"note_read","requestId":"dl_...","noteId":"...","from":0,"count":2048}
```

手环处理：

1. `locate(doc, from)` / `locate(doc, end-1)` 找到覆盖到的段；
2. `loadRange` 只加载这些段；
3. `getRange` 拼出当前窗口；
4. 如果 `end` 正好把代理对（emoji）切开，向后多取一个 code unit；
5. `setWindow` 逐出窗口外的干净段。

### note_chunk

```json
{
  "type": "note_chunk",
  "requestId": "dl_...",
  "noteId": "...",
  "from": 0,
  "text": "这一段文本",
  "done": false
}
```

Android 按 `text.length()` 推进偏移；`done=true` 时结束。

## 4. 写入

```
Android                              手环
  | note_write_begin {totalBytes,...}  |
  |----------------------------------->|
  | note_write_ready                   |
  |<-----------------------------------|
  | note_write_chunk {seq,text}        |
  |----------------------------------->|
  | note_write_ack {seq}               |
  |<-----------------------------------|
  | ...循环...                          |
  | note_write_commit                  |
  |----------------------------------->|
  | note_write_success {noteId,created}|
  |<-----------------------------------|
```

### 分片规则

Android 使用 `Utf8Chunks.split(content, 2048)`：

- 每片最多 2048 个 UTF-8 字节；
- 按 code point 切分，不会把代理对劈成两半；
- `totalBytes` 与 `charCount` 分别用于手环校验。

### 手环落盘

1. `note_write_begin` 创建 `internal://files/upload_<requestId>.txt`；
2. 每个 `note_write_chunk` 追加写入临时文件，成功后回 `note_write_ack`；
3. `note_write_commit` 调用 `importTextFile(tmpUri, noteUri, 128)`：
   - `openDoc(tmpUri)` 只扫描临时文件建立段表；
   - `writeDocToUri` 按段流式写入 `note_<id>.txt.import`；
   - 成功后复制到正式文件，再 `commitDoc` 写 `.idx`；
   - 失败时删除 staging，不破坏原笔记；
4. 更新 `metadata.json` 的 `createTime/modifyTime`；
5. 回 `note_write_success`，删除临时文件和临时 idx。

### 重传与去重

- 手环记录 `seq`，重复的片只回 ACK，不重复追加；
- Android 等待 ACK 超时会重发同一片，最多 2 次；
- 手环校验字节数/字符数，不一致直接 `note_write_error`。

## 5. 兼容矩阵

| Android | 手环 | 读取 | 写入 |
| --- | --- | --- | --- |
| 旧版 | 2.1.0+ | `request_full_note` → `full_note_response`（整篇） | `update_note` / `create_note`（手环内部改为分段写） |
| 新版 | 旧版 | `request_full_note` → `full_note_response` | `update_note` / `create_note` |
| 新版 | 2.2.0+ | `note_open` / `note_read` / `note_chunk` | `note_write_*` 分片上传 |

## 6. 错误消息

```json
{"type":"note_error","requestId":"...","noteId":"...","error":"读取分段失败"}
{"type":"note_write_error","requestId":"...","noteId":"...","error":"导入分段失败: ..."}
```

- `note_not_found`：笔记不存在；
- `note_error`：读取/打开失败；
- `note_write_error`：临时文件、校验、导入或元数据失败。

## 7. 关键实现位置

| 功能 | 文件 |
| --- | --- |
| 段模型 / 读写 / 导入 | `src/Common/textSegments.js` |
| 手环协议处理 | `src/index/index.ux` |
| 手环整篇保存兼容 | `src/Common/utils.js` 的 `saveNoteFile` |
| Android 协议构造 | `android/app/src/main/java/com/zyz4/notebook/NoteProtocol.java` |
| Android 连接/分发 | `android/app/src/main/java/com/zyz4/notebook/NoteLink.java` |
| Android UTF-8 分片 | `android/app/src/main/java/com/zyz4/notebook/Utf8Chunks.java` |
