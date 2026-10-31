package com.zyz4.notebook;

import android.content.Intent;
import android.os.Bundle;
import android.text.Editable;
import android.text.TextUtils;
import android.text.TextWatcher;
import android.view.Menu;
import android.view.MenuItem;
import android.widget.EditText;
import android.widget.TextView;
import android.widget.Toast;

import androidx.annotation.NonNull;
import androidx.appcompat.app.AlertDialog;
import androidx.appcompat.app.AppCompatActivity;
import androidx.appcompat.widget.Toolbar;
import androidx.core.view.WindowCompat;

import java.util.Locale;

/** 笔记编辑页：保存时按 UTF-8 安全分片上传到手环。 */
public final class NoteEditActivity extends AppCompatActivity {

    public static final String EXTRA_NOTE_ID = "note_id";
    public static final String EXTRA_NOTE_CONTENT = "note_content";
    public static final String EXTRA_CHAR_COUNT = "note_chars";
    public static final String EXTRA_SEGMENT_COUNT = "note_segments";

    private NoteLink link;
    private Toolbar toolbar;
    private EditText editText;
    private TextView segmentInfo;

    private String noteId;
    private String initialContent = "";
    private boolean saving;
    private boolean saved;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        setContentView(R.layout.activity_note_edit);

        WindowInsetsUtils.applySystemBarPadding(findViewById(R.id.rootLayout), true);

        toolbar = findViewById(R.id.toolbar);
        setSupportActionBar(toolbar);
        if (getSupportActionBar() != null) {
            getSupportActionBar().setDisplayHomeAsUpEnabled(true);
        }

        editText = findViewById(R.id.noteEditText);
        segmentInfo = findViewById(R.id.segmentInfo);
        link = ((App) getApplication()).getNoteLink();

        Intent intent = getIntent();
        noteId = intent.getStringExtra(EXTRA_NOTE_ID);
        String content = intent.getStringExtra(EXTRA_NOTE_CONTENT);
        initialContent = content == null ? "" : content;
        editText.setText(initialContent);
        editText.setSelection(initialContent.length());
        editText.addTextChangedListener(new TextWatcher() {
            @Override
            public void beforeTextChanged(CharSequence s, int start, int count, int after) {
            }

            @Override
            public void onTextChanged(CharSequence s, int start, int before, int count) {
            }

            @Override
            public void afterTextChanged(Editable s) {
                saved = false;
                updateSegmentInfo();
            }
        });
        if (noteId == null || noteId.isEmpty()) {
            toolbar.setTitle(R.string.new_note_title);
        } else {
            toolbar.setTitle(R.string.edit_note_title);
        }
        updateSegmentInfo();
    }

    @Override
    public boolean onCreateOptionsMenu(Menu menu) {
        getMenuInflater().inflate(R.menu.menu_note_edit, menu);
        return true;
    }

    @Override
    public boolean onOptionsItemSelected(@NonNull MenuItem item) {
        int id = item.getItemId();
        if (id == android.R.id.home) {
            if (!confirmDiscard()) {
                finish();
            }
            return true;
        }
        if (id == R.id.action_save) {
            save();
            return true;
        }
        return super.onOptionsItemSelected(item);
    }

    @Override
    public void onBackPressed() {
        if (confirmDiscard()) {
            return;
        }
        super.onBackPressed();
    }

    private void save() {
        if (saving) {
            return;
        }
        String content = editText.getText().toString();
        if (TextUtils.isEmpty(content.trim())) {
            Toast.makeText(this, R.string.content_empty, Toast.LENGTH_SHORT).show();
            return;
        }
        if (!link.isConnected()) {
            Toast.makeText(this, R.string.connection_required, Toast.LENGTH_SHORT).show();
            return;
        }
        saving = true;
        toolbar.setSubtitle(getString(R.string.sync_progress, 0));
        link.uploadNote(noteId, content, new NoteLink.UploadCallback() {            @Override
            public void onProgress(int percent) {
                runOnUiThread(() -> toolbar.setSubtitle(getString(R.string.sync_progress, percent)));
            }

            @Override
            public void onSuccess(String id, boolean created) {
                runOnUiThread(() -> {
                    saving = false;
                    saved = true;
                    noteId = id;
                    toolbar.setSubtitle(null);
                    Toast.makeText(NoteEditActivity.this, R.string.save_success,
                            Toast.LENGTH_SHORT).show();
                    setResult(RESULT_OK);
                    finish();
                });
            }

            @Override
            public void onError(String message) {
                runOnUiThread(() -> {
                    saving = false;
                    toolbar.setSubtitle(null);
                    Toast.makeText(NoteEditActivity.this,
                            getString(TextUtils.isEmpty(noteId)
                                    ? R.string.note_create_failed
                                    : R.string.note_update_failed, message),
                            Toast.LENGTH_LONG).show();
                });
            }
        });
    }

    /**
     * 返回前确认。返回 true 表示已经处理（弹窗或已关闭），false 表示可以直接返回。
     */
    private boolean confirmDiscard() {
        if (saving) {
            Toast.makeText(this, R.string.saving_wait, Toast.LENGTH_SHORT).show();
            return true;
        }
        String current = editText.getText().toString();
        if (saved || current.equals(initialContent)) {
            return false;
        }
        new AlertDialog.Builder(this)
                .setTitle(R.string.unsaved_title)
                .setMessage(R.string.unsaved_message)
                .setNegativeButton(R.string.stay, null)
                .setPositiveButton(R.string.leave, (dialog, which) -> finish())
                .show();
        return true;
    }

    private void updateSegmentInfo() {
        int chars = editText.getText() == null ? 0 : editText.getText().length();
        segmentInfo.setText(String.format(Locale.getDefault(),
                getString(R.string.segment_info), chars));
    }
}
