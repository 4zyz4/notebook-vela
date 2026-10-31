package com.zyz4.notebook;

import android.view.View;

import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

/**
 * 处理刘海/挖孔/状态栏/导航栏安全区。
 *
 * <p>targetSdk 35 默认启用 edge-to-edge，窗口会绘制到系统栏和异形区域下面。
 * 这里统一把 systemBars + displayCutout 的 inset 变成根布局 padding，
 * 避免标题、连接卡片和编辑框进入刘海或挖孔区域。</p>
 */
public final class WindowInsetsUtils {
    private WindowInsetsUtils() {
    }

    public static void applySystemBarPadding(View root, boolean includeIme) {
        if (root == null) {
            return;
        }
        ViewCompat.setOnApplyWindowInsetsListener(root, (view, windowInsets) -> {
            Insets bars = windowInsets.getInsets(
                    WindowInsetsCompat.Type.systemBars()
                            | WindowInsetsCompat.Type.displayCutout());
            int bottom = bars.bottom;
            if (includeIme) {
                Insets ime = windowInsets.getInsets(WindowInsetsCompat.Type.ime());
                bottom = Math.max(bottom, ime.bottom);
            }
            view.setPadding(bars.left, bars.top, bars.right, bottom);
            return windowInsets;
        });
        ViewCompat.requestApplyInsets(root);
    }
}
