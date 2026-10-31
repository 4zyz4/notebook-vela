package com.zyz4.notebook;

import android.app.Application;

/** 应用入口：持有跨页面共享的手环连接。 */
public final class App extends Application {
    private NoteLink noteLink;

    @Override
    public void onCreate() {
        super.onCreate();
        noteLink = new NoteLink(this);
    }

    public NoteLink getNoteLink() {
        return noteLink;
    }

    @Override
    public void onTerminate() {
        if (noteLink != null) {
            noteLink.shutdown();
        }
        super.onTerminate();
    }
}
