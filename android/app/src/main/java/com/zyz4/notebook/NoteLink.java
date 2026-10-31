package com.zyz4.notebook;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import androidx.annotation.NonNull;

import com.xiaomi.xms.wearable.Wearable;
import com.xiaomi.xms.wearable.auth.AuthApi;
import com.xiaomi.xms.wearable.auth.Permission;
import com.xiaomi.xms.wearable.message.MessageApi;
import com.xiaomi.xms.wearable.message.OnMessageReceivedListener;
import com.xiaomi.xms.wearable.node.DataItem;
import com.xiaomi.xms.wearable.node.DataSubscribeResult;
import com.xiaomi.xms.wearable.node.Node;
import com.xiaomi.xms.wearable.node.NodeApi;
import com.xiaomi.xms.wearable.node.OnDataChangedListener;

import org.json.JSONArray;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * 手环通信层（替代旧版 Android 端混淆后的 {@code V0.x0}）。
 *
 * <p>职责：</p>
 * <ul>
 *   <li>通过小米穿戴 SDK 找到已连接节点、申请权限、注册消息监听；</li>
 *   <li>握手与连接状态维护；</li>
 *   <li>按字符区间向手环读取笔记（手环内部按 128 字节段加载）；</li>
 *   <li>把编辑后的全文切成 UTF-8 安全的分片，逐片上传，手环再导入为分段笔记；</li>
 *   <li>兼容旧版整篇 {@code full_note_response}/{@code update_note} 协议。</li>
 * </ul>
 */
public final class NoteLink {
    private static final String TAG = "NoteLink";
    private static final String HS_TAG = "__hs__";

    private static final int READ_CHUNK_CHARS = 2048;
    private static final int WRITE_CHUNK_BYTES = 2048;

    private static final long HANDSHAKE_TIMEOUT_MS = 12_000;
    private static final long CONNECT_RETRY_DELAY_MS = 5_000;
    private static final long DOWNLOAD_META_TIMEOUT_MS = 15_000;
    private static final long DOWNLOAD_CHUNK_TIMEOUT_MS = 20_000;
    private static final long UPLOAD_BEGIN_TIMEOUT_MS = 15_000;
    private static final long UPLOAD_ACK_TIMEOUT_MS = 8_000;
    private static final long UPLOAD_COMMIT_TIMEOUT_MS = 90_000;
    private static final long LEGACY_TIMEOUT_MS = 20_000;
    private static final long DELETE_TIMEOUT_MS = 12_000;
    private static final int MAX_RETRY_ATTEMPTS = 12;

    public enum State {
        DISCONNECTED,
        CONNECTING,
        CONNECTED,
        APP_NOT_INSTALLED,
        FAILED
    }

    public interface ConnectionListener {
        void onConnectionChanged(State state, String nodeName, String description);

        void onPreviews(List<NotePreview> previews);
    }

    public interface DownloadCallback {
        void onProgress(int percent);

        void onSuccess(String noteId, String content, int charCount, int segmentCount);

        void onError(String message);
    }

    public interface UploadCallback {
        void onProgress(int percent);

        void onSuccess(String noteId, boolean created);

        void onError(String message);
    }

    public interface DeleteCallback {
        void onSuccess(String noteId);

        void onError(String noteId, String message);
    }

    private final NodeApi nodeApi;
    private final AuthApi authApi;
    private final MessageApi messageApi;
    private final LocalNoteStore store;

    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService ioExecutor = Executors.newSingleThreadExecutor();
    private final CopyOnWriteArrayList<ConnectionListener> listeners = new CopyOnWriteArrayList<>();
    private final Map<String, DownloadTask> downloads = new ConcurrentHashMap<>();
    private final Map<String, DownloadTask> legacyDownloads = new ConcurrentHashMap<>();
    private final Map<String, UploadTask> uploads = new ConcurrentHashMap<>();
    private final CopyOnWriteArrayList<UploadTask> legacyUploads = new CopyOnWriteArrayList<>();
    private final Map<String, DeleteCallback> deleteCallbacks = new ConcurrentHashMap<>();
    private final AtomicInteger requestSeq = new AtomicInteger();

    private volatile State state = State.DISCONNECTED;
    private volatile String stateDescription = "";
    private volatile int protocolVersion = 1;
    private volatile String currentNodeName;

    private Node node;
    private boolean connecting;
    private boolean handshaken;
    private boolean messageListenerRegistered;
    private int retryAttempts;

