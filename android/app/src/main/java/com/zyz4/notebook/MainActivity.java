package com.zyz4.notebook;

import android.content.Intent;
import android.os.Bundle;
import android.view.Menu;
import android.view.MenuItem;
import android.view.View;
import android.widget.ImageView;
import android.widget.TextView;
import android.widget.Toast;

import androidx.annotation.NonNull;
import androidx.appcompat.app.AlertDialog;
import androidx.appcompat.app.AppCompatActivity;
import androidx.appcompat.widget.Toolbar;
import androidx.core.view.WindowCompat;
import androidx.recyclerview.widget.LinearLayoutManager;
import androidx.recyclerview.widget.RecyclerView;

import com.google.android.material.card.MaterialCardView;
import com.google.android.material.floatingactionbutton.FloatingActionButton;

import java.util.List;

/** 首页：显示手环连接状态与笔记预览列表。 */
public final class MainActivity extends AppCompatActivity
        implements NoteLink.ConnectionListener, NoteAdapter.Listener {

    private NoteLink link;
    private NoteAdapter adapter;

    private MaterialCardView deviceCard;
    private ImageView connectionIcon;
    private TextView connectionStatus;
    private TextView connectionDesc;
    private RecyclerView notesRecyclerView;
    private TextView emptyView;
    private View loadingOverlay;
    private TextView loadingText;

    private NotePreview pendingDelete;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        setContentView(R.layout.activity_main);

        WindowInsetsUtils.applySystemBarPadding(findViewById(R.id.coordinatorLayout), false);

        Toolbar toolbar = findViewById(R.id.toolbar);
        setSupportActionBar(toolbar);

        deviceCard = findViewById(R.id.deviceCard);
        connectionIcon = findViewById(R.id.connectionIcon);
        connectionStatus = findViewById(R.id.connectionStatus);
        connectionDesc = findViewById(R.id.connectionDesc);
        notesRecyclerView = findViewById(R.id.notesRecyclerView);
        emptyView = findViewById(R.id.emptyView);
        loadingOverlay = findViewById(R.id.loadingOverlay);
        loadingText = findViewById(R.id.loadingText);

        adapter = new NoteAdapter(this);
        notesRecyclerView.setLayoutManager(new LinearLayoutManager(this));
        notesRecyclerView.setAdapter(adapter);

        link = ((App) getApplication()).getNoteLink();

        deviceCard.setOnClickListener(v -> {
            if (link.getState() != NoteLink.State.CONNECTED) {
                link.retry();
            } else {
                link.requestPreviews();
            }
        });

        FloatingActionButton fab = findViewById(R.id.fab);
        fab.setOnClickListener(v -> {
            if (link.getState() != NoteLink.State.CONNECTED) {
                Toast.makeText(this, R.string.connection_required, Toast.LENGTH_SHORT).show();
                return;
            }
            startActivity(new Intent(this, NoteEditActivity.class));
        });

        updateEmptyState();
    }

    @Override
    protected void onResume() {
        super.onResume();
        link.addListener(this);
        link.refresh();
        updateEmptyState();
    }

    @Override
    protected void onPause() {
        link.removeListener(this);
        super.onPause();
    }

    @Override
    public boolean onCreateOptionsMenu(Menu menu) {
        getMenuInflater().inflate(R.menu.menu_main, menu);
        return true;
    }

    @Override
    public boolean onOptionsItemSelected(@NonNull MenuItem item) {
        if (item.getItemId() == R.id.action_refresh) {
            if (link.isConnected()) {
                link.requestPreviews();
            } else {
                link.retry();
            }
            return true;
        }
        return super.onOptionsItemSelected(item);
    }

    @Override
    public void onConnectionChanged(NoteLink.State state, String nodeName, String description) {
        runOnUiThread(() -> {
            switch (state) {
                case CONNECTED:
                    connectionIcon.setImageResource(R.drawable.conn_true);
                    connectionStatus.setText(R.string.connected);
                    connectionDesc.setText(getString(R.string.connected_desc,
                            nodeName == null ? "手环" : nodeName));
                    break;
                case APP_NOT_INSTALLED:
                    connectionIcon.setImageResource(R.drawable.conn_question);
                    connectionStatus.setText(R.string.app_not_installed);
                    connectionDesc.setText(R.string.app_not_installed_desc);
                    break;
                case FAILED:
                    connectionIcon.setImageResource(R.drawable.conn_false);
                    connectionStatus.setText(R.string.connect_failed);
                    connectionDesc.setText(description == null || description.isEmpty()
                            ? getString(R.string.connecting_desc) : description);
                    break;
                case DISCONNECTED:
                    connectionIcon.setImageResource(R.drawable.conn_false);
                    connectionStatus.setText(R.string.disconnected);
                    connectionDesc.setText(description == null ? "" : description);
                    break;
                case CONNECTING:
                default:
                    connectionIcon.setImageResource(R.drawable.conn_false);
                    connectionStatus.setText(R.string.connecting);
                    connectionDesc.setText(description == null || description.isEmpty()
                            ? getString(R.string.connecting_desc) : description);
                    break;
            }
        });
    }

    @Override
    public void onPreviews(List<NotePreview> previews) {
        runOnUiThread(() -> {
            adapter.submit(previews);
            updateEmptyState();
        });
    }

    @Override
    public void onOpen(NotePreview note) {
        showLoading(true, getString(R.string.loading_note));
        link.downloadNote(note.id, new NoteLink.DownloadCallback() {
            @Override
            public void onProgress(int percent) {
                runOnUiThread(() -> loadingText.setText(
                        getString(R.string.loading_note) + " " + percent + "%"));
            }

            @Override
            public void onSuccess(String noteId, String content, int charCount, int segmentCount) {
                runOnUiThread(() -> {
                    showLoading(false, null);
                    Intent intent = new Intent(MainActivity.this, NoteEditActivity.class);
                    intent.putExtra(NoteEditActivity.EXTRA_NOTE_ID, noteId);
                    intent.putExtra(NoteEditActivity.EXTRA_NOTE_CONTENT, content);
                    intent.putExtra(NoteEditActivity.EXTRA_CHAR_COUNT, charCount);
                    intent.putExtra(NoteEditActivity.EXTRA_SEGMENT_COUNT, segmentCount);
                    startActivity(intent);
                });
            }

            @Override
            public void onError(String message) {
                runOnUiThread(() -> {
                    showLoading(false, null);
                    Toast.makeText(MainActivity.this,
                            getString(R.string.read_failed) + ": " + message,
                            Toast.LENGTH_LONG).show();
                });
            }
        });
    }

    @Override
    public void onDelete(NotePreview note) {
        pendingDelete = note;
        new AlertDialog.Builder(this)
                .setTitle(R.string.delete_note_title)
                .setMessage(R.string.delete_note_message)
                .setNegativeButton(R.string.cancel, null)
                .setPositiveButton(R.string.delete, (dialog, which) -> delete(pendingDelete))
                .show();
    }

    private void delete(NotePreview note) {
        if (note == null) {
            return;
        }
        Toast.makeText(this, R.string.delete_request_sent, Toast.LENGTH_SHORT).show();
        link.deleteNote(note.id, new NoteLink.DeleteCallback() {
            @Override
            public void onSuccess(String noteId) {
                runOnUiThread(() -> {
                    Toast.makeText(MainActivity.this, R.string.note_deleted, Toast.LENGTH_SHORT).show();
                    link.requestPreviews();
                });
            }

            @Override
            public void onError(String noteId, String message) {
                runOnUiThread(() -> Toast.makeText(MainActivity.this,
                        getString(R.string.note_delete_failed, message),
                        Toast.LENGTH_LONG).show());
            }
        });
    }

    private void showLoading(boolean show, String text) {
        loadingOverlay.setVisibility(show ? View.VISIBLE : View.GONE);
        if (text != null) {
            loadingText.setText(text);
        }
    }

    private void updateEmptyState() {
        boolean empty = adapter.size() == 0;
        emptyView.setVisibility(empty ? View.VISIBLE : View.GONE);
        notesRecyclerView.setVisibility(empty ? View.GONE : View.VISIBLE);
    }
}
