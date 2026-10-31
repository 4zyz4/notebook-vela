package com.zyz4.notebook;

import org.json.JSONException;
import org.json.JSONObject;

/**
 * 手机端与手环端之间的 JSON 消息协议。
 *
 * <p>协议版本 2 增加按字符区间读取与分片上传，手环内部再映射到 128 字节的文本段：
 * <pre>
 * 手机 -> 手环
 *   note_open          {requestId,noteId}
 *   note_read          {requestId,noteId,from,count}
 *   note_close         {requestId}
 *   note_write_begin   {requestId,noteId?,totalBytes,charCount}
 *   note_write_chunk   {requestId,seq,text}
 *   note_write_commit  {requestId}
 *   note_write_abort   {requestId}
 *
 * 手环 -> 手机
 *   note_meta          {requestId,noteId,segBytes,totalBytes,charCount,segmentCount}
 *   note_chunk         {requestId,noteId,from,text,done}
 *   note_write_ready   {requestId,noteId?}
 *   note_write_ack     {requestId,seq}
 *   note_write_success {requestId,noteId,created}
 *   note_write_error   {requestId,noteId?,error}
 * </pre>
 * 旧版消息（request_full_note/full_note_response、create_note/update_note、
 * delete_note 等）仍然保留，用于兼容旧手环。</p>
 */
public final class NoteProtocol {
    public static final int PROTOCOL_VERSION = 2;

    public static final String TYPE_HANDSHAKE = "__hs__";
    public static final String TYPE_REQUEST_PREVIEW = "request_notes_preview";
    public static final String TYPE_PREVIEW = "notes_preview";

    public static final String TYPE_NOTE_OPEN = "note_open";
    public static final String TYPE_NOTE_META = "note_meta";
    public static final String TYPE_NOTE_READ = "note_read";
    public static final String TYPE_NOTE_CHUNK = "note_chunk";
    public static final String TYPE_NOTE_CLOSE = "note_close";
    public static final String TYPE_NOTE_NOT_FOUND = "note_not_found";
    public static final String TYPE_NOTE_ERROR = "note_error";

    public static final String TYPE_WRITE_BEGIN = "note_write_begin";
    public static final String TYPE_WRITE_READY = "note_write_ready";
    public static final String TYPE_WRITE_CHUNK = "note_write_chunk";
    public static final String TYPE_WRITE_ACK = "note_write_ack";
    public static final String TYPE_WRITE_COMMIT = "note_write_commit";
    public static final String TYPE_WRITE_ABORT = "note_write_abort";
    public static final String TYPE_WRITE_SUCCESS = "note_write_success";
    public static final String TYPE_WRITE_ERROR = "note_write_error";

    public static final String TYPE_REQUEST_FULL = "request_full_note";
    public static final String TYPE_FULL_RESPONSE = "full_note_response";
    public static final String TYPE_UPDATE = "update_note";
    public static final String TYPE_CREATE = "create_note";
    public static final String TYPE_DELETE = "delete_note";

    public static final String TYPE_UPDATE_SUCCESS = "update_success";
    public static final String TYPE_UPDATE_ERROR = "update_error";
    public static final String TYPE_CREATE_SUCCESS = "create_success";
    public static final String TYPE_CREATE_ERROR = "create_error";
    public static final String TYPE_DELETE_SUCCESS = "delete_success";
    public static final String TYPE_DELETE_ERROR = "delete_error";

    private NoteProtocol() {
    }

    public static String handshake(int count) {
        return "{\"tag\":\"__hs__\",\"count\":" + count + "}";
    }

    public static String requestPreviews() {
        return "{\"type\":\"" + TYPE_REQUEST_PREVIEW + "\"}";
    }

    public static String noteOpen(String requestId, String noteId) {
        return object(
                TYPE_NOTE_OPEN,
                "requestId", requestId,
                "noteId", noteId
        );
    }

    public static String noteRead(String requestId, String noteId, int from, int count) {
        JSONObject json = base(TYPE_NOTE_READ);
        put(json, "requestId", requestId);
        put(json, "noteId", noteId);
        put(json, "from", from);
        put(json, "count", count);
        return json.toString();
    }

    public static String noteClose(String requestId) {
        return object(TYPE_NOTE_CLOSE, "requestId", requestId);
    }

    public static String writeBegin(String requestId, String noteId, int totalBytes, int charCount) {
        JSONObject json = base(TYPE_WRITE_BEGIN);
        put(json, "requestId", requestId);
        if (noteId != null) {
            put(json, "noteId", noteId);
        }
        put(json, "totalBytes", totalBytes);
        put(json, "charCount", charCount);
        return json.toString();
    }

    public static String writeChunk(String requestId, int seq, String text) {
        JSONObject json = base(TYPE_WRITE_CHUNK);
        put(json, "requestId", requestId);
        put(json, "seq", seq);
        put(json, "text", text);
        return json.toString();
    }

    public static String writeCommit(String requestId) {
        return object(TYPE_WRITE_COMMIT, "requestId", requestId);
    }

    public static String writeAbort(String requestId) {
        return object(TYPE_WRITE_ABORT, "requestId", requestId);
    }

    public static String deleteNote(String noteId) {
        return object(TYPE_DELETE, "noteId", noteId);
    }

    public static String requestFullNote(String noteId) {
        return object(TYPE_REQUEST_FULL, "noteId", noteId);
    }

    public static String legacyUpdateNote(String noteId, String content) {
        return object(TYPE_UPDATE, "noteId", noteId, "content", content);
    }

    public static String legacyCreateNote(String content) {
        return object(TYPE_CREATE, "content", content);
    }

    public static String fullNoteResponse(String noteId, String content) {
        return object(TYPE_FULL_RESPONSE, "noteId", noteId, "content", content);
    }

    public static String noteNotFound(String noteId) {
        return object(TYPE_NOTE_NOT_FOUND, "noteId", noteId);
    }

    public static String updateSuccess(String noteId) {
        return object(TYPE_UPDATE_SUCCESS, "noteId", noteId);
    }

    public static String createSuccess(String noteId) {
        return object(TYPE_CREATE_SUCCESS, "noteId", noteId);
    }

    public static String deleteSuccess(String noteId) {
        return object(TYPE_DELETE_SUCCESS, "noteId", noteId);
    }

    public static String updateError(String noteId, String error) {
        return object(TYPE_UPDATE_ERROR, "noteId", noteId, "error", error);
    }

    public static String createError(String noteId, String error) {
        return object(TYPE_CREATE_ERROR, "noteId", noteId, "error", error);
    }

    public static String deleteError(String noteId, String error) {
        return object(TYPE_DELETE_ERROR, "noteId", noteId, "error", error);
    }

    public static JSONObject parse(String raw) {
        if (raw == null || raw.isEmpty()) {
            return null;
        }
        try {
            return new JSONObject(raw);
        } catch (JSONException e) {
            return null;
        }
    }

    private static JSONObject base(String type) {
        JSONObject json = new JSONObject();
        put(json, "type", type);
        return json;
    }

    private static String object(String type, String... keyValues) {
        JSONObject json = base(type);
        for (int i = 0; i + 1 < keyValues.length; i += 2) {
            put(json, keyValues[i], keyValues[i + 1]);
        }
        return json.toString();
    }

    private static void put(JSONObject json, String key, Object value) {
        try {
            json.put(key, value);
        } catch (JSONException ignored) {
        }
    }
}