    private final Runnable handshakeTimeoutRunnable = () -> {
        if (!handshaken) {
            failConnection("连接超时，请确认手环已打开笔记本应用");
        }
    };

    private final Runnable retryRunnable = () -> {
        if (state == State.CONNECTED || state == State.CONNECTING) {
            return;
        }
        resetSession(false);
        doConnect();
    };

    private final OnMessageReceivedListener messageListener = new OnMessageReceivedListener() {
        @Override
        public void onMessageReceived(@NonNull String nodeId, @NonNull byte[] message) {
            String raw = new String(message, StandardCharsets.UTF_8);
            main.post(() -> handleRawMessage(raw));
        }
    };

    private final OnDataChangedListener dataListener = new OnDataChangedListener() {
        @Override
        public void onDataChanged(@NonNull String nodeId,
                                  @NonNull DataItem dataItem,
                                  @NonNull DataSubscribeResult data) {
            main.post(() -> handleDataChanged(dataItem, data));
        }
    };

    public NoteLink(Context context) {
        Context app = context.getApplicationContext();
        nodeApi = Wearable.getNodeApi(app);
        authApi = Wearable.getAuthApi(app);
        messageApi = Wearable.getMessageApi(app);
        store = new LocalNoteStore(app);
    }

    // ===== 对外 API =====

    public void addListener(ConnectionListener listener) {
        if (listener != null && !listeners.contains(listener)) {
            listeners.add(listener);
            listener.onConnectionChanged(state, currentNodeName, stateDescription);
        }
    }

    public void removeListener(ConnectionListener listener) {
        if (listener != null) {
            listeners.remove(listener);
        }
    }

    public State getState() {
        return state;
    }

    public int getProtocolVersion() {
        return protocolVersion;
    }

    public boolean isConnected() {
        return state == State.CONNECTED && handshaken;
    }

    /**
     * 首次连接。已连接或正在连接时不会重复发起。
     */
    public void connect() {
        main.post(() -> {
            if (state == State.CONNECTED || state == State.CONNECTING || connecting) {
                return;
            }
            doConnect();
        });
    }

    /**
     * 用户主动重试：清空退避计数并重新发现设备。
     */
    public void retry() {
        main.post(() -> {
            main.removeCallbacks(retryRunnable);
            main.removeCallbacks(handshakeTimeoutRunnable);
            retryAttempts = 0;
            resetSession(true);
            doConnect();
        });
    }

    /**
     * 页面恢复时调用：已握手则刷新列表，否则尝试连接。
     */
    public void refresh() {
        main.post(() -> {
            if (handshaken && node != null) {
                requestPreviewsNow();
            } else if (state != State.CONNECTING && !connecting) {
                doConnect();
            }
        });
    }

    public void requestPreviews() {
        main.post(this::requestPreviewsNow);
    }

    public void downloadNote(String noteId, DownloadCallback callback) {
        if (noteId == null || noteId.isEmpty()) {
            callback.onError("笔记 ID 为空");
            return;
        }
        if (!isConnected()) {
            callback.onError("请先连接手环");
            return;
        }
        main.post(() -> {
            DownloadTask task = new DownloadTask(noteId, callback);
            if (protocolVersion >= NoteProtocol.PROTOCOL_VERSION) {
                task.startV2();
            } else {
                task.startLegacy();
            }
        });
    }

    public void uploadNote(String noteId, String content, UploadCallback callback) {
        if (!isConnected()) {
            callback.onError("请先连接手环");
            return;
        }
        main.post(() -> {
            UploadTask task = new UploadTask(noteId, content == null ? "" : content, callback);
            if (protocolVersion >= NoteProtocol.PROTOCOL_VERSION) {
                task.startV2();
            } else {
                task.startLegacy();
            }
        });
    }

    public void deleteNote(String noteId, DeleteCallback callback) {
        if (noteId == null || noteId.isEmpty()) {
            callback.onError(noteId, "笔记 ID 为空");
            return;
        }
        if (!isConnected()) {
            callback.onError(noteId, "请先连接手环");
            return;
        }
        main.post(() -> {
            deleteCallbacks.put(noteId, callback);
            sendRaw(NoteProtocol.deleteNote(noteId));
            main.postDelayed(() -> {
                DeleteCallback pending = deleteCallbacks.remove(noteId);
                if (pending != null) {
                    pending.onError(noteId, "删除超时");
                }
            }, DELETE_TIMEOUT_MS);
        });
    }

