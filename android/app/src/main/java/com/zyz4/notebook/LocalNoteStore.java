package com.zyz4.notebook;

import android.content.Context;
import android.util.Log;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;

/**
 * 手机端本地镜像。
 *
 * <p>手环是笔记的权威数据源；这里保存一份最近一次完整内容，主要用于：
 * <ul>
 *   <li>手环通过旧协议 {@code request_full_note} 反向请求手机内容时可直接回复；</li>
 *   <li>保存成功后保留一份本地副本，方便排查与后续离线能力扩展。</li>
 * </ul>
 * 目录结构与旧版 Android 端保持一致：{@code files/notes/<id>.txt} 和
 * {@code files/metadata.json}。</p>
 */
public final class LocalNoteStore {
    private static final String TAG = "LocalNoteStore";
    private static final String META_FILE = "metadata.json";
    private static final String NOTES_DIR = "notes";

    private final File notesDir;
    private final File metadataFile;
    private final Object lock = new Object();

    public LocalNoteStore(Context context) {
        notesDir = new File(context.getFilesDir(), NOTES_DIR);
        metadataFile = new File(context.getFilesDir(), META_FILE);
        if (!notesDir.exists()) {
            //noinspection ResultOfMethodCallIgnored
            notesDir.mkdirs();
        }
    }

    public String read(String noteId) {
        File file = noteFile(noteId);
        if (!file.exists()) {
            return null;
        }
        try {
            return readText(file);
        } catch (IOException e) {
            Log.w(TAG, "read note failed: " + noteId, e);
            return null;
        }
    }

    public String readHead(String noteId, int maxBytes) {
        File file = noteFile(noteId);
        if (!file.exists()) {
            return null;
        }
        try (InputStream in = new FileInputStream(file)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[Math.max(16, maxBytes)];
            int read = in.read(buffer);
            if (read > 0) {
                out.write(buffer, 0, read);
            }
            return out.toString(StandardCharsets.UTF_8.name());
        } catch (IOException e) {
            Log.w(TAG, "read note head failed: " + noteId, e);
            return null;
        }
    }

    public boolean exists(String noteId) {
        return noteFile(noteId).exists();
    }

    public void save(String noteId, String content, Long createTime, long modifyTime) {
        if (noteId == null || noteId.isEmpty()) {
            return;
        }
        synchronized (lock) {
            File target = noteFile(noteId);
            File temp = new File(notesDir, noteId + ".txt.tmp");
            try (FileOutputStream out = new FileOutputStream(temp)) {
                out.write((content == null ? "" : content).getBytes(StandardCharsets.UTF_8));
                out.flush();
                if (target.exists() && !target.delete()) {
                    Log.w(TAG, "delete old note failed: " + target);
                }
                if (!temp.renameTo(target)) {
                    Log.w(TAG, "rename note failed: " + temp + " -> " + target);
                }
            } catch (IOException e) {
                Log.w(TAG, "save note failed: " + noteId, e);
                return;
            }
            updateMetadata(noteId, createTime, modifyTime);
        }
    }

    public void delete(String noteId) {
        if (noteId == null || noteId.isEmpty()) {
            return;
        }
        synchronized (lock) {
            File file = noteFile(noteId);
            if (file.exists()) {
                //noinspection ResultOfMethodCallIgnored
                file.delete();
            }
            JSONObject metadata = readMetadata();
            JSONObject notes = metadata.optJSONObject("notes");
            if (notes != null) {
                notes.remove(noteId);
                writeMetadata(metadata);
            }
        }
    }

    /** 本地缓存的笔记元数据，只用于反向请求和调试，不参与首页列表排序。 */
    public List<NotePreview> list() {
        List<NotePreview> result = new ArrayList<>();
        synchronized (lock) {
            JSONObject metadata = readMetadata();
            JSONObject notes = metadata.optJSONObject("notes");
            if (notes == null) {
                return result;
            }
            Iterator<String> keys = notes.keys();
            while (keys.hasNext()) {
                String id = keys.next();
                if (!noteFile(id).exists()) {
                    continue;
                }
                JSONObject info = notes.optJSONObject(id);
                long createTime = info == null ? 0 : info.optLong("createTime", 0);
                long modifyTime = info == null ? 0 : info.optLong("modifyTime", 0);
                String head = readHead(id, 96);
                String preview = head == null ? "" : head;
                int bar = preview.indexOf('|');
                if (bar >= 0) {
                    preview = preview.substring(0, bar);
                }
                if (preview.length() > 32) {
                    preview = preview.substring(0, 32);
                }
                result.add(new NotePreview(id, preview, createTime, modifyTime));
            }
        }
        return result;
    }

    private File noteFile(String noteId) {
        return new File(notesDir, noteId + ".txt");
    }

    private void updateMetadata(String noteId, Long createTime, long modifyTime) {
        JSONObject metadata = readMetadata();
        JSONObject notes = metadata.optJSONObject("notes");
        if (notes == null) {
            notes = new JSONObject();
            try {
                metadata.put("notes", notes);
            } catch (JSONException ignored) {
                return;
            }
        }
        try {
            JSONObject info = notes.optJSONObject(noteId);
            if (info == null) {
                info = new JSONObject();
                info.put("createTime", createTime == null ? modifyTime : createTime);
            }
            info.put("modifyTime", modifyTime);
            notes.put(noteId, info);
        } catch (JSONException e) {
            Log.w(TAG, "update metadata failed", e);
            return;
        }
        writeMetadata(metadata);
    }

    private JSONObject readMetadata() {
        if (!metadataFile.exists()) {
            return emptyMetadata();
        }
        try {
            JSONObject json = new JSONObject(readText(metadataFile));
            if (json.optJSONObject("notes") == null) {
                json.put("notes", new JSONObject());
            }
            return json;
        } catch (Exception e) {
            Log.w(TAG, "parse metadata failed", e);
            return emptyMetadata();
        }
    }

    private JSONObject emptyMetadata() {
        JSONObject json = new JSONObject();
        try {
            json.put("notes", new JSONObject());
        } catch (JSONException ignored) {
        }
        return json;
    }

    private void writeMetadata(JSONObject metadata) {
        File temp = new File(metadataFile.getParentFile(), META_FILE + ".tmp");
        try (FileOutputStream out = new FileOutputStream(temp)) {
            out.write(metadata.toString().getBytes(StandardCharsets.UTF_8));
            out.flush();
            if (metadataFile.exists() && !metadataFile.delete()) {
                Log.w(TAG, "delete old metadata failed");
            }
            if (!temp.renameTo(metadataFile)) {
                Log.w(TAG, "rename metadata failed");
            }
        } catch (IOException e) {
            Log.w(TAG, "write metadata failed", e);
        }
    }

    private static String readText(File file) throws IOException {
        try (InputStream in = new FileInputStream(file)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[4096];
            int read;
            while ((read = in.read(buffer)) != -1) {
                out.write(buffer, 0, read);
            }
            return out.toString(StandardCharsets.UTF_8.name());
        }
    }
}
