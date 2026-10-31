package com.zyz4.notebook;

import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.widget.ImageButton;
import android.widget.TextView;

import androidx.annotation.NonNull;
import androidx.recyclerview.widget.RecyclerView;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;

/** 首页笔记列表适配器。 */
public final class NoteAdapter extends RecyclerView.Adapter<NoteAdapter.Holder> {

    public interface Listener {
        void onOpen(NotePreview note);
        void onDelete(NotePreview note);
    }

    private final List<NotePreview> notes = new ArrayList<>();
    private final Listener listener;
    private final SimpleDateFormat timeFormat =
            new SimpleDateFormat("yy.MM.dd HH:mm", Locale.getDefault());

    public NoteAdapter(Listener listener) {
        this.listener = listener;
    }

    public void submit(List<NotePreview> data) {
        notes.clear();
        if (data != null) {
            notes.addAll(data);
        }
        notifyDataSetChanged();
    }

    public int size() {
        return notes.size();
    }

    @NonNull
    @Override
    public Holder onCreateViewHolder(@NonNull ViewGroup parent, int viewType) {
        View view = LayoutInflater.from(parent.getContext())
                .inflate(R.layout.item_note, parent, false);
        return new Holder(view);
    }

    @Override
    public void onBindViewHolder(@NonNull Holder holder, int position) {
        NotePreview note = notes.get(position);
        String preview = note.preview;
        if (preview.length() > 32) {
            preview = preview.substring(0, 32) + "...";
        }
        holder.content.setText(preview);
        holder.time.setText(formatTime(note));
        holder.itemView.setOnClickListener(v -> listener.onOpen(note));
        holder.delete.setOnClickListener(v -> listener.onDelete(note));
    }

    @Override
    public int getItemCount() {
        return notes.size();
    }

    private String formatTime(NotePreview note) {
        long time = note.modifyTime > 0 ? note.modifyTime : note.createTime;
        if (time <= 0) {
            return "";
        }
        return timeFormat.format(new Date(time));
    }

    static final class Holder extends RecyclerView.ViewHolder {
        final TextView content;
        final TextView time;
        final ImageButton delete;

        Holder(@NonNull View itemView) {
            super(itemView);
            content = itemView.findViewById(R.id.noteContent);
            time = itemView.findViewById(R.id.noteTime);
            delete = itemView.findViewById(R.id.deleteButton);
        }
    }
}