    public void shutdown() {
        main.post(() -> {
            if (node != null) {
                try {
                    messageApi.removeListener(node.id);
                } catch (Exception e) {
                    Log.w(TAG, "remove message listener failed", e);
                }
                try {
                    nodeApi.unsubscribe(node.id, DataItem.ITEM_CONNECTION);
                } catch (Exception e) {
                    Log.w(TAG, "unsubscribe failed", e);
                }
            }
            failPending("应用退出");
            listeners.clear();
            ioExecutor.shutdown();
        });
    }

    // ===== 连接流程 =====

    private void doConnect() {
        if (connecting) {
            return;
        }
        if (state == State.CONNECTED) {
            return;
        }
        connecting = true;
        setState(State.CONNECTING, "正在查找手环");
        try {
            nodeApi.getConnectedNodes()
                    .addOnSuccessListener(nodes -> main.post(() -> {
                        connecting = false;
                        if (nodes == null || nodes.isEmpty()) {
                            failConnection("设备未连接");
                            return;
                        }
                        node = nodes.get(0);
                        currentNodeName = node.name;
                        checkPermissions();
                    }))
                    .addOnFailureListener(e -> main.post(() -> {
                        connecting = false;
                        failConnection("获取设备失败: " + safeMessage(e));
                    }));
        } catch (Exception e) {
            connecting = false;
            failConnection("获取设备异常: " + safeMessage(e));
        }
    }

    private void checkPermissions() {
        if (node == null) {
            failConnection("设备节点为空");
            return;
        }
        Permission[] permissions = new Permission[]{Permission.DEVICE_MANAGER};
        try {
            authApi.checkPermissions(node.id, permissions)
                    .addOnSuccessListener(results -> main.post(() -> {
                        if (results != null && results.length > 0 && results[0]) {
                            afterPermission();
                        } else {
                            requestPermission(permissions);
                        }
                    }))
                    .addOnFailureListener(e -> main.post(() ->
                            failConnection("权限查询失败: " + safeMessage(e))));
        } catch (Exception e) {
            failConnection("权限查询异常: " + safeMessage(e));
        }
    }

    private void requestPermission(Permission[] permissions) {
        if (node == null) {
            failConnection("设备节点为空");
            return;
        }
        try {
            authApi.requestPermission(node.id, permissions)
                    .addOnSuccessListener(granted -> main.post(this::afterPermission))
                    .addOnFailureListener(e -> main.post(() ->
                            failConnection("权限申请失败: " + safeMessage(e))));
        } catch (Exception e) {
            failConnection("权限申请异常: " + safeMessage(e));
        }
    }

    private void afterPermission() {
        if (node == null) {
            failConnection("设备节点为空");
            return;
        }
        try {
            nodeApi.isWearAppInstalled(node.id)
                    .addOnSuccessListener(installed -> main.post(() -> {
                        if (!Boolean.TRUE.equals(installed)) {
                            state = State.APP_NOT_INSTALLED;
                            stateDescription = "请在手环上安装笔记应用";
                            notifyConnectionChanged();
                            scheduleRetry();
                            return;
                        }
                        subscribeConnectionState();
                        registerMessageListener();
                    }))
                    .addOnFailureListener(e -> main.post(() ->
                            failConnection("检查手环应用失败: " + safeMessage(e))));
        } catch (Exception e) {
            failConnection("检查手环应用异常: " + safeMessage(e));
        }
    }

    private void subscribeConnectionState() {
        if (node == null) {
            return;
        }
        try {
            nodeApi.subscribe(node.id, DataItem.ITEM_CONNECTION, dataListener)
                    .addOnFailureListener(e -> Log.w(TAG, "subscribe connection failed", e));
        } catch (Exception e) {
            Log.w(TAG, "subscribe connection exception", e);
        }
    }

    private void registerMessageListener() {
        if (node == null) {
            failConnection("设备节点为空");
            return;
        }
        if (messageListenerRegistered) {
            startHandshake();
            return;
        }
        try {
            messageApi.addListener(node.id, messageListener)
                    .addOnSuccessListener(v -> main.post(() -> {
                        messageListenerRegistered = true;
                        startHandshake();
                    }))
                    .addOnFailureListener(e -> main.post(() ->
                            failConnection("注册消息监听失败: " + safeMessage(e))));
        } catch (Exception e) {
            failConnection("注册消息监听异常: " + safeMessage(e));
        }
    }

