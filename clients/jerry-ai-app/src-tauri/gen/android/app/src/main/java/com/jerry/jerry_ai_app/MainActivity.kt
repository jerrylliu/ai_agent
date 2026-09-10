package com.jerry.jerry_ai_app

import android.os.Bundle
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    // 启用 edge-to-edge（沉浸式）：应用背景延伸到系统状态栏/导航栏底下，系统栏呈透明——
    // 与 Android 15+（targetSdk 35+）的强制行为保持一致，旧系统上也统一观感。
    // 内容不被遮挡的避让由 Web 层 env(safe-area-inset-*) 完成（侧边栏/模型面板/全屏弹窗均已加）。
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }
}
