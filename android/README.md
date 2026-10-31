# Android 端（笔记管理器）

这是根据 `C:\Users\4zyz4\Desktop\笔记管理器.apk`（versionCode 6 / 1.0.2）
逆向整理并重写的 Android 客户端，配合本仓库的手环端（Vela 快应用）使用。

## 1. 目录

```
android/
├─ app/
│  ├─ libs/xms-wearable-lib_1.4_release.aar   小米穿戴 SDK
│  ├─ src/main/AndroidManifest.xml
│  ├─ src/main/java/com/zyz4/notebook/
│  │  ├─ App.java                 Application，持有全局 NoteLink
│  │  ├─ MainActivity.java        首页：连接状态 + 笔记列表
│  │  ├─ NoteEditActivity.java    编辑页：分片保存
│  │  ├─ NoteLink.java            小米穿戴 SDK / 握手 / 协议分发
│  │  ├─ NoteProtocol.java        JSON 协议构造
│  │  ├─ LocalNoteStore.java      本地镜像（兼容旧协议反向请求）
│  │  ├─ Utf8Chunks.java          UTF-8 安全分片
│  │  ├─ NotePreview.java
│  │  └─ NoteAdapter.java
│  └─ src/main/res/               深色 UI、图标、连接状态矢量图
├─ keystore/notebook.p12         由 sign/private.pem + sign/certificate.pem 生成
├─ gradle/                       Gradle 9.7.1 wrapper
└─ build.gradle / settings.gradle
```

## 2. 构建

环境：JDK 17+、Android SDK Platform 36、Build Tools 36.x。

```powershell
cd android
.\gradlew.bat assembleRelease
```

产物：

```
android/app/build/outputs/apk/release/app-release.apk
```

仓库里已经放了一份构建结果：

```
dist/com.zyz4.notebook.release.2.2.0.apk
```

## 3. 签名与包名

- 包名：`com.zyz4.notebook`，与手环 `src/manifest.json` 的 `package` 必须完全一致。
- 签名：`android/keystore/notebook.p12` 由仓库内 `sign/private.pem` 和
  `sign/certificate.pem` 生成；证书 SHA-256 与原 APK 一致：
  `483ebb32069ff38f6a44be4d79028d96539a9afa8746b92b2b1fbb2351bc7ffc`。
- 因此新 APK 可以直接覆盖安装旧版（versionCode 7 > 6），并且能与手环 RPK 建立
  interconnect 通信。

重新生成 keystore（如果需要）：

```powershell
& "C:\Program Files\Git\usr\bin\openssl.exe" pkcs12 -export `
  -inkey ..\sign\private.pem -in ..\sign\certificate.pem `
  -out keystore\notebook.p12 -name notebook -passout pass:notebook
```

## 4. 协议

详见 [../docs/segmented-transfer-v2.md](../docs/segmented-transfer-v2.md)。

Android 端会优先使用协议 v2：

- 读取：`note_open` → `note_meta` → 循环 `note_read` / `note_chunk`
  → `note_close`；
- 保存：`note_write_begin` → 逐片 `note_write_chunk` / `note_write_ack`
  → `note_write_commit` → `note_write_success`。

如果手环只返回旧版 `notes_preview`（没有 `protocol: 2`），会自动退回：

- 读取：`request_full_note` / `full_note_response`；
- 保存：`update_note` / `create_note`。

## 5. 验证记录

- `android/` 使用 AGP 9.4.1 + Gradle 9.7.1 构建通过（debug / release）。
- 首页和编辑页已按 `systemBars + displayCutout` insets 设置根布局 padding，
  并设置 `windowLayoutInDisplayCutoutMode=never`，避免内容进入刘海/挖孔区域；
  编辑页同时处理 IME inset，键盘弹出时编辑框不会被遮挡。
- release APK 证书 SHA-256 与原 APK 一致。
- 手环端 `npx aiot release --enable-jsc` 构建通过。
- `textSegments.js` 在 Node 模拟 `@system/file` 下通过：
  - UTF-8 计数 / 切段 / 代理对；
  - 分段写入、索引读取、原地保存；
  - `importTextFile`（临时整篇文件 → 分段笔记）；
  - 编辑插入/删除。
- 手环传输协议在 Node 模拟 interconnect + `@system/file` 下通过：
  - `note_open/note_read/note_chunk` 全量读取；
  - `note_write_begin/chunk/ack/commit` 上传并落盘；
  - 分片重发去重、`created` 标志、更新已有笔记。