    private void startHandshake() {
        if (node == null) {
            return;
        }
        handshaken = false;
        setState(State.CONNECTING, "正在与手环握手");
        sendRaw(NoteProtocol.handshake(0));
        main.removeCallbacks(handshakeTimeoutRunnable);
        main.postDelayed(handshakeTimeoutRunnable, HANDSHAKE_TIMEOUT_MS);
    }

    private void failConnection(String message) {
        Log.w(TAG, "connection failed: " + message);
        connecting = false;
        handshaken = false;
        setState(State.FAILED, message);
        scheduleRetry();
    }

    private void scheduleRetry() {
        if (retryAttempts >= MAX_RETRY_ATTEMPTS) {
            return;
        }
        retryAttempts++;
        main.removeCallbacks(retryRunnable);
        main.postDelayed(retryRunnable, CONNECT_RETRY_DELAY_MS);
    }

    private void resetSession(boolean failTasks) {
        connecting = false;
        handshaken = false;
        messageListenerRegistered = false;
        node = null;
        currentNodeName = null;
        main.removeCallbacks(handshakeTimeoutRunnable);
        if (failTasks) {
            failPending("连接已断开");
        }
    }

    private void handleDataChanged(DataItem item, DataSubscribeResult data) {
        if (item == null || data == null) {
            return;
        }
        if (item.getType() == DataItem.ITEM_CONNECTION.getType()) {
            int status = data.getConnectedStatus();
            if (status == DataSubscribeResult.RESULT_CONNECTION_DISCONNECTED) {
                handshaken = false;
                messageListenerRegistered = false;
                setState(State.DISCONNECTED, "手环连接已断开");
                failPending("手环连接已断开");
                scheduleRetry();
            } else if (status == DataSubscribeResult.RESULT_CONNECTION_CONNECTED) {
                if (!handshaken) {
                    if (messageListenerRegistered) {
                        startHandshake();
                    } else {
                        doConnect();
                    }
                }
            }
        }
    }

    private void setState(State newState, String description) {
        main.post(() -> {
            state = newState;
            stateDescription = description == null ? "" : description;
            if (newState == State.CONNECTED) {
                retryAttempts = 0;
            }
            notifyConnectionChanged();
        });
    }

    private void notifyConnectionChanged() {
        for (ConnectionListener listener : listeners) {
            try {
                listener.onConnectionChanged(state, currentNodeName, stateDescription);
            } catch (Exception e) {
                Log.w(TAG, "connection listener failed", e);
            }
        }
    }

    // ===== 消息分发 =====

    private void handleRawMessage(String raw) {
        JSONObject json = NoteProtocol.parse(raw);
        if (json == null) {
            Log.w(TAG, "ignore malformed message: " + raw);
            return;
        }
        String type = json.optString("type", json.optString("tag", ""));
        if (HS_TAG.equals(type)) {
            handleHandshake(json);
            return;
        }
        if (json.has("protocol")) {
            protocolVersion = Math.max(1, json.optInt("protocol", protocolVersion));
        }
        if (!handshaken && (type.startsWith("note_") || NoteProtocol.TYPE_PREVIEW.equals(type)
                || NoteProtocol.TYPE_DELETE_SUCCESS.equals(type)
                || NoteProtocol.TYPE_UPDATE_SUCCESS.equals(type)
                || NoteProtocol.TYPE_CREATE_SUCCESS.equals(type)
                || NoteProtocol.TYPE_FULL_RESPONSE.equals(type))) {
            handshaken = true;
            main.removeCallbacks(handshakeTimeoutRunnable);
            setState(State.CONNECTED, null);
        }

        switch (type) {
            case NoteProtocol.TYPE_PREVIEW:
                handlePreviews(json);
                break;
            case NoteProtocol.TYPE_NOTE_META: {
                DownloadTask task = downloads.get(json.optString("requestId", ""));
                if (task != null) {
                    task.onMeta(json);
                }
                break;
            }
            case NoteProtocol.TYPE_NOTE_CHUNK: {
                DownloadTask task = downloads.get(json.optString("requestId", ""));
                if (task != null) {
                    task.onChunk(json);
                }
                break;
            }
            case NoteProtocol.TYPE_NOTE_NOT_FOUND: {
                String requestId = json.optString("requestId", "");
                DownloadTask task = downloads.get(requestId);
                if (task != null) {
                    task.fail("笔记不存在");
                    break;
                }
                String noteId = json.optString("noteId", "");
                DownloadTask legacy = legacyDownloads.get(noteId);
                if (legacy != null) {
                    legacy.fail("笔记不存在");
                }
                break;
            }
            case NoteProtocol.TYPE_NOTE_ERROR: {
                DownloadTask task = downloads.get(json.optString("requestId", ""));
                if (task != null) {
                    task.fail(json.optString("error", "读取失败"));
                }
                break;
            }
            case NoteProtocol.TYPE_FULL_RESPONSE: {
                String noteId = json.optString("noteId", "");
                DownloadTask task = legacyDownloads.get(noteId);
                if (task != null) {
                    task.onLegacy(json);
                }
                break;
            }
            case NoteProtocol.TYPE_WRITE_READY: {
                UploadTask task = uploads.get(json.optString("requestId", ""));
                if (task != null) {
                    task.onReady();
                }
                break;
            }
            case NoteProtocol.TYPE_WRITE_ACK: {
                UploadTask task = uploads.get(json.optString("requestId", ""));
                if (task != null) {
                    task.onAck(json);
                }
                break;
            }
            case NoteProtocol.TYPE_WRITE_SUCCESS: {
                UploadTask task = uploads.get(json.optString("requestId", ""));
                if (task != null) {
                    task.onWriteSuccess(json);
                }
                break;
            }
            case NoteProtocol.TYPE_WRITE_ERROR: {
                UploadTask task = uploads.get(json.optString("requestId", ""));
                if (task != null) {
                    task.fail(json.optString("error", "保存失败"));
                }
                break;
            }
            case NoteProtocol.TYPE_UPDATE_SUCCESS: {
                String noteId = json.optString("noteId", "");
                UploadTask task = findLegacyUpload(noteId, false);
                if (task != null) {
                    task.onLegacySuccess(noteId);
                }
                break;
            }
            case NoteProtocol.TYPE_CREATE_SUCCESS: {
                String noteId = json.optString("noteId", "");
                UploadTask task = findLegacyUpload(noteId, true);
                if (task != null) {
                    task.onLegacySuccess(noteId);
                }
                break;
            }
            case NoteProtocol.TYPE_UPDATE_ERROR: {
                UploadTask task = findLegacyUpload(json.optString("noteId", ""), false);
                if (task != null) {
                    task.fail(json.optString("error", "保存失败"));
                }
                break;
            }
            case NoteProtocol.TYPE_CREATE_ERROR: {
                UploadTask task = findLegacyUpload(json.optString("noteId", ""), true);
                if (task != null) {
                    task.fail(json.optString("error", "保存失败"));
                }
                break;
            }
            case NoteProtocol.TYPE_DELETE_SUCCESS: {
                String noteId = json.optString("noteId", "");
                DeleteCallback callback = deleteCallbacks.remove(noteId);
                ioExecutor.execute(() -> store.delete(noteId));
                if (callback != null) {
                    callback.onSuccess(noteId);
                }
                break;
            }
            case NoteProtocol.TYPE_DELETE_ERROR: {
                String noteId = json.optString("noteId", "");
                DeleteCallback callback = deleteCallbacks.remove(noteId);
                if (callback != null) {
                    callback.onError(noteId, json.optString("error", "删除失败"));
                }
                break;
            }
            case NoteProtocol.TYPE_REQUEST_FULL:
                handleRequestFullNote(json);
                break;
            case NoteProtocol.TYPE_UPDATE:
                handleRemoteUpdate(json);
                break;
            case NoteProtocol.TYPE_CREATE:
                handleRemoteCreate(json);
                break;
            case NoteProtocol.TYPE_DELETE:
                handleRemoteDelete(json);
                break;
            case NoteProtocol.TYPE_REQUEST_PREVIEW:
                sendLocalPreviews();
                break;
            default:
                Log.d(TAG, "unknown message type: " + type);
        }
    }

    private void handleHandshake(JSONObject json) {
        int count = json.optInt("count", 0);
        if (count <= 0) {
            return;
        }
        handshaken = true;
        connecting = false;
        main.removeCallbacks(handshakeTimeoutRunnable);
        setState(State.CONNECTED, null);
        if (count + 1 < 3) {
            sendRaw(NoteProtocol.handshake(count + 1));
        }
        requestPreviewsNow();
    }

    private void handlePreviews(JSONObject json) {
        protocolVersion = Math.max(1, json.optInt("protocol", 1));
        JSONArray array = json.optJSONArray("previews");
        List<NotePreview> result = new ArrayList<>();
        if (array != null) {
            for (int i = 0; i < array.length(); i++) {
                JSONObject item = array.optJSONObject(i);
                if (item == null) {
                    continue;
                }
                String id = item.optString("id", "");
                if (id.isEmpty()) {
                    continue;
                }
                result.add(new NotePreview(
                        id,
                        item.optString("preview", ""),
                        item.optLong("createTime", 0),
                        item.optLong("modifyTime", 0)
                ));
            }
        }
        Collections.sort(result, (a, b) -> {
            long ta = a.modifyTime > 0 ? a.modifyTime : a.createTime;
            long tb = b.modifyTime > 0 ? b.modifyTime : b.createTime;
            if (ta != tb) {
                return Long.compare(tb, ta);
            }
            return b.id.compareTo(a.id);
        });
        for (ConnectionListener listener : listeners) {
            try {
                listener.onPreviews(result);
            } catch (Exception e) {
                Log.w(TAG, "preview listener failed", e);
            }
        }
    }

    private void requestPreviewsNow() {
        if (node == null) {
            return;
        }
        sendRaw(NoteProtocol.requestPreviews());
    }

    // ===== 手环反向请求（旧协议兼容 + 本地镜像） =====

    private void handleRequestFullNote(JSONObject json) {
        String noteId = json.optString("noteId", "");
        ioExecutor.execute(() -> {
            String content = store.read(noteId);
            if (content == null) {
                sendRaw(NoteProtocol.noteNotFound(noteId));
            } else {
                sendRaw(NoteProtocol.fullNoteResponse(noteId, content));
            }
        });
    }

    private void handleRemoteUpdate(JSONObject json) {
        String noteId = json.optString("noteId", "");
        String content = json.optString("content", "");
        ioExecutor.execute(() -> {
            store.save(noteId, content, null, System.currentTimeMillis());
            sendRaw(NoteProtocol.updateSuccess(noteId));
        });
    }

    private void handleRemoteCreate(JSONObject json) {
        String noteId = String.valueOf(System.currentTimeMillis());
        String content = json.optString("content", "");
        ioExecutor.execute(() -> {
            store.save(noteId, content, null, System.currentTimeMillis());
            sendRaw(NoteProtocol.createSuccess(noteId));
        });
    }

    private void handleRemoteDelete(JSONObject json) {
        String noteId = json.optString("noteId", "");
        ioExecutor.execute(() -> {
            store.delete(noteId);
            sendRaw(NoteProtocol.deleteSuccess(noteId));
        });
    }

    private void sendLocalPreviews() {
        ioExecutor.execute(() -> {
            List<NotePreview> local = store.list();
            JSONObject response = new JSONObject();
            JSONArray previews = new JSONArray();
            try {
                response.put("type", NoteProtocol.TYPE_PREVIEW);
                response.put("protocol", NoteProtocol.PROTOCOL_VERSION);
                for (NotePreview note : local) {
                    JSONObject item = new JSONObject();
                    item.put("id", note.id);
                    item.put("preview", note.preview);
                    item.put("createTime", note.createTime);
                    item.put("modifyTime", note.modifyTime);
                    previews.put(item);
                }
                response.put("previews", previews);
                sendRaw(response.toString());
            } catch (Exception e) {
                Log.w(TAG, "send local previews failed", e);
            }
        });
    }

    // ===== 发送 =====

    private boolean sendRaw(String json) {
        if (node == null) {
            return false;
        }
        try {
            messageApi.sendMessage(node.id, json.getBytes(StandardCharsets.UTF_8))
                    .addOnSuccessListener(v -> {
                    })
                    .addOnFailureListener(e -> Log.w(TAG, "send failed: " + safeMessage(e)));
            return true;
        } catch (Exception e) {
            Log.w(TAG, "send exception", e);
            return false;
        }
    }

    private String nextRequestId(String prefix) {
        return prefix + "_" + System.currentTimeMillis() + "_" + requestSeq.incrementAndGet();
    }

    private void failPending(String reason) {
        for (DownloadTask task : new ArrayList<>(downloads.values())) {
            task.fail(reason);
        }
        for (DownloadTask task : new ArrayList<>(legacyDownloads.values())) {
            task.fail(reason);
        }
        for (UploadTask task : uploads.values()) {
            task.fail(reason);
        }
        for (UploadTask task : legacyUploads) {
            task.fail(reason);
        }
        for (Map.Entry<String, DeleteCallback> entry : deleteCallbacks.entrySet()) {
            DeleteCallback callback = entry.getValue();
            if (callback != null) {
                callback.onError(entry.getKey(), reason);
            }
        }
        deleteCallbacks.clear();
    }

    private UploadTask findLegacyUpload(String noteId, boolean create) {
        for (UploadTask task : legacyUploads) {
            if (create) {
                if (task.noteId == null) {
                    return task;
                }
            } else if (noteId != null && noteId.equals(task.noteId)) {
                return task;
            }
        }
        return null;
    }

    private static String safeMessage(Throwable throwable) {
        if (throwable == null) {
            return "未知错误";
        }
        String message = throwable.getMessage();
        return message == null || message.isEmpty() ? throwable.getClass().getSimpleName() : message;
    }

    // ===== 下载：按字符区间读取，手环内部映射为文本段 =====

    private final class DownloadTask {
        final String requestId;
        final String noteId;
        final DownloadCallback callback;
        final StringBuilder content = new StringBuilder();
        final Runnable timeout = () -> fail("读取超时");

        int charCount = -1;
        int segmentCount;
        int offset;
        boolean finished;
        boolean legacy;

        DownloadTask(String noteId, DownloadCallback callback) {
            this.requestId = nextRequestId("dl");
            this.noteId = noteId;
            this.callback = callback;
        }

        void startV2() {
            downloads.put(requestId, this);
            sendRaw(NoteProtocol.noteOpen(requestId, noteId));
            schedule(DOWNLOAD_META_TIMEOUT_MS);
        }

        void startLegacy() {
            legacy = true;
            legacyDownloads.put(noteId, this);
            sendRaw(NoteProtocol.requestFullNote(noteId));
            schedule(LEGACY_TIMEOUT_MS);
        }

        void onMeta(JSONObject json) {
            if (finished) {
                return;
            }
            charCount = json.optInt("charCount", -1);
            segmentCount = json.optInt("segmentCount", 0);
            if (charCount <= 0) {
                finish("");
                return;
            }
            requestNext();
        }

        void onChunk(JSONObject json) {
            if (finished) {
                return;
            }
            String text = json.optString("text", "");
            boolean done = json.optBoolean("done", false);
            if (text.isEmpty() && !done) {
                fail("手环返回了空分段");
                return;
            }
            content.append(text);
            offset += text.length();
            if (charCount > 0) {
                callback.onProgress(Math.min(100, offset * 100 / charCount));
            }
            if (done || (charCount >= 0 && offset >= charCount)) {
                finish(content.toString());
            } else {
                requestNext();
            }
        }

        void onLegacy(JSONObject json) {
            if (finished) {
                return;
            }
            charCount = json.optInt("charCount", -1);
            finish(json.optString("content", ""));
        }

        private void requestNext() {
            sendRaw(NoteProtocol.noteRead(requestId, noteId, offset, READ_CHUNK_CHARS));
            schedule(DOWNLOAD_CHUNK_TIMEOUT_MS);
        }

        private void schedule(long delayMs) {
            main.removeCallbacks(timeout);
            main.postDelayed(timeout, delayMs);
        }

        private void finish(String text) {
            if (finished) {
                return;
            }
            finished = true;
            main.removeCallbacks(timeout);
            downloads.remove(requestId);
            legacyDownloads.remove(noteId, this);
            if (!legacy) {
                sendRaw(NoteProtocol.noteClose(requestId));
            }
            String safe = text == null ? "" : text;
            if (!safe.isEmpty()) {
                ioExecutor.execute(() -> store.save(noteId, safe, null, System.currentTimeMillis()));
            }
            callback.onSuccess(noteId, safe, safe.length(), segmentCount);
        }

        void fail(String message) {
            if (finished) {
                return;
            }
            finished = true;
            main.removeCallbacks(timeout);
            downloads.remove(requestId);
            legacyDownloads.remove(noteId, this);
            if (!legacy) {
                sendRaw(NoteProtocol.noteClose(requestId));
            }
            callback.onError(message);
        }
    }

    // ===== 上传：UTF-8 安全分片 + 逐片 ACK，手环导入为分段笔记 =====

    private final class UploadTask {
        final String requestId;
        String noteId;
        final String content;
        final UploadCallback callback;
        final Runnable timeout = this::onTimeout;

        List<String> chunks = Collections.emptyList();
        int index;
        int retries;
        int totalBytes;
        boolean finished;
        boolean legacy;
        boolean waitingAck;
        boolean waitingCommit;

        UploadTask(String noteId, String content, UploadCallback callback) {
            this.requestId = nextRequestId("up");
            this.noteId = noteId;
            this.content = content;
            this.callback = callback;
        }

        void startV2() {
            chunks = Utf8Chunks.split(content, WRITE_CHUNK_BYTES);
            totalBytes = Utf8Chunks.length(content);
            uploads.put(requestId, this);
            sendRaw(NoteProtocol.writeBegin(requestId, noteId, totalBytes, content.length()));
            schedule(UPLOAD_BEGIN_TIMEOUT_MS);
        }

        void startLegacy() {
            legacy = true;
            legacyUploads.add(this);
            waitingCommit = true;
            if (noteId == null) {
                sendRaw(NoteProtocol.legacyCreateNote(content));
            } else {
                sendRaw(NoteProtocol.legacyUpdateNote(noteId, content));
            }
            schedule(LEGACY_TIMEOUT_MS);
        }

        void onReady() {
            if (finished) {
                return;
            }
            sendCurrentChunk();
        }

        void onAck(JSONObject json) {
            if (finished) {
                return;
            }
            int seq = json.optInt("seq", -1);
            if (seq != index) {
                return;
            }
            index++;
            retries = 0;
            if (chunks.isEmpty()) {
                progress(100);
            } else {
                progress(Math.min(99, index * 100 / chunks.size()));
            }
            sendCurrentChunk();
        }

        void onWriteSuccess(JSONObject json) {
            String id = json.optString("noteId", noteId);
            boolean created = json.optBoolean("created", noteId == null);
            finish(id, created);
        }

        void onLegacySuccess(String id) {
            boolean created = noteId == null;
            noteId = id;
            finish(id, created);
        }

        private void sendCurrentChunk() {
            if (finished) {
                return;
            }
            if (index >= chunks.size()) {
                waitingAck = false;
                waitingCommit = true;
                sendRaw(NoteProtocol.writeCommit(requestId));
                schedule(UPLOAD_COMMIT_TIMEOUT_MS);
                return;
            }
            waitingAck = true;
            waitingCommit = false;
            sendRaw(NoteProtocol.writeChunk(requestId, index, chunks.get(index)));
            schedule(UPLOAD_ACK_TIMEOUT_MS);
        }

        private void onTimeout() {
            if (finished) {
                return;
            }
            if (waitingAck && retries < 2 && index < chunks.size()) {
                retries++;
                // 手环按 seq 去重：重复发送同一片不会重复追加。
                sendRaw(NoteProtocol.writeChunk(requestId, index, chunks.get(index)));
                schedule(UPLOAD_ACK_TIMEOUT_MS);
                return;
            }
            fail(waitingCommit ? "保存超时" : "同步超时");
        }

        private void progress(int percent) {
            callback.onProgress(Math.max(0, Math.min(100, percent)));
        }

        private void finish(String id, boolean created) {
            if (finished) {
                return;
            }
            finished = true;
            main.removeCallbacks(timeout);
            uploads.remove(requestId);
            legacyUploads.remove(this);
            noteId = id;
            if (id != null && !id.isEmpty()) {
                String finalContent = content;
                ioExecutor.execute(() -> store.save(id, finalContent, null, System.currentTimeMillis()));
            }
            callback.onSuccess(id, created);
        }

        void fail(String message) {
            if (finished) {
                return;
            }
            finished = true;
            main.removeCallbacks(timeout);
            uploads.remove(requestId);
            legacyUploads.remove(this);
            if (!legacy) {
                sendRaw(NoteProtocol.writeAbort(requestId));
            }
            callback.onError(message);
        }

        private void schedule(long delayMs) {
            main.removeCallbacks(timeout);
            main.postDelayed(timeout, delayMs);
        }
    }

    // ===== UTF-8 工具已抽到 Utf8Chunks，便于独立测试 =====
}
